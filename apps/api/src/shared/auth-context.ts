import { Elysia } from 'elysia';
import { findSessionByToken, sessionTokenFromHeaders, verifyApiKey, type AuthUser } from '@repo/auth';
import { HttpError } from './lib';

// GET routes that need no session. The raw attachment and avatar bytes routes
// must work in <img>/<video> and external fetches. The invite lookup
// (`GET /invites/:token`) renders the accept screen for a logged-out invitee, who
// signs up from there; only accept/reject (POST) require a session. Every `/share/`
// GET renders a public read-only shared issue or view, keyed by an unguessable
// token. All ids are unguessable.
const PUBLIC_GET =
  /^\/attachments\/[^/]+\/raw$|^\/chat-attachments\/[^/]+\/raw$|^\/avatars\/[^/]+\/raw$|^\/invites\/[^/]+$|^\/share\//;

// The authenticated user carried on the request context.
export type SessionUser = AuthUser;

// Session plugin shared by the planner. Resolves the session once and
// puts `user` on the context, so handlers and the access guards read it instead
// of calling getSession again. A missing session is a 401, except on the public
// raw-attachment route, which carries no user.
//
// planner.ts uses this as the runtime backstop, so every planner route is
// session-gated. A feature also uses it directly when its handlers or local
// macros reference `user`, which is what makes the `user` type flow there. The
// plugin is named, so its resolve runs once per request (dedup).
//
// A deactivated account is refused here rather than at sign-in: deactivation
// arrives over SCIM while sessions and API keys are already open, and this is the
// one place every planner route and the MCP surface pass through.
// `x-api-key: <key>` or `Authorization: Bearer <key>`. The bearer form is the
// convention MCP clients follow; the header form is the REST one.
function apiKeyFrom(headers: Headers): string | null {
  const header = headers.get('x-api-key');
  if (header) return header.trim();
  const authorization = headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();
  return null;
}

export const authContext = new Elysia({ name: 'auth-context' }).resolve(
  { as: 'scoped' },
  async ({ request, path }): Promise<{ user: SessionUser | null }> => {
    // The session cookie. A session that has not passed MFA yet is not found
    // here (see sessions.ts), so a half-signed-in browser is a stranger to every
    // planner route.
    const own = await findSessionByToken(sessionTokenFromHeaders(request.headers));
    if (own) {
      if (own.user.active === false) throw new HttpError(401, 'This account is deactivated');
      return { user: own.user };
    }

    // An API key: how an agent, a runner or a script authenticates. Accepted as
    // `x-api-key` or as a bearer token, which is what the MCP surface sends.
    //
    // Terminal on purpose: a request that presents a key and gets it wrong is
    // refused here rather than falling through to the cookie. Trying the next
    // credential would let a caller probe keys while quietly staying signed in as
    // somebody else.
    const presentedKey = apiKeyFrom(request.headers);
    if (presentedKey) {
      const principal = await verifyApiKey(presentedKey);
      if (!principal) throw new HttpError(401, 'Invalid API key');
      return { user: principal.user };
    }

    // The public raw-attachment route has no session and needs none.
    if (request.method === 'GET' && PUBLIC_GET.test(path)) return { user: null };
    throw new HttpError(401, 'Authentication required');
  },
);

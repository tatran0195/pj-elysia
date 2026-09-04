import { Elysia, t } from 'elysia';
import {
  OAuthError,
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  consumeAuthToken,
  consumeOAuthState,
  createUser,
  deletePasskey,
  exchangeCode,
  findAccountByProvider,
  findCredentialByIdentifier,
  findSessionByToken,
  findUserByEmail,
  findUserById,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  getAuthSettings,
  hasConfiguredEmailProvider,
  hasPendingInvite,
  instanceHasNoUsers,
  isOAuthProviderId,
  issueAuthToken,
  listLinkedAccounts,
  listPasskeys,
  magicLinkLimiter,
  markEmailVerified,
  originAllowed,
  rateLimitKey,
  recordActivity,
  resolveProvider,
  retryAfterSeconds,
  sendAuthEmail,
  sessionTokenFromHeaders,
  signInVerifiedUser,
  startOAuthFlow,
  trustedOrigins,
  unlinkAccount,
  upsertAccount,
  verifyIdentity,
  CREDENTIAL_PROVIDER_ID,
  OIDC_PROVIDER_ID,
  type AuthUser,
  type ExternalSignInResult,
  type OAuthProviderId,
} from '@repo/auth';
import { HttpError } from '#shared/lib';
import { syncOidcGroups } from '../scim/oidc-sync';
import {
  PublicUser,
  appUrl,
  publicUser,
  refuse,
  requestContext,
  requireSession,
  requireStepUp,
  setSessionCookie,
} from './index';

// The sign-in methods that are not a password: emailed links, OAuth/OIDC and
// passkeys, plus the list of providers linked to an account. Same conventions as
// ./index — session cookie only, Origin-checked, enumeration-safe answers.

// A magic link, a Google sign-in and an OIDC sign-in can all create an account
// for an address the instance has never seen. That goes through the same gate
// as the sign-up form: registration mode and, on an invite-only instance, a
// pending invite for the address.
async function registrationRefusal(email: string): Promise<string | null> {
  const settings = await getAuthSettings();
  if (settings.registration === 'closed') return 'REGISTRATION_CLOSED';
  if (settings.registration === 'invite' && !(await hasPendingInvite(email))) return 'INVITE_ONLY';
  return null;
}

// Where the browser may be sent after a redirect-based flow: a path on the app,
// or a URL on one of its origins. Anything else collapses to "/".
function safeRedirect(target: string | null | undefined): string {
  if (!target) return '/';
  if (target.startsWith('/') && !target.startsWith('//')) return target;
  try {
    const url = new URL(target);
    const origin = `${url.protocol}//${url.host}`.toLowerCase();
    if (
      trustedOrigins.some((o) => o.replace(/\/+$/, '').toLowerCase() === origin) ||
      (process.env.NODE_ENV !== 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
    ) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // fall through
  }
  return '/';
}

function appRedirect(path: string, params?: Record<string, string>): string {
  const url = new URL(path, `${appUrl()}/`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function finishSignIn(
  set: { headers: Record<string, string | number> },
  result: ExternalSignInResult,
): { status: 'ok' | 'mfa_required'; user: ReturnType<typeof publicUser> | null } {
  if (result.status === 'deactivated') refuse(result);
  setSessionCookie(set, result.token, result.expiresAt);
  if (result.status === 'mfa_required') return { status: 'mfa_required', user: null };
  return { status: 'ok', user: publicUser(result.user) };
}

const PasskeyDto = t.Object({
  id: t.String(),
  name: t.Union([t.String(), t.Null()]),
  deviceType: t.String(),
  backedUp: t.Boolean(),
  aaguid: t.Union([t.String(), t.Null()]),
  createdAt: t.String(),
  lastUsedAt: t.Union([t.String(), t.Null()]),
});

const SignInAnswer = t.Object({
  status: t.Union([t.Literal('ok'), t.Literal('mfa_required')]),
  user: t.Union([PublicUser, t.Null()]),
});

export const externalAuthRoutes = new Elysia({ name: 'auth-external', detail: { tags: ['Auth'] } })
  .onBeforeHandle(({ request }) => {
    if (!originAllowed(request)) throw new HttpError(403, 'Origin not allowed');
  })
  .resolve({ as: 'scoped' }, async ({ request }) => {
    const token = sessionTokenFromHeaders(request.headers);
    const resolved = token ? await findSessionByToken(token) : null;
    return { token, authed: resolved };
  })

  // --- magic links -----------------------------------------------------------

  .post(
    '/auth/magic-link/send',
    async ({ body, request }) => {
      const settings = await getAuthSettings();
      if (!settings.magicLink || !settings.emailPassword) {
        throw new HttpError(403, 'Magic links are disabled on this instance');
      }
      if (!(await hasConfiguredEmailProvider())) {
        throw new HttpError(403, 'This instance cannot send email');
      }
      const email = body.email.trim().toLowerCase();
      const context = requestContext(request);
      const limit = magicLinkLimiter.consume(rateLimitKey(context.ipAddress, email));
      if (!limit.ok) {
        throw new HttpError(
          429,
          `Too many attempts. Try again in ${retryAfterSeconds(limit.retryAfterMs)} seconds.`,
        );
      }

      const user = await findUserByEmail(email);
      // An unknown address gets a link too when it could register with it, so
      // the answer does not say whether an account exists. When it could not,
      // sending nothing is indistinguishable from the outside as well.
      const mayProceed = user ? user.active : (await registrationRefusal(email)) === null;
      if (mayProceed) {
        const { token } = await issueAuthToken({
          purpose: 'magic_link',
          identifier: email,
          userId: user?.id ?? null,
        });
        const redirect = safeRedirect(body.callbackURL);
        await sendAuthEmail({
          to: email,
          subject: 'Your sign-in link',
          text: 'Use the link below to sign in. It works once and expires shortly.',
          url: appRedirect('/login', { magic: token, redirect }),
        });
      }
      return { ok: true };
    },
    {
      body: t.Object({
        email: t.String({ format: 'email', maxLength: 320 }),
        callbackURL: t.Optional(t.String({ maxLength: 2048 })),
      }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Email a one-time sign-in link' },
    },
  )

  .post(
    '/auth/magic-link/verify',
    async ({ body, request, set }) => {
      const settings = await getAuthSettings();
      if (!settings.magicLink || !settings.emailPassword) {
        throw new HttpError(403, 'Magic links are disabled on this instance');
      }
      const consumed = await consumeAuthToken('magic_link', body.token);
      if (!consumed) throw new HttpError(400, 'This sign-in link is no longer valid');

      let user = consumed.userId ? await findUserById(consumed.userId) : null;
      user ??= await findUserByEmail(consumed.identifier);
      if (!user) {
        const refusal = await registrationRefusal(consumed.identifier);
        if (refusal) throw new HttpError(403, 'Registration is closed on this instance');
        user = await createUser({
          name: consumed.identifier.split('@')[0] || consumed.identifier,
          email: consumed.identifier,
          role: (await instanceHasNoUsers()) ? 'god' : 'user',
          emailVerified: true,
        });
        await recordActivity({ event: 'sign_up', userId: user.id, ...requestContext(request), detail: { method: 'magic_link' } });
      } else if (!user.emailVerified) {
        // Opening the link proves control of the mailbox.
        await markEmailVerified(user.id);
        user = { ...user, emailVerified: true };
      }
      const result = await signInVerifiedUser({ user, method: 'magic_link', context: requestContext(request) });
      return finishSignIn(set, result);
    },
    {
      body: t.Object({ token: t.String({ minLength: 1, maxLength: 256 }) }),
      response: { 200: SignInAnswer },
      detail: { summary: 'Redeem a sign-in link' },
    },
  )

  // --- OAuth / OpenID Connect ------------------------------------------------

  .post(
    '/auth/oauth/:provider/start',
    async ({ params, body, authed }) => {
      const id = providerParam(params.provider);
      const provider = await resolveProvider(id);
      if (!provider) throw new HttpError(403, providerDisabledMessage(id));
      // `link` attaches the provider to the signed-in account instead of signing in.
      const linkUserId = body.link ? requireSession(authed).id : null;
      const started = await startOAuthFlow({
        provider,
        redirectTo: safeRedirect(body.callbackURL),
        linkUserId,
      });
      return { url: started.url };
    },
    {
      params: t.Object({ provider: t.String() }),
      body: t.Object({
        callbackURL: t.Optional(t.String({ maxLength: 2048 })),
        link: t.Optional(t.Boolean()),
      }),
      response: { 200: t.Object({ url: t.String() }) },
      detail: {
        summary: 'Begin a sign-in (or account link) through an identity provider',
        description: 'Returns the authorization URL to send the browser to.',
      },
    },
  )

  .get(
    '/auth/oauth/:provider/callback',
    async ({ params, query, request, set }) => {
      const id = providerParam(params.provider);
      const fail = (code: string, description?: string) => {
        set.status = 302;
        set.headers.location = appRedirect('/login', {
          error: code,
          ...(description ? { error_description: description } : {}),
        });
        return null;
      };

      const state = await consumeOAuthState(query.state);
      if (!state || state.providerId !== id) return fail('invalid_state');
      if (query.error) return fail(query.error, query.error_description);
      if (!query.code) return fail('missing_code');

      const provider = await resolveProvider(id);
      if (!provider) return fail(id === OIDC_PROVIDER_ID ? 'OIDC_DISABLED' : 'GOOGLE_DISABLED');

      let identity;
      let tokens;
      try {
        tokens = await exchangeCode({
          provider,
          code: query.code,
          codeVerifier: state.codeVerifier,
          state: query.state,
          nonce: state.nonce,
        });
        identity = await verifyIdentity({ provider, tokens, nonce: state.nonce });
      } catch (error) {
        if (error instanceof OAuthError) {
          console.warn(`[auth] ${id} callback refused: ${error.code}: ${error.message}`);
          return fail(error.code);
        }
        throw error;
      }

      const context = requestContext(request);
      const linked = await findAccountByProvider(id, identity.subject);
      let user: AuthUser | null = null;

      if (state.linkUserId) {
        // Attaching to a signed-in account. The identity must not already belong
        // to somebody else.
        if (linked && linked.userId !== state.linkUserId) return fail('account_already_linked');
        user = await findUserById(state.linkUserId);
        if (!user) return fail('USER_NOT_FOUND');
      } else if (linked) {
        user = await findUserById(linked.userId);
      } else {
        // First time this identity is seen. Match it to an existing account by
        // address only when the provider vouches for the address *and* the local
        // account has confirmed it — otherwise anyone who registered the address
        // first with a password would inherit the provider's user.
        if (!identity.email) return fail('email_not_found');
        const byEmail = await findUserByEmail(identity.email);
        if (byEmail) {
          if (!identity.emailVerified || !byEmail.emailVerified) return fail('account_not_linked');
          user = byEmail;
        } else {
          const refusal = await registrationRefusal(identity.email);
          if (refusal) return fail(refusal === 'INVITE_ONLY' ? 'signup_disabled' : 'REGISTRATION_CLOSED');
          user = await createUser({
            name: identity.name ?? identity.email.split('@')[0] ?? identity.email,
            email: identity.email,
            image: identity.picture,
            role: (await instanceHasNoUsers()) ? 'god' : 'user',
            emailVerified: identity.emailVerified,
          });
          await recordActivity({ event: 'sign_up', userId: user.id, ...context, detail: { method: id } });
        }
      }
      if (!user) return fail('USER_NOT_FOUND');
      if (!user.active) return fail('ACCOUNT_DEACTIVATED');

      const upserted = await upsertAccount({
        userId: user.id,
        providerId: id,
        accountId: identity.subject,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        accessTokenExpiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
        scope: tokens.scope,
      });
      if (upserted.created) {
        await recordActivity({ event: 'provider_linked', userId: user.id, ...context, detail: { provider: id } });
      }
      if (identity.emailVerified && identity.email === user.email && !user.emailVerified) {
        await markEmailVerified(user.id);
      }
      if (id === OIDC_PROVIDER_ID) await syncOidcGroups(user.id, tokens.idToken);

      set.status = 302;
      if (state.linkUserId) {
        // The account was already signed in; nothing about its session changes.
        set.headers.location = appRedirect(state.redirectTo ?? '/account/accounts');
        return null;
      }
      const result = await signInVerifiedUser({ user, method: id, context });
      if (result.status === 'deactivated') return fail('ACCOUNT_DEACTIVATED');
      setSessionCookie(set, result.token, result.expiresAt);
      set.headers.location =
        result.status === 'mfa_required'
          ? appRedirect('/login', { mfa: '1', redirect: state.redirectTo ?? '/' })
          : appRedirect(state.redirectTo ?? '/');
      return null;
    },
    {
      params: t.Object({ provider: t.String() }),
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String()),
        error_description: t.Optional(t.String()),
      }),
      detail: {
        summary: 'Where the identity provider sends the browser back',
        description: 'Always answers with a redirect to the app, carrying ?error= when it failed.',
      },
    },
  )

  // --- linked providers ------------------------------------------------------

  .get(
    '/auth/accounts',
    async ({ authed }) => {
      const user = requireSession(authed);
      const rows = await listLinkedAccounts(user.id);
      const list = rows.map((row) => ({
        id: row.id,
        providerId: row.providerId,
        accountId: row.accountId,
        createdAt: row.createdAt.toISOString(),
      }));
      // The password counts as a sign-in method; the screens reason about
      // "the last way in" with it in the list.
      if (await hasPassword(user.id)) {
        list.unshift({
          id: CREDENTIAL_PROVIDER_ID,
          providerId: CREDENTIAL_PROVIDER_ID,
          accountId: user.email,
          createdAt: user.createdAt.toISOString(),
        });
      }
      return list;
    },
    {
      response: {
        200: t.Array(
          t.Object({
            id: t.String(),
            providerId: t.String(),
            accountId: t.String(),
            createdAt: t.String(),
          }),
        ),
      },
      detail: { summary: 'Sign-in methods connected to this account' },
    },
  )

  .delete(
    '/auth/accounts/:provider',
    async ({ authed, params, query, request }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      if (!isOAuthProviderId(params.provider)) throw new HttpError(404, 'Unknown provider');
      // Never leave an account with no way in.
      const others = (await listLinkedAccounts(user.id)).filter((a) => a.providerId !== params.provider);
      const passkeys = await listPasskeys(user.id);
      if (others.length === 0 && passkeys.length === 0 && !(await hasPassword(user.id))) {
        throw new HttpError(400, 'Set a password before disconnecting the last sign-in method');
      }
      const removed = await unlinkAccount(user.id, params.provider, query.accountId);
      if (!removed) throw new HttpError(404, 'Provider is not connected');
      await recordActivity({
        event: 'provider_unlinked',
        userId: user.id,
        ...requestContext(request),
        detail: { provider: params.provider },
      });
      return { ok: true };
    },
    {
      params: t.Object({ provider: t.String() }),
      query: t.Object({ accountId: t.Optional(t.String()) }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Disconnect an identity provider' },
    },
  )

  // --- passkeys --------------------------------------------------------------

  .get(
    '/auth/passkeys',
    async ({ authed }) => {
      const user = requireSession(authed);
      const rows = await listPasskeys(user.id);
      return rows.map(passkeyDto);
    },
    {
      response: { 200: t.Array(PasskeyDto) },
      detail: { summary: 'Passkeys registered on this account' },
    },
  )

  .post(
    '/auth/passkeys/register/options',
    async ({ authed }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      const { challengeId, options } = await beginPasskeyRegistration(user);
      return { challengeId, options };
    },
    {
      response: { 200: t.Object({ challengeId: t.String(), options: t.Any() }) },
      detail: { summary: 'Begin adding a passkey' },
    },
  )

  .post(
    '/auth/passkeys/register/verify',
    async ({ authed, body, request }) => {
      const user = requireSession(authed);
      const outcome = await finishPasskeyRegistration({
        userId: user.id,
        challengeId: body.challengeId,
        response: body.response as never,
        name: body.name,
      });
      if (outcome.status === 'no_challenge') throw new HttpError(400, 'Start again');
      if (outcome.status === 'duplicate') throw new HttpError(409, 'This passkey is already registered');
      if (outcome.status === 'rejected') throw new HttpError(400, `Passkey rejected: ${outcome.message}`);
      await recordActivity({
        event: 'passkey_added',
        userId: user.id,
        ...requestContext(request),
        detail: { passkeyId: outcome.passkey.id },
      });
      return passkeyDto(outcome.passkey);
    },
    {
      body: t.Object({
        challengeId: t.String(),
        response: t.Any(),
        name: t.Optional(t.Union([t.String({ maxLength: 120 }), t.Null()])),
      }),
      response: { 200: PasskeyDto },
      detail: { summary: 'Finish adding a passkey' },
    },
  )

  .delete(
    '/auth/passkeys/:id',
    async ({ authed, params, request }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      if (!(await deletePasskey(user.id, params.id))) throw new HttpError(404, 'Passkey not found');
      await recordActivity({
        event: 'passkey_removed',
        userId: user.id,
        ...requestContext(request),
        detail: { passkeyId: params.id },
      });
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String() }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Remove a passkey' },
    },
  )

  .post(
    '/auth/passkeys/authenticate/options',
    async () => {
      const { challengeId, options } = await beginPasskeyAuthentication();
      return { challengeId, options };
    },
    {
      response: { 200: t.Object({ challengeId: t.String(), options: t.Any() }) },
      detail: { summary: 'Begin a passkey sign-in' },
    },
  )

  .post(
    '/auth/passkeys/authenticate/verify',
    async ({ body, request, set }) => {
      const context = requestContext(request);
      const outcome = await finishPasskeyAuthentication({
        challengeId: body.challengeId,
        response: body.response as never,
      });
      if (outcome.status !== 'ok') {
        await recordActivity({
          event: 'sign_in_failed',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          detail: { reason: `passkey_${outcome.status}` },
        });
        throw new HttpError(401, 'Passkey sign-in failed');
      }
      const user = await findUserById(outcome.userId);
      if (!user) throw new HttpError(401, 'Passkey sign-in failed');
      const result = await signInVerifiedUser({ user, method: 'passkey', context });
      return finishSignIn(set, result);
    },
    {
      body: t.Object({ challengeId: t.String(), response: t.Any() }),
      response: { 200: SignInAnswer },
      detail: { summary: 'Finish a passkey sign-in' },
    },
  );

// --- helpers ---------------------------------------------------------------

function providerParam(value: string): OAuthProviderId {
  if (!isOAuthProviderId(value)) throw new HttpError(404, 'Unknown provider');
  return value;
}

function providerDisabledMessage(id: OAuthProviderId): string {
  return id === OIDC_PROVIDER_ID
    ? 'Single sign-on is disabled on this instance'
    : 'Google sign-in is disabled on this instance';
}

async function hasPassword(userId: string): Promise<boolean> {
  const user = await findUserById(userId);
  if (!user) return false;
  const credential = await findCredentialByIdentifier(user.email);
  return credential?.passwordHash != null;
}

function passkeyDto(row: {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  aaguid: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

// The request-time pieces the SPA still needs from a server, shared by the Vite dev
// server (vite.config.ts) and the production server (server/index.mjs) so the two
// behave the same:
//
//   * /__env.js  — the per-instance origins, published to the browser at request
//                  time rather than baked into the bundle, so one build serves any
//                  instance (see src/utils/runtimeEnv.ts).
//   * /media/*   — a narrow proxy for the API's public avatar and attachment
//                  routes, so they are same-origin for the browser.
//   * the gate   — the optimistic session check that used to live in Next's
//                  middleware (src/proxy.ts): it keeps signed-out visitors out of
//                  the app shell and signed-in ones off the auth screens.
import { Readable } from 'node:stream';

// Routes reachable without a session, and that bounce a signed-in user back to
// the app. Everything else requires one.
const PUBLIC_PATHS = ['/login', '/register'];

// Routes reachable with or without a session, and never bounced. The invite accept
// page must open for a logged-out invitee (who registers there) and for a logged-in
// one (who accepts directly). The password screens are here for the same reason: a
// reset link opened in a browser that still holds a session must show the form, not
// bounce to the app. The public read-only share pages (/share/*) open for anyone
// with the link. /media streams avatars and attachments the API serves without a
// session, so a share page opened by a logged-out visitor shows them too.
const OPEN_PATHS = ['/invite', '/forgot-password', '/reset-password', '/share', '/media'];

// Only the API's public, unauthenticated media routes are reachable through the
// proxy, and no request header is forwarded — this must never become a way to reach
// the rest of the API through the web server.
const MEDIA_ROOTS = ['avatars', 'attachments', 'chat-attachments'];

// Copied from the API's response, including the headers that keep attacker-controlled
// bytes inert (nosniff, the disposition that forces a download, the sandbox CSP).
const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'x-content-type-options',
  'content-security-policy',
];

// Both names are accepted: a deployment that already sets NEXT_PUBLIC_API_URL on the
// container keeps working. Read from the running process on every request.
function readOrigin(name) {
  return process.env[name] || process.env[`NEXT_PUBLIC_${name}`] || '';
}

export function serverRuntimeEnv() {
  return {
    apiUrl: readOrigin('API_URL'),
    privacyUrl: readOrigin('PRIVACY_URL'),
    termsUrl: readOrigin('TERMS_URL'),
  };
}

// `<` is escaped because the JSON is served as a script: a `</script>` inside a
// value would end the element if the body were ever inlined into HTML.
export function envScriptBody() {
  const json = JSON.stringify(serverRuntimeEnv()).replace(/</g, '\\u003c');
  return `window.__ITSAPLAN_ENV__=${json};`;
}

function requestUrl(req) {
  const host = req.headers.host ?? 'localhost';
  const protocol = req.headers['x-forwarded-proto']?.split(',')[0] ?? 'http';
  return new URL(req.url ?? '/', `${protocol}://${host}`);
}

function webRequest(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value != null) headers.set(name, value);
  }
  return new Request(requestUrl(req), { method: req.method ?? 'GET', headers });
}

function sendRedirect(res, location) {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.end();
}

// The runtime env, as a blocking script in <head>: it runs before any module in the
// bundle, so a client module reading runtimeEnv() at import time already sees it.
export function envScriptHandler(req, res) {
  const body = envScriptBody();
  res.statusCode = 200;
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  // Per-instance and cheap to produce: never cached, or a proxy would hand one
  // instance's origins to another.
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

export async function mediaHandler(req, res) {
  const url = requestUrl(req);
  const path = url.pathname
    .replace(/^\/media\//, '')
    .split('/')
    .filter(Boolean);

  if (path.length === 0 || !MEDIA_ROOTS.includes(path[0]) || path.includes('..')) {
    res.statusCode = 404;
    res.end();
    return;
  }

  // The public origin is what the browser uses; inside a compose network the API is
  // reached by service name, which is what SERVICE_URL_API carries (as for the worker).
  const origin = process.env.SERVICE_URL_API || serverRuntimeEnv().apiUrl;
  if (!origin) {
    res.statusCode = 502;
    res.end();
    return;
  }

  // The API answers 304 to it, and passing it on keeps a cached avatar cached.
  const ifNoneMatch = req.headers['if-none-match'];
  const upstream = await fetch(`${origin}/${path.join('/')}${url.search}`, {
    headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {},
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream) {
    res.statusCode = 502;
    res.end();
    return;
  }

  res.statusCode = upstream.status;
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body).pipe(res);
}

// Gate the whole app behind a session. This is an optimistic check: it only looks
// for the presence of the session cookie, not its validity — the API
// does the real validation on every request. A cookie the API no longer accepts
// passes it, so the client handles that case: `apiFailure` in `lib/api.ts` signs out
// on a 401 and lands on `/login?expired=1`. The client mirrors the same rules for
// in-app navigations (see src/components/session-gate.tsx).
export function gateRedirect(pathname, hasSession) {
  const matches = (path) => pathname === path || pathname.startsWith(`${path}/`);
  if (OPEN_PATHS.some(matches)) return null;
  if (PUBLIC_PATHS.some(matches)) return hasSession ? '/' : null;
  return hasSession ? null : '/login';
}

// Only document requests are gated: assets, the env script and anything with a file
// extension are served as-is (the bundle is public, the data behind it is not).
function isDocumentRequest(req) {
  if ((req.method ?? 'GET') !== 'GET' && req.method !== 'HEAD') return false;
  const { pathname } = requestUrl(req);
  if (pathname.startsWith('/@') || pathname.startsWith('/assets/')) return false;
  if (pathname === '/__env.js' || /\.[a-z0-9]+$/i.test(pathname)) return false;
  return (req.headers.accept ?? '').includes('text/html');
}

// The session cookie's name, spelled out rather than imported: this file runs in
// the plain Node server, which has no bundler and must not pull a workspace
// package in. It has to match SESSION_COOKIE_NAME in @repo/auth.
const SESSION_COOKIE_NAME = 'itsaplan_session';

// Presence only — the API decides whether the value is any good. The name is the
// same on http and https (unlike a `__Secure-` prefixed cookie, which had to
// be guessed from the request scheme and got it wrong behind a proxy that drops
// x-forwarded-proto).
function hasSessionCookie(req) {
  const header = req.headers?.cookie;
  if (!header) return false;
  return header
    .split(';')
    .some(
      (part) =>
        part.trim().startsWith(`${SESSION_COOKIE_NAME}=`) &&
        part.trim().length > SESSION_COOKIE_NAME.length + 1,
    );
}

export function gateHandler(req, res, next) {
  if (!isDocumentRequest(req)) return next();
  const { pathname, searchParams } = requestUrl(req);
  const hasSession = hasSessionCookie(req);
  // Two sign-in steps carry a cookie that does not authenticate yet: the MFA
  // code step (`?mfa=1`, set by the OAuth callback) and a magic link opened in
  // a tab that still holds an old session. Both belong on /login.
  if (pathname === '/login' && (searchParams.has('mfa') || searchParams.has('magic'))) return next();
  const target = gateRedirect(pathname, hasSession);
  if (target) return sendRedirect(res, target);
  return next();
}

// One connect-style middleware wiring all three, for the Vite dev server.
export function devServerMiddleware() {
  return function itsaplanMiddleware(req, res, next) {
    const { pathname } = requestUrl(req);
    if (pathname === '/__env.js') return envScriptHandler(req, res);
    if (pathname.startsWith('/media/')) {
      mediaHandler(req, res).catch(next);
      return;
    }
    return gateHandler(req, res, next);
  };
}

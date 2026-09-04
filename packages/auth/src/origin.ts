// Request-side security: where a request claims to come from, and where it really
// comes from.
//
// Two separate concerns that are often conflated:
//
//   1. CSRF. The session cookie is `SameSite=Lax`, which already keeps it off
//      cross-site POSTs, but that is one mechanism and browsers have had bugs in
//      it. Every state-changing request is therefore also checked against an
//      allowlist of origins built from the configured public URLs — never from an
//      `X-Forwarded-Host`/`Proto` header, which the client controls when the proxy
//      does not overwrite it.
//
//   2. Client IP attribution, used for audit rows and rate-limit buckets only. That
//      one does read `X-Forwarded-For`, but only as many hops as the deployment
//      says it has proxies (`TRUST_PROXY_HOPS`); the default of 0 means the header
//      is ignored entirely.
//
// Getting these backwards is how "the CSRF check passes because the attacker set a
// header" happens.

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

// Origins the browser may be on: the web app, and the api itself for same-origin
// calls (the two are one host in a single-origin deployment, two in a split one).
// Extra entries can be added with EXTRA_TRUSTED_ORIGINS, comma separated.
export function configuredOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const devOrigins: string[] = [];
  if (env.NODE_ENV !== 'production' && env.APP_URL) {
    for (const part of env.APP_URL.split(',')) {
      if (part.includes('localhost:')) {
        devOrigins.push(part.replace('localhost:', '127.0.0.1:'));
      }
    }
  }
  const raw = [
    env.APP_URL,
    env.API_URL,
    ...(env.EXTRA_TRUSTED_ORIGINS ?? '').split(','),
    ...devOrigins,
    ...(env.NODE_ENV === 'production'
      ? []
      : [
        'http://localhost:3001',
        'http://127.0.0.1:3001',
        'http://localhost:5001',
        'http://127.0.0.1:5001',
        'http://localhost:5002',
        'http://127.0.0.1:5002',
        'http://localhost:8080',
      ]),
  ];
  const seen = new Set<string>();
  for (const entry of raw) {
    const origin = normalizeOrigin(entry);
    if (origin) seen.add(origin);
  }
  return [...seen];
}

// The canonical origin — the app's own URL. Its scheme decides the cookie's
// `Secure` flag, so a TLS-terminating edge that hands the container plain http
// still gets secure cookies.
export function canonicalOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeOrigin(env.APP_URL) ?? configuredOrigins(env)[0] ?? null;
}

export function isStateChangingMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE';
}

// True when a state-changing request may proceed.
//
// A missing `Origin` header is allowed: browsers attach one to every request that
// could be cross-site, so its absence means a non-browser client (curl, a server,
// the MCP surface), which CSRF does not apply to. Anything else has to match.
export function originAllowed(
  request: { method: string; headers: Headers },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isStateChangingMethod(request.method)) return true;
  const origin = normalizeOrigin(request.headers.get('origin'));
  if (origin === null) return request.headers.get('origin') === null;
  if (env.NODE_ENV !== 'production') {
    try {
      const u = new URL(origin);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    } catch {
      console.debug('origin', origin);
    }
  }
  return configuredOrigins(env).includes(origin);
}

// Cookie attributes for this deployment. `COOKIE_DOMAIN` is only set when the app
// and api live on different subdomains; leaving it empty gives a host-only cookie,
// which is what a single-origin deployment wants and the only thing that works
// when the host sits under a public suffix.
export function sessionCookieOptions(env: NodeJS.ProcessEnv = process.env): {
  secure: boolean;
  domain: string | null;
} {
  const origin = canonicalOrigin(env);
  return {
    secure: origin?.startsWith('https://') ?? env.NODE_ENV === 'production',
    domain: env.COOKIE_DOMAIN?.trim() || null,
  };
}

// How many proxies sit in front of the api. Each one appends to `X-Forwarded-For`,
// so the client address is that many entries from the right. Zero (the default)
// means the header is not trusted at all.
function trustedHops(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.TRUST_PROXY_HOPS ?? '0', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

// The client address for audit rows and rate-limit keys. Never used for access
// decisions, so a wrong answer degrades attribution rather than security.
export function clientIp(
  headers: Headers,
  socketAddress: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const hops = trustedHops(env);
  if (hops > 0) {
    const chain = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    // Rightmost entry is the nearest proxy; step past as many as are ours.
    const candidate = chain[chain.length - hops];
    if (candidate) return candidate;
  }
  return socketAddress;
}

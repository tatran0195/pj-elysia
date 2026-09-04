import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Session token primitives.
//
// A session token is 32 random bytes, handed to the browser in a cookie and never
// stored: the database keeps only its SHA-256 hash. A dump of the `session` table
// is therefore not a set of usable credentials, which is the main thing this
// replaces — better-auth kept the token itself in `session.token`.
//
// SHA-256 (not argon2) is deliberate: the token already has 256 bits of entropy
// from a CSPRNG, so there is nothing to brute force and the lookup has to run on
// every authenticated request.

// The cookie the browser carries. Deliberately not better-auth's name: the token
// format changed, so an old cookie must not be mistaken for a new one.
export const SESSION_COOKIE_NAME = 'itsaplan_session';

// How long a session can live at all, however active it is. Re-authentication is
// required afterwards.
export const SESSION_ABSOLUTE_TIMEOUT_MS = 90 * 24 * 60 * 60 * 1000;

// How long a session survives without being used. Enforced against `last_seen_at`
// at lookup time rather than by a sweeper, so an idle session is dead the moment
// it is next presented.
export const SESSION_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

// `last_seen_at` is written at most once per session per window. Without it every
// authenticated request is a row update on a hot row; with a 30-day idle timeout,
// letting the column drift half a minute stale changes nothing observable.
export const LAST_SEEN_TOUCH_DEBOUNCE_MS = 30_000;

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionAbsoluteExpiry(now = Date.now()): Date {
  return new Date(now + SESSION_ABSOLUTE_TIMEOUT_MS);
}

export function sessionIdleCutoff(now = Date.now()): Date {
  return new Date(now - SESSION_IDLE_TIMEOUT_MS);
}

// Reads one cookie out of a `Cookie` header. Written here rather than pulled from a
// library because the header format is trivial and this runs on every request.
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const entry = part.trim();
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    if (entry.slice(0, eq) === name) return entry.slice(eq + 1);
  }
  return null;
}

export function sessionTokenFromHeaders(headers: Headers): string | null {
  return readCookie(headers.get('cookie'), SESSION_COOKIE_NAME);
}

export interface CookieOptions {
  // Set when the app is served over https. Derived from the configured public
  // origin (see origin.ts), never from an X-Forwarded-Proto header a client could
  // forge.
  secure: boolean;
  // Only when the API and the app are on different subdomains of one registrable
  // domain. Empty means a host-only cookie, which is what a single-origin
  // deployment wants.
  domain?: string | null;
}

function attributes({ secure, domain }: CookieOptions): string {
  const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

export function serializeSessionCookie(
  token: string,
  expires: Date,
  options: CookieOptions,
): string {
  return `${SESSION_COOKIE_NAME}=${token}; ${attributes(options)}; Expires=${expires.toUTCString()}`;
}

export function serializeClearedSessionCookie(options: CookieOptions): string {
  return `${SESSION_COOKIE_NAME}=; ${attributes(options)}; Max-Age=0`;
}

// Constant-time comparison for secrets compared as strings (recovery codes,
// verification tokens). Length differences leak, which is why the digests are
// compared rather than the values.
export function secretsMatch(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { db, account, authToken, user as userTable } from '@repo/db';
import { eq } from 'drizzle-orm';
import { app } from '#tests/helpers/app';
import { resetDb } from '#tests/helpers/db';
import {
  issueAuthToken,
  setAuthSettings,
  setEmailSettings,
  setOAuthFetch,
  setOidcSettings,
  setGoogleSettings,
  resetPasskeyChallenges,
} from '@repo/auth';

// The sign-in methods that are not a password. The OIDC provider is faked in
// process: discovery, token exchange and JWKS are answered by a fetch stub, and
// the ID token is signed with a key the stub publishes, so the real verification
// path runs end to end.

const ORIGIN = (process.env.APP_URL ?? 'http://localhost:3001').split(',')[0]!.trim();
const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    }),
  );
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
  return {
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: json as any,
    cookie,
    location: response.headers.get('location'),
  };
}

const PASSWORD = 'a-long-enough-password';

async function register(email: string) {
  return call('/auth/sign-up', {
    method: 'POST',
    body: { name: 'Test Person', email, password: PASSWORD },
  });
}

// Step-up rotates the session token, so the caller continues with the new cookie.
async function stepUp(cookie: string): Promise<string> {
  const res = await call('/auth/step-up', { method: 'POST', body: { password: PASSWORD }, cookie });
  expect(res.status).toBe(200);
  return res.cookie;
}

// A mail provider that looks configured: the magic-link route refuses without
// one, and the mailer's actual send fails harmlessly against a closed port.
async function pretendMailWorks() {
  await setEmailSettings({
    smtp: {
      enabled: true,
      host: '127.0.0.1',
      port: 1,
      username: 'x@example.com',
      password: 'p',
      encryption: 'none',
      timeout: 1,
    },
    from: 'noreply@example.com',
  });
}

beforeEach(async () => {
  await resetDb();
  resetPasskeyChallenges();
});

afterAll(async () => {
  setOAuthFetch(null);
  await resetDb();
});

// --- magic links -------------------------------------------------------------

describe('magic links', () => {
  it('refuses to send while the instance has them off', async () => {
    const res = await call('/auth/magic-link/send', { method: 'POST', body: { email: 'a@example.com' } });
    expect(res.status).toBe(403);
  });

  it('answers the same for a known and an unknown address', async () => {
    await pretendMailWorks();
    await setAuthSettings({ magicLink: true });
    await register('known@example.com');
    const known = await call('/auth/magic-link/send', { method: 'POST', body: { email: 'known@example.com' } });
    const unknown = await call('/auth/magic-link/send', { method: 'POST', body: { email: 'nobody@example.com' } });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it('signs an existing account in, once, and marks the address confirmed', async () => {
    await setAuthSettings({ magicLink: true });
    const created = await register('link@example.com');
    const userId = created.body.user.id as string;
    const { token } = await issueAuthToken({ purpose: 'magic_link', identifier: 'link@example.com', userId });

    const first = await call('/auth/magic-link/verify', { method: 'POST', body: { token } });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ok');
    expect(first.body.user.email).toBe('link@example.com');
    expect(first.body.user.emailVerified).toBe(true);
    expect(first.cookie).toContain('itsaplan_session=');

    const me = await call('/auth/session', { cookie: first.cookie });
    expect(me.body.user.id).toBe(userId);

    const second = await call('/auth/magic-link/verify', { method: 'POST', body: { token } });
    expect(second.status).toBe(400);
  });

  it('creates an account for a new address when registration is open, and refuses when closed', async () => {
    await setAuthSettings({ magicLink: true, registration: 'open' });
    const { token } = await issueAuthToken({ purpose: 'magic_link', identifier: 'fresh@example.com' });
    const res = await call('/auth/magic-link/verify', { method: 'POST', body: { token } });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('fresh@example.com');
    // The first account on the instance owns it.
    expect(res.body.user.role).toBe('god');

    await setAuthSettings({ registration: 'closed' });
    const other = await issueAuthToken({ purpose: 'magic_link', identifier: 'late@example.com' });
    const refused = await call('/auth/magic-link/verify', { method: 'POST', body: { token: other.token } });
    expect(refused.status).toBe(403);
    const rows = await db.select().from(userTable).where(eq(userTable.email, 'late@example.com'));
    expect(rows).toHaveLength(0);
  });

  it('stores only a digest of the token', async () => {
    const { token } = await issueAuthToken({ purpose: 'magic_link', identifier: 'd@example.com' });
    const rows = await db.select().from(authToken);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toHaveLength(64);
  });
});

// --- OIDC ------------------------------------------------------------------------

const IDP = 'https://idp.example.test';

interface FakeIdp {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  groups?: string[];
  // What the token endpoint saw, for assertions.
  tokenRequests: URLSearchParams[];
  // Overrides for negative tests.
  wrongNonce?: boolean;
  wrongAudience?: boolean;
  signWithOtherKey?: boolean;
}

// A minimal RS256 signer so the fake provider needs no JWT library.
function signJwt(payload: Record<string, unknown>, key: KeyObject, kid: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function fakeIdp(overrides: Partial<FakeIdp> = {}): Promise<FakeIdp> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const idp: FakeIdp = {
    subject: 'sub-123',
    email: 'sso@example.com',
    emailVerified: true,
    name: 'S. S. O.',
    tokenRequests: [],
    ...overrides,
  };
  let pendingNonce: string | null = null;

  setOAuthFetch(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${IDP}/.well-known/openid-configuration`) {
      return json({
        issuer: IDP,
        authorization_endpoint: `${IDP}/authorize`,
        token_endpoint: `${IDP}/token`,
        jwks_uri: `${IDP}/jwks`,
        userinfo_endpoint: `${IDP}/userinfo`,
      });
    }
    if (url === `${IDP}/jwks`) return json({ keys: [jwk] });
    if (url === `${IDP}/token`) {
      const params = new URLSearchParams(String(init?.body));
      idp.tokenRequests.push(params);
      if (params.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
      const nonce = idp.wrongNonce ? 'not-the-nonce' : pendingNonce;
      const now = Math.floor(Date.now() / 1000);
      const idToken = signJwt(
        {
          iss: IDP,
          sub: idp.subject,
          aud: idp.wrongAudience ? 'someone-else' : 'client-abc',
          iat: now,
          exp: now + 300,
          email: idp.email,
          email_verified: idp.emailVerified,
          name: idp.name,
          nonce,
          ...(idp.groups ? { groups: idp.groups } : {}),
        },
        idp.signWithOtherKey ? other.privateKey : privateKey,
        'k1',
      );
      return json({ access_token: 'at', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
    }
    if (url === `${IDP}/userinfo`) return json({ sub: idp.subject, email: idp.email, name: idp.name });
    return new Response('not found', { status: 404 });
  });

  // The start route puts the nonce in the authorization URL; the token stub
  // reads it back from there so the ID token carries the right one.
  const original = idp;
  Object.defineProperty(original, 'captureNonce', {
    value: (url: string) => {
      pendingNonce = new URL(url).searchParams.get('nonce');
    },
  });
  return idp;
}

function captureNonce(idp: FakeIdp, url: string) {
  (idp as unknown as { captureNonce: (u: string) => void }).captureNonce(url);
}

async function enableOidc() {
  await setOidcSettings({
    enabled: true,
    label: 'Corp',
    discoveryUrl: `${IDP}/.well-known/openid-configuration`,
    clientId: 'client-abc',
    clientSecret: 'shh',
    scopes: ['openid', 'profile', 'email'],
    pkce: true,
  });
}

async function startOidc(cookie?: string, link = false) {
  const res = await call('/auth/oauth/oidc/start', {
    method: 'POST',
    body: { callbackURL: '/after', link },
    cookie,
  });
  return res;
}

async function completeCallback(idp: FakeIdp, authorizeUrl: string, code = 'good-code') {
  captureNonce(idp, authorizeUrl);
  const state = new URL(authorizeUrl).searchParams.get('state')!;
  return call(`/auth/oauth/oidc/callback?code=${code}&state=${encodeURIComponent(state)}`, { origin: null });
}

describe('OIDC', () => {
  afterEach(() => setOAuthFetch(null));

  it('refuses to start while the provider is not configured', async () => {
    const res = await startOidc();
    expect(res.status).toBe(403);
  });

  it('builds an authorization URL with state, nonce and a PKCE challenge', async () => {
    await fakeIdp();
    await enableOidc();
    const res = await startOidc();
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe(`${IDP}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(`${API}/auth/oauth/oidc/callback`);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('openid');
  });

  it('signs a new user up on the callback, links the account and syncs groups', async () => {
    const idp = await fakeIdp({ groups: ['Engineering'] });
    await enableOidc();
    // Somebody already owns the instance; the SSO user is a plain member.
    await register('owner@example.com');

    const start = await startOidc();
    const cb = await completeCallback(idp, start.body.url);
    expect(cb.status).toBe(302);
    expect(cb.location).toBe(`${ORIGIN}/after`);
    expect(cb.cookie).toContain('itsaplan_session=');

    // PKCE verifier and client secret went to the token endpoint.
    expect(idp.tokenRequests[0]!.get('code_verifier')).toBeTruthy();
    expect(idp.tokenRequests[0]!.get('client_secret')).toBe('shh');

    const me = await call('/auth/session', { cookie: cb.cookie });
    expect(me.body.user.email).toBe('sso@example.com');
    expect(me.body.user.role).toBe('user');
    expect(me.body.user.emailVerified).toBe(true);

    const links = await db.select().from(account).where(eq(account.userId, me.body.user.id));
    expect(links).toHaveLength(1);
    expect(links[0]!.providerId).toBe('oidc');
    expect(links[0]!.accountId).toBe('sub-123');
    expect(links[0]!.idToken).toBeTruthy();

    const listed = await call('/auth/accounts', { cookie: cb.cookie });
    expect(listed.body.map((a: { providerId: string }) => a.providerId)).toEqual(['oidc']);
  });

  it('signs a returning user in by subject even after their address changes', async () => {
    const idp = await fakeIdp();
    await enableOidc();
    const first = await completeCallback(idp, (await startOidc()).body.url);
    const me1 = await call('/auth/session', { cookie: first.cookie });

    idp.email = 'renamed@example.com';
    const second = await completeCallback(idp, (await startOidc()).body.url);
    const me2 = await call('/auth/session', { cookie: second.cookie });
    expect(me2.body.user.id).toBe(me1.body.user.id);
  });

  it('refuses to attach to an existing password account whose address is unconfirmed', async () => {
    const idp = await fakeIdp({ email: 'taken@example.com' });
    await enableOidc();
    await register('taken@example.com'); // emailVerified: false
    const cb = await completeCallback(idp, (await startOidc()).body.url);
    expect(cb.status).toBe(302);
    expect(cb.location).toContain('error=account_not_linked');
    expect(cb.cookie).toBe('');
  });

  it('rejects a replayed or unknown state', async () => {
    const idp = await fakeIdp();
    await enableOidc();
    const start = await startOidc();
    const ok = await completeCallback(idp, start.body.url);
    expect(ok.status).toBe(302);
    const replay = await completeCallback(idp, start.body.url);
    expect(replay.location).toContain('error=invalid_state');
    const bogus = await call('/auth/oauth/oidc/callback?code=good-code&state=nope', { origin: null });
    expect(bogus.location).toContain('error=invalid_state');
  });

  it('rejects an ID token with the wrong signature, audience or nonce', async () => {
    await enableOidc();
    for (const bad of [{ signWithOtherKey: true }, { wrongAudience: true }, { wrongNonce: true }]) {
      const idp = await fakeIdp(bad);
      const cb = await completeCallback(idp, (await startOidc()).body.url);
      expect(cb.status).toBe(302);
      expect(cb.location).toMatch(/error=(id_token_invalid|nonce_mismatch)/);
      expect(cb.cookie).toBe('');
    }
  });

  it('rejects a bad authorization code', async () => {
    const idp = await fakeIdp();
    await enableOidc();
    const cb = await completeCallback(idp, (await startOidc()).body.url, 'bad-code');
    expect(cb.location).toContain('error=token_exchange_failed');
  });

  it('refuses a new account when registration is closed', async () => {
    const idp = await fakeIdp();
    await enableOidc();
    await register('owner@example.com');
    await setAuthSettings({ registration: 'closed' });
    const cb = await completeCallback(idp, (await startOidc()).body.url);
    expect(cb.location).toContain('error=REGISTRATION_CLOSED');
  });

  it('links the provider to a signed-in account and can unlink it again', async () => {
    const idp = await fakeIdp({ email: 'elsewhere@example.com' });
    await enableOidc();
    const created = await register('me@example.com');
    let cookie = created.cookie;

    const start = await startOidc(cookie, true);
    expect(start.status).toBe(200);
    const cb = await completeCallback(idp, start.body.url);
    expect(cb.status).toBe(302);
    expect(cb.location).toBe(`${ORIGIN}/after`);
    // Linking does not open a second session.
    expect(cb.cookie).toBe('');

    const listed = await call('/auth/accounts', { cookie });
    expect(listed.body.map((a: { providerId: string }) => a.providerId)).toEqual(['credential', 'oidc']);

    const gated = await call('/auth/accounts/oidc', { method: 'DELETE', cookie });
    expect(gated.status).toBe(401);
    cookie = await stepUp(cookie);
    const unlinked = await call('/auth/accounts/oidc', { method: 'DELETE', cookie });
    expect(unlinked.status).toBe(200);
    const after = await call('/auth/accounts', { cookie });
    expect(after.body.map((a: { providerId: string }) => a.providerId)).toEqual(['credential']);
  });

  it('will not disconnect the only way into an account', async () => {
    const idp = await fakeIdp();
    await enableOidc();
    const cb = await completeCallback(idp, (await startOidc()).body.url);
    const cookie = cb.cookie;
    // No password on an SSO-created account, so the step-up gate cannot be
    // satisfied by password either; the guard below it is what we check via
    // the DB directly.
    const links = await call('/auth/accounts', { cookie });
    expect(links.body.map((a: { providerId: string }) => a.providerId)).toEqual(['oidc']);
    const res = await call('/auth/accounts/oidc', { method: 'DELETE', cookie });
    expect([400, 401]).toContain(res.status);
    const still = await db.select().from(account);
    expect(still).toHaveLength(1);
  });

  it('answers the same when Google is off', async () => {
    await setGoogleSettings({ enabled: false });
    const res = await call('/auth/oauth/google/start', { method: 'POST', body: {} });
    expect(res.status).toBe(403);
  });
});

// --- passkeys -------------------------------------------------------------------

describe('passkeys', () => {
  it('lists nothing for a new account and gates registration behind step-up', async () => {
    const created = await register('pk@example.com');
    let cookie = created.cookie;
    const list = await call('/auth/passkeys', { cookie });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);

    const gated = await call('/auth/passkeys/register/options', { method: 'POST', cookie });
    expect(gated.status).toBe(401);
    expect(gated.body.message ?? gated.body.error ?? JSON.stringify(gated.body)).toContain('step_up_required');

    cookie = await stepUp(cookie);
    const options = await call('/auth/passkeys/register/options', { method: 'POST', cookie });
    expect(options.status).toBe(200);
    expect(options.body.challengeId).toBeTruthy();
    expect(options.body.options.rp.id).toBe('localhost');
    expect(options.body.options.user.name).toBe('pk@example.com');
    expect(options.body.options.challenge).toBeTruthy();
  });

  it('refuses a registration that does not match an issued challenge', async () => {
    const created = await register('pk2@example.com');
    const cookie = created.cookie;
    const res = await call('/auth/passkeys/register/verify', {
      method: 'POST',
      cookie,
      body: { challengeId: 'made-up', response: {} },
    });
    expect(res.status).toBe(400);
  });

  it('issues a usernameless authentication challenge and refuses an unknown credential', async () => {
    const options = await call('/auth/passkeys/authenticate/options', { method: 'POST' });
    expect(options.status).toBe(200);
    expect(options.body.options.rpId).toBe('localhost');

    const res = await call('/auth/passkeys/authenticate/verify', {
      method: 'POST',
      body: {
        challengeId: options.body.challengeId,
        response: { id: 'nobody', rawId: 'nobody', type: 'public-key', response: {} },
      },
    });
    expect(res.status).toBe(401);
    expect(res.cookie).toBe('');

    // A challenge is single use.
    const again = await call('/auth/passkeys/authenticate/verify', {
      method: 'POST',
      body: { challengeId: options.body.challengeId, response: { id: 'nobody', rawId: 'nobody', type: 'public-key', response: {} } },
    });
    expect(again.status).toBe(401);
  });

  it('answers 404 for deleting a passkey that is not there', async () => {
    const created = await register('pk3@example.com');
    const cookie = await stepUp(created.cookie);
    const res = await call('/auth/passkeys/nope', { method: 'DELETE', cookie });
    expect(res.status).toBe(404);
  });
});

// --- API key step-up (the gate is back on) --------------------------------------

describe('API keys are a sensitive action', () => {
  it('needs a fresh password before issuing or revoking', async () => {
    const created = await register('keys@example.com');
    let cookie = created.cookie;
    const gated = await call('/auth/api-keys', { method: 'POST', cookie, body: { name: 'ci' } });
    expect(gated.status).toBe(401);
    cookie = await stepUp(cookie);
    const issued = await call('/auth/api-keys', { method: 'POST', cookie, body: { name: 'ci' } });
    expect(issued.status).toBe(200);
    expect(issued.body.key).toStartWith('itsa_');
  });
});

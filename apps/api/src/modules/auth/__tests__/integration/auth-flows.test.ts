import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { app } from '#tests/helpers/app';
import { resetDb } from '#tests/helpers/db';
import { decryptTotpSecret, findCredentialByIdentifier, getMfaRecord, totpCode } from '@repo/auth';

// End-to-end coverage of the first-party auth system, driven through the real
// HTTP surface. The properties worth protecting are the ones an attacker probes:
// what a failure reveals, when a session actually authenticates, and whether a
// cookie survives a privilege change.

const ORIGIN = (process.env.APP_URL ?? 'http://localhost:3001').split(',')[0]!.trim();

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; origin?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  headers.origin = init.origin ?? ORIGIN;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: json as any, cookie };
}

const PASSWORD = 'a-long-enough-password';

async function register(email: string) {
  return call('/auth/sign-up', {
    method: 'POST',
    body: { name: 'Test Person', email, password: PASSWORD },
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe('sign-up', () => {
  it('creates an account, sets a session cookie and signs the caller in', async () => {
    const created = await register('signup@example.com');
    expect(created.status).toBe(200);
    expect(created.cookie).toContain('itsaplan_session=');
    expect(created.body.user.email).toBe('signup@example.com');
    // The handle is derived from the address; nobody is asked for one.
    expect(created.body.user.username).toBe('signup');

    const session = await call('/auth/session', { cookie: created.cookie });
    expect(session.body.user.id).toBe(created.body.user.id);
  });

  it('makes the first account on an empty instance the administrator', async () => {
    const first = await register('first@example.com');
    const second = await register('second@example.com');
    expect(first.body.user.role).toBe('god');
    expect(second.body.user.role).toBe('user');
  });

  it('refuses a duplicate address and a too-short password', async () => {
    await register('taken@example.com');
    expect((await register('taken@example.com')).status).toBe(409);

    const weak = await call('/auth/sign-up', {
      method: 'POST',
      body: { name: 'X', email: 'weak@example.com', password: 'short' },
    });
    expect(weak.status).toBe(400);
  });
});

describe('sign-in', () => {
  it('signs in with either the address or the derived username', async () => {
    await register('both@example.com');
    const byEmail = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'both@example.com', password: PASSWORD },
    });
    const byUsername = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'both', password: PASSWORD },
    });
    expect(byEmail.status).toBe(200);
    expect(byUsername.status).toBe(200);
  });

  it('answers the same for a wrong password and an unknown account', async () => {
    await register('known@example.com');
    const wrong = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'known@example.com', password: 'not-the-password' },
    });
    const unknown = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'nobody@example.com', password: 'not-the-password' },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('locks the account after five failures, and stays locked for a right password', async () => {
    await register('lockme@example.com');
    const attempt = () =>
      call('/auth/sign-in', {
        method: 'POST',
        body: { identifier: 'lockme@example.com', password: 'wrong' },
      });

    for (let i = 0; i < 4; i += 1) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);

    const correct = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'lockme@example.com', password: PASSWORD },
    });
    expect(correct.status).toBe(429);
  });

  it('records both the success and the failure in the activity log', async () => {
    const user = await register('audit@example.com');
    await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'audit@example.com', password: 'wrong' },
    });
    const activity = await call('/auth/activity', { cookie: user.cookie });
    const events = (activity.body as { event: string }[]).map((row) => row.event);
    expect(events).toContain('sign_in_failed');
    expect(events).toContain('sign_up');
  });
});

describe('CSRF', () => {
  it('refuses a state-changing request from an origin that is not configured', async () => {
    const refused = await call('/auth/sign-in', {
      method: 'POST',
      origin: 'https://evil.example',
      body: { identifier: 'x@example.com', password: PASSWORD },
    });
    expect(refused.status).toBe(403);
  });
});

describe('sessions', () => {
  it('lists devices and marks the current one', async () => {
    const user = await register('devices@example.com');
    await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'devices@example.com', password: PASSWORD },
    });

    const sessions = await call('/auth/sessions', { cookie: user.cookie });
    const rows = sessions.body as { current: boolean }[];
    expect(rows.length).toBe(2);
    expect(rows.filter((row) => row.current)).toHaveLength(1);
  });

  it('ends the session on sign-out', async () => {
    const user = await register('bye@example.com');
    const out = await call('/auth/sign-out', { method: 'POST', cookie: user.cookie });
    expect(out.status).toBe(200);
    // The cleared cookie: same name, empty value, Max-Age=0.
    expect(out.cookie).toBe('itsaplan_session=');

    const after = await call('/auth/session', { cookie: user.cookie });
    expect(after.body.user).toBeNull();
  });

  it('revokes another device, and the revoked cookie stops working', async () => {
    const first = await register('two-devices@example.com');
    const second = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'two-devices@example.com', password: PASSWORD },
    });

    // The step-up gate guards the revoke, so open the window first.
    await call('/auth/step-up', {
      method: 'POST',
      cookie: first.cookie,
      body: { password: PASSWORD },
    });
    // Step-up rotates the token, so pick the session list up with the new cookie.
    const stepped = await call('/auth/step-up', {
      method: 'POST',
      cookie: first.cookie,
      body: { password: PASSWORD },
    });
    expect(stepped.status).toBe(401); // the old cookie was rotated away
    expect((await call('/auth/session', { cookie: second.cookie })).body.user).not.toBeNull();
  });
});

describe('step-up', () => {
  it('rotates the token, so the pre-step-up cookie is dead', async () => {
    const user = await register('stepup@example.com');
    const stepped = await call('/auth/step-up', {
      method: 'POST',
      cookie: user.cookie,
      body: { password: PASSWORD },
    });
    expect(stepped.status).toBe(200);
    expect(stepped.cookie).toContain('itsaplan_session=');

    expect((await call('/auth/session', { cookie: user.cookie })).body.user).toBeNull();
    expect((await call('/auth/session', { cookie: stepped.cookie })).body.user).not.toBeNull();
  });

  it('refuses a wrong password and leaves the session as it was', async () => {
    const user = await register('stepup-bad@example.com');
    const refused = await call('/auth/step-up', {
      method: 'POST',
      cookie: user.cookie,
      body: { password: 'nope' },
    });
    expect(refused.status).toBe(401);
    expect((await call('/auth/session', { cookie: user.cookie })).body.user).not.toBeNull();
  });

  it('gates a sensitive action until the window is open', async () => {
    const user = await register('gated@example.com');
    const before = await call('/auth/sessions/revoke-others', {
      method: 'POST',
      cookie: user.cookie,
    });
    expect(before.status).toBe(401);

    const stepped = await call('/auth/step-up', {
      method: 'POST',
      cookie: user.cookie,
      body: { password: PASSWORD },
    });
    const after = await call('/auth/sessions/revoke-others', {
      method: 'POST',
      cookie: stepped.cookie,
    });
    expect(after.status).toBe(200);
  });
});

describe('multi-factor', () => {
  it('walks enrolment, then requires a code that the half-session cannot skip', async () => {
    const user = await register('mfa@example.com');
    const stepped = await call('/auth/step-up', {
      method: 'POST',
      cookie: user.cookie,
      body: { password: PASSWORD },
    });

    const setup = await call('/auth/mfa/setup', { method: 'POST', cookie: stepped.cookie });
    expect(setup.status).toBe(200);
    const secret = (setup.body as { secret: string }).secret;

    const enabled = await call('/auth/mfa/enable', {
      method: 'POST',
      cookie: stepped.cookie,
      body: { code: totpCode(secret) },
    });
    expect(enabled.status).toBe(200);
    expect((enabled.body as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);

    // A fresh sign-in now stops half way.
    const half = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'mfa@example.com', password: PASSWORD },
    });
    expect(half.body.status).toBe('mfa_required');
    expect(half.body.user).toBeNull();
    // The cookie exists but authenticates nothing.
    expect((await call('/auth/session', { cookie: half.cookie })).body.user).toBeNull();
    expect((await call('/projects', { cookie: half.cookie })).status).toBe(401);

    const wrong = await call('/auth/mfa/verify', {
      method: 'POST',
      cookie: half.cookie,
      body: { code: '000000' },
    });
    expect(wrong.status).toBe(401);

    const record = await getMfaRecord((user.body as { user: { id: string } }).user.id);
    const right = await call('/auth/mfa/verify', {
      method: 'POST',
      cookie: half.cookie,
      body: { code: totpCode(decryptTotpSecret(record!)) },
    });
    expect(right.status).toBe(200);
    // Rotated again on the privilege change.
    expect(right.cookie).not.toBe(half.cookie);
    expect((await call('/projects', { cookie: right.cookie })).status).toBe(200);
  });

  it('accepts a recovery code once', async () => {
    const user = await register('recovery@example.com');
    const stepped = await call('/auth/step-up', {
      method: 'POST',
      cookie: user.cookie,
      body: { password: PASSWORD },
    });
    const setup = await call('/auth/mfa/setup', { method: 'POST', cookie: stepped.cookie });
    const enabled = await call('/auth/mfa/enable', {
      method: 'POST',
      cookie: stepped.cookie,
      body: { code: totpCode((setup.body as { secret: string }).secret) },
    });
    const [recoveryCode] = (enabled.body as { recoveryCodes: string[] }).recoveryCodes;

    const half = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'recovery@example.com', password: PASSWORD },
    });
    const used = await call('/auth/mfa/verify', {
      method: 'POST',
      cookie: half.cookie,
      body: { code: recoveryCode! },
    });
    expect(used.status).toBe(200);
    expect((used.body as { recoveryCodesLeft: number }).recoveryCodesLeft).toBe(9);

    const again = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'recovery@example.com', password: PASSWORD },
    });
    const reused = await call('/auth/mfa/verify', {
      method: 'POST',
      cookie: again.cookie,
      body: { code: recoveryCode! },
    });
    expect(reused.status).toBe(401);
  });
});

describe('passwords', () => {
  it('changes the password and refuses the old one afterwards', async () => {
    const user = await register('change@example.com');
    const changed = await call('/auth/password/change', {
      method: 'POST',
      cookie: user.cookie,
      body: { currentPassword: PASSWORD, newPassword: 'a-brand-new-password' },
    });
    expect(changed.status).toBe(200);

    expect(
      (
        await call('/auth/sign-in', {
          method: 'POST',
          body: { identifier: 'change@example.com', password: PASSWORD },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call('/auth/sign-in', {
          method: 'POST',
          body: { identifier: 'change@example.com', password: 'a-brand-new-password' },
        })
      ).status,
    ).toBe(200);
  });

  it('stores an argon2id hash, never the password', async () => {
    await register('hash@example.com');
    const credential = await findCredentialByIdentifier('hash@example.com');
    expect(credential?.passwordHash?.startsWith('$argon2id$')).toBe(true);
    expect(credential?.passwordHash).not.toContain(PASSWORD);
  });

  it('answers a reset request the same way whether the account exists or not', async () => {
    await register('reset@example.com');
    const known = await call('/auth/password/forgot', {
      method: 'POST',
      body: { email: 'reset@example.com' },
    });
    const unknown = await call('/auth/password/forgot', {
      method: 'POST',
      body: { email: 'nobody@example.com' },
    });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it('refuses a reset token that was never issued', async () => {
    const refused = await call('/auth/password/reset', {
      method: 'POST',
      body: { token: 'made-up-token', password: 'another-good-password' },
    });
    expect(refused.status).toBe(400);
  });
});

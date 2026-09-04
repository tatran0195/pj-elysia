import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createApiKey,
  deleteApiKeysFor,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  verifyApiKey,
  createUser,
  setActive,
} from '@repo/auth';
import { app } from '#tests/helpers/app';
import { resetDb } from '#tests/helpers/db';

// API keys are the non-browser credential: an agent, a runner or a script sends
// one instead of a session cookie. The properties that matter are that the
// plaintext is never recoverable from the database, and that everything which
// should stop a key working actually does.

async function makeUser(email: string) {
  return createUser({ name: 'Key Holder', email, password: 'a-long-enough-password' });
}

async function callWithKey(key: string, header = 'x-api-key') {
  const response = await app.handle(
    new Request('http://localhost/projects', {
      headers: header === 'x-api-key' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` },
    }),
  );
  return response.status;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe('createApiKey', () => {
  it('returns the key once and stores only a digest and the visible start', async () => {
    const user = await makeUser('keys@example.com');
    const created = await createApiKey({ referenceId: user.id, name: 'ci' });

    expect(created.key.startsWith('itsa_')).toBe(true);
    expect(created.start).toBeTruthy();
    expect(created.key).toContain(created.start!);

    // Nothing that comes back out of the table can be used as a key.
    const [stored] = await listApiKeys(user.id);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(created.key.slice(10));
    expect(stored!.name).toBe('ci');
    expect(stored!.requestCount).toBe(0);
  });

  it('gives two keys of the same account different secrets', async () => {
    const user = await makeUser('two@example.com');
    const first = await createApiKey({ referenceId: user.id });
    const second = await createApiKey({ referenceId: user.id });
    expect(first.key).not.toBe(second.key);
    expect(await listApiKeys(user.id)).toHaveLength(2);
  });
});

describe('verifyApiKey', () => {
  it('resolves a valid key to its account and counts the use', async () => {
    const user = await makeUser('valid@example.com');
    const created = await createApiKey({ referenceId: user.id });

    const principal = await verifyApiKey(created.key);
    expect(principal?.user.id).toBe(user.id);

    // The counters are written after the answer, so give them a beat.
    await Bun.sleep(50);
    const [stored] = await listApiKeys(user.id);
    expect(stored!.requestCount).toBe(1);
    expect(stored!.lastRequestAt).not.toBeNull();
  });

  it('refuses nonsense, a near miss, and an empty value', async () => {
    const user = await makeUser('refuse@example.com');
    const created = await createApiKey({ referenceId: user.id });

    expect(await verifyApiKey('itsa_not-a-real-key')).toBeNull();
    expect(await verifyApiKey(`${created.key}x`)).toBeNull();
    expect(await verifyApiKey(created.key.slice(0, -1))).toBeNull();
    expect(await verifyApiKey('')).toBeNull();
    expect(await verifyApiKey(null)).toBeNull();
  });

  it('refuses a revoked key, an expired key, and a deactivated owner', async () => {
    const user = await makeUser('states@example.com');

    const revoked = await createApiKey({ referenceId: user.id });
    expect(await revokeApiKey(user.id, revoked.id)).toBe(true);
    expect(await verifyApiKey(revoked.key)).toBeNull();

    const expired = await createApiKey({
      referenceId: user.id,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await verifyApiKey(expired.key)).toBeNull();

    const live = await createApiKey({ referenceId: user.id });
    expect(await verifyApiKey(live.key)).not.toBeNull();
    await setActive(user.id, false);
    expect(await verifyApiKey(live.key)).toBeNull();
  });

  it('will not let one account revoke another account key', async () => {
    const owner = await makeUser('owner@example.com');
    const other = await makeUser('other@example.com');
    const key = await createApiKey({ referenceId: owner.id });

    expect(await revokeApiKey(other.id, key.id)).toBe(false);
    expect(await verifyApiKey(key.key)).not.toBeNull();
  });
});

describe('rotateApiKey', () => {
  it('issues a new key and kills every previous one', async () => {
    const user = await makeUser('rotate@example.com');
    const first = await createApiKey({ referenceId: user.id });
    const second = await createApiKey({ referenceId: user.id });

    const rotated = await rotateApiKey({ referenceId: user.id, name: 'rotated' });

    expect(await verifyApiKey(first.key)).toBeNull();
    expect(await verifyApiKey(second.key)).toBeNull();
    expect((await verifyApiKey(rotated.key))?.user.id).toBe(user.id);
    expect(await listApiKeys(user.id)).toHaveLength(1);
  });
});

describe('over HTTP', () => {
  it('authenticates a request as x-api-key and as a bearer token', async () => {
    const user = await makeUser('http@example.com');
    const created = await createApiKey({ referenceId: user.id });

    expect(await callWithKey(created.key)).toBe(200);
    expect(await callWithKey(created.key, 'authorization')).toBe(200);
  });

  it('answers 401 once the key is gone', async () => {
    const user = await makeUser('gone@example.com');
    const created = await createApiKey({ referenceId: user.id });
    expect(await callWithKey(created.key)).toBe(200);

    await deleteApiKeysFor(user.id);
    expect(await callWithKey(created.key)).toBe(401);
  });
});

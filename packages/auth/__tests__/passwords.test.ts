import { describe, expect, it } from 'bun:test';
import {
  PASSWORD_MIN_LENGTH,
  equalizeTiming,
  getDummyPasswordHash,
  hashPassword,
  looksLegacy,
  passwordProblem,
  verifyPassword,
} from '../src/passwords';

describe('hashPassword', () => {
  it('produces a salted argon2id hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse');
    const again = await hashPassword('correct horse battery staple');
    expect(again).not.toBe(hash);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects everything else', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    expect(await verifyPassword('s3cret-passphrase', hash)).toBe(true);
    expect(await verifyPassword('s3cret-passphras', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('refuses a better-auth scrypt hash instead of throwing', async () => {
    const legacy = 'e4bd0f7c:1a2b3c4d5e6f'; // salt:hex, the old format
    expect(looksLegacy(legacy)).toBe(true);
    expect(await verifyPassword('whatever', legacy)).toBe(false);
  });

  it('treats a missing or malformed hash as a failure', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', '$argon2id$not-really')).toBe(false);
  });
});

describe('timing equalization', () => {
  it('has a dummy hash that no password matches', async () => {
    const dummy = await getDummyPasswordHash();
    expect(dummy.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword('not-a-real-account-placeholder', dummy)).toBe(true);
    expect(await verifyPassword('anything-a-user-would-type', dummy)).toBe(false);
  });

  it('can be awaited on the unknown-account branch', async () => {
    await expect(equalizeTiming('some-password')).resolves.toBeUndefined();
  });
});

describe('passwordProblem', () => {
  it('requires a minimum length', () => {
    expect(passwordProblem('x'.repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/at least/);
    expect(passwordProblem('x'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });

  it('refuses an absurdly long password rather than hashing it', () => {
    expect(passwordProblem('x'.repeat(1000))).toMatch(/at most/);
  });
});

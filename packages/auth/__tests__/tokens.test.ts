import { describe, expect, it } from 'bun:test';
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  hashSessionToken,
  readCookie,
  secretsMatch,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionAbsoluteExpiry,
  sessionIdleCutoff,
} from '../src/tokens';

describe('session tokens', () => {
  it('mints unguessable tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, createSessionToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      // 32 bytes of base64url, no padding.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('hashes deterministically and irreversibly', () => {
    const token = createSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it('puts the absolute expiry 90 days out and the idle cutoff 30 days back', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(sessionAbsoluteExpiry(now).toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(sessionIdleCutoff(now).toISOString()).toBe('2025-12-02T00:00:00.000Z');
  });
});

describe('cookies', () => {
  it('reads one cookie out of a header', () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=abc.def; other=1`;
    expect(readCookie(header, SESSION_COOKIE_NAME)).toBe('abc.def');
    expect(readCookie(header, 'missing')).toBeNull();
    expect(readCookie(null, SESSION_COOKIE_NAME)).toBeNull();
  });

  it('serializes a secure host-only cookie', () => {
    const cookie = serializeSessionCookie('tok', new Date(Date.UTC(2026, 0, 1)), {
      secure: true,
      domain: null,
    });
    expect(cookie).toBe(
      `${SESSION_COOKIE_NAME}=tok; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=Thu, 01 Jan 2026 00:00:00 GMT`,
    );
  });

  it('adds a domain only when one is configured', () => {
    const cookie = serializeSessionCookie('tok', new Date(0), {
      secure: false,
      domain: '.example.com',
    });
    expect(cookie).toContain('Domain=.example.com');
    expect(cookie).not.toContain('Secure');
  });

  it('clears with the same attributes so the browser matches the cookie', () => {
    const cleared = serializeClearedSessionCookie({ secure: true, domain: null });
    expect(cleared).toBe(
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
    );
  });
});

describe('secretsMatch', () => {
  it('compares equal and unequal values of any length', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('short', 'a much longer value')).toBe(false);
    expect(secretsMatch('', '')).toBe(true);
  });
});

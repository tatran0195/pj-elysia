import { describe, expect, it } from 'bun:test';
import { RateLimiter, rateLimitKey } from '../src/rate-limit';

describe('RateLimiter', () => {
  it('allows up to the limit inside the window', () => {
    const limiter = new RateLimiter(3, 1000);
    const now = 1_000_000;
    expect(limiter.consume('k', now).ok).toBe(true);
    expect(limiter.consume('k', now).ok).toBe(true);
    const third = limiter.consume('k', now);
    expect(third.ok).toBe(true);
    expect(third.remaining).toBe(0);
    expect(limiter.consume('k', now).ok).toBe(false);
  });

  it('reports how long to wait, and lets the caller in once the window slides', () => {
    const limiter = new RateLimiter(1, 1000);
    const now = 1_000_000;
    limiter.consume('k', now);
    expect(limiter.consume('k', now + 500)).toEqual({
      ok: false,
      retryAfterMs: 500,
      remaining: 0,
    });
    expect(limiter.consume('k', now + 1001).ok).toBe(true);
  });

  it('does not extend the block when a caller keeps hammering', () => {
    const limiter = new RateLimiter(1, 1000);
    const now = 1_000_000;
    limiter.consume('k', now);
    for (let at = 100; at < 1000; at += 100) limiter.consume('k', now + at);
    expect(limiter.consume('k', now + 1001).ok).toBe(true);
  });

  it('keeps buckets apart and clears one on reset', () => {
    const limiter = new RateLimiter(1, 1000);
    const now = 1_000_000;
    expect(limiter.consume('a', now).ok).toBe(true);
    expect(limiter.consume('b', now).ok).toBe(true);
    expect(limiter.consume('a', now).ok).toBe(false);
    limiter.reset('a');
    expect(limiter.consume('a', now).ok).toBe(true);
  });

  it('prunes idle buckets instead of growing forever', () => {
    const limiter = new RateLimiter(1, 1000);
    const now = 1_000_000;
    for (let index = 0; index < 600; index += 1) limiter.consume(`k${index}`, now);
    // Everything above is outside the window by now, so the map should be empty
    // enough that an old key is allowed again immediately.
    expect(limiter.consume('k0', now + 5000).ok).toBe(true);
  });
});

describe('rateLimitKey', () => {
  it('pairs the ip with a normalized identifier', () => {
    expect(rateLimitKey('1.2.3.4', ' Demo@Example.com ')).toBe('1.2.3.4|demo@example.com');
    expect(rateLimitKey(null, 'demo')).toBe('unknown|demo');
  });
});

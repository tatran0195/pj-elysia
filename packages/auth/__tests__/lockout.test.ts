import { describe, expect, it } from 'bun:test';
import {
  LOCKOUT_CAP_MS,
  LOCKOUT_INITIAL_MS,
  LOCKOUT_THRESHOLD,
  clearedLockout,
  lockStatus,
  registerFailure,
  retryAfterSeconds,
} from '../src/lockout';

const now = Date.UTC(2026, 0, 1);

describe('lockStatus', () => {
  it('is unlocked with no lock, or once the lock has elapsed', () => {
    expect(lockStatus({ failedLoginCount: 4, lockedUntil: null }, now).locked).toBe(false);
    expect(lockStatus({ failedLoginCount: 9, lockedUntil: new Date(now - 1) }, now).locked).toBe(
      false,
    );
  });

  it('reports the remaining wait while locked', () => {
    const status = lockStatus({ failedLoginCount: 5, lockedUntil: new Date(now + 60_000) }, now);
    expect(status).toEqual({ locked: true, retryAfterMs: 60_000 });
  });
});

describe('registerFailure', () => {
  it('counts without locking below the threshold', () => {
    for (let count = 0; count < LOCKOUT_THRESHOLD - 1; count += 1) {
      const decision = registerFailure({ failedLoginCount: count, lockedUntil: null }, now);
      expect(decision.triggered).toBe(false);
      expect(decision.lockedUntil).toBeNull();
      expect(decision.failedLoginCount).toBe(count + 1);
    }
  });

  it('locks for 15 minutes on the fifth failure', () => {
    const decision = registerFailure({ failedLoginCount: 4, lockedUntil: null }, now);
    expect(decision.triggered).toBe(true);
    expect(decision.lockedUntil?.getTime()).toBe(now + LOCKOUT_INITIAL_MS);
  });

  it('doubles each further lockout and caps at 24 hours', () => {
    const durations = [1, 2, 3, 4, 5, 6, 7, 8].map((cycle) => {
      const decision = registerFailure(
        { failedLoginCount: cycle * LOCKOUT_THRESHOLD - 1, lockedUntil: null },
        now,
      );
      return decision.lockedUntil!.getTime() - now;
    });
    expect(durations).toEqual([
      LOCKOUT_INITIAL_MS,
      LOCKOUT_INITIAL_MS * 2,
      LOCKOUT_INITIAL_MS * 4,
      LOCKOUT_INITIAL_MS * 8,
      LOCKOUT_INITIAL_MS * 16,
      LOCKOUT_INITIAL_MS * 32,
      LOCKOUT_INITIAL_MS * 64, // 16 h, still under the cap
      LOCKOUT_CAP_MS, // would be 32 h, capped at 24
    ]);
  });
});

describe('clearedLockout', () => {
  it('resets both fields after a success', () => {
    expect(clearedLockout()).toEqual({ failedLoginCount: 0, lockedUntil: null });
  });
});

describe('retryAfterSeconds', () => {
  it('rounds up and never returns zero', () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1500)).toBe(2);
    expect(retryAfterSeconds(60_000)).toBe(60);
  });
});

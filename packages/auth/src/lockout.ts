// Per-account lockout, the second half of the brute-force defence.
//
// The rate limiter next door slows one attacker down; it cannot stop a
// distributed attempt at a single account, because every source IP gets its own
// bucket. This does: after five consecutive failures the account itself is locked
// for a window that doubles each time, capped at a day.
//
// Everything here is pure. Persisting `failed_login_count` / `locked_until` is the
// caller's job (see users.ts), which keeps the policy trivially testable.

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_INITIAL_MS = 15 * 60 * 1000;
export const LOCKOUT_CAP_MS = 24 * 60 * 60 * 1000;

export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface LockoutDecision {
  // True when this failure crosses the threshold and the caller should persist
  // `lockedUntil`.
  triggered: boolean;
  lockedUntil: Date | null;
  // The count to store after this attempt.
  failedLoginCount: number;
}

// Whether a sign-in attempt may proceed at all.
export function lockStatus(
  state: LockoutState,
  now = Date.now(),
): { locked: boolean; retryAfterMs: number } {
  const until = state.lockedUntil?.getTime() ?? 0;
  if (until <= now) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: until - now };
}

// Applied after a failed attempt. Every `LOCKOUT_THRESHOLD` failures triggers a
// lock, and each successive lock doubles: 15 min, 30, 60, … capped at 24 h. The
// cap matters — an account that stays locked forever is a denial of service
// against its owner, not a defence.
export function registerFailure(state: LockoutState, now = Date.now()): LockoutDecision {
  const failedLoginCount = state.failedLoginCount + 1;
  if (failedLoginCount % LOCKOUT_THRESHOLD !== 0) {
    return { triggered: false, lockedUntil: null, failedLoginCount };
  }
  const cycle = failedLoginCount / LOCKOUT_THRESHOLD; // 1, 2, 3, …
  const duration = Math.min(LOCKOUT_INITIAL_MS * 2 ** (cycle - 1), LOCKOUT_CAP_MS);
  return {
    triggered: true,
    lockedUntil: new Date(now + duration),
    failedLoginCount,
  };
}

// A successful sign-in clears both fields.
export function clearedLockout(): LockoutState {
  return { failedLoginCount: 0, lockedUntil: null };
}

// Seconds for a `Retry-After` header. Rounded up, never below one.
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

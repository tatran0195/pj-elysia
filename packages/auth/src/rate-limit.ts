// Sliding-window rate limiter, in process.
//
// Guards the endpoints where a guess is cheap: sign-in, password reset requests,
// magic links, MFA codes. The bucket key pairs the client IP with the identifier
// being attacked, so one IP cannot spray many accounts and one account cannot be
// ground down from many IPs without also tripping the per-account lockout.
//
// In process rather than Redis or a table: the api is a single Bun process here,
// the endpoints it protects are low-traffic, and losing the counters on restart
// only costs an attacker the same window again. If the api is ever run as several
// replicas this needs a shared store — the interface is small enough to swap.

export interface RateLimitDecision {
  ok: boolean;
  // Milliseconds until the oldest attempt in the window falls out. Zero when ok.
  retryAfterMs: number;
  remaining: number;
}

interface Bucket {
  // Attempt timestamps, oldest first.
  attempts: number[];
}

// Full prune every N calls, or as soon as the map is this big — so keys an
// attacker can invent (one per address they try) cannot grow it without bound.
const PRUNE_INTERVAL = 500;
const PRUNE_SIZE_THRESHOLD = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private callsSincePrune = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  // Records an attempt and says whether it is allowed. Call once per attempt, on
  // the way in — a blocked call is not recorded, so a client that keeps hammering
  // during a block does not extend it.
  consume(key: string, now = Date.now()): RateLimitDecision {
    this.maybePrune(now);
    const cutoff = now - this.windowMs;
    const bucket = this.buckets.get(key) ?? { attempts: [] };
    const attempts = bucket.attempts.filter((at) => at > cutoff);

    if (attempts.length >= this.limit) {
      bucket.attempts = attempts;
      this.buckets.set(key, bucket);
      const oldest = attempts[0] ?? now;
      return { ok: false, retryAfterMs: Math.max(1, oldest + this.windowMs - now), remaining: 0 };
    }

    attempts.push(now);
    bucket.attempts = attempts;
    this.buckets.set(key, bucket);
    return { ok: true, retryAfterMs: 0, remaining: this.limit - attempts.length };
  }

  // Clears a key after a success, so a user who mistyped twice and then got in is
  // not still one attempt from a block.
  reset(key: string): void {
    this.buckets.delete(key);
  }

  // Forgets every key. Used by the test harness between cases; production never
  // wants this.
  clear(): void {
    this.buckets.clear();
    this.callsSincePrune = 0;
  }

  private maybePrune(now: number): void {
    this.callsSincePrune += 1;
    if (this.callsSincePrune < PRUNE_INTERVAL && this.buckets.size < PRUNE_SIZE_THRESHOLD) return;
    this.callsSincePrune = 0;
    const cutoff = now - this.windowMs;
    for (const [key, bucket] of this.buckets) {
      const attempts = bucket.attempts.filter((at) => at > cutoff);
      if (attempts.length === 0) this.buckets.delete(key);
      else bucket.attempts = attempts;
    }
  }
}

// The limiters the auth routes use. Named per surface so one being tripped does
// not block the others.
export const signInLimiter = new RateLimiter(10, 15 * 60 * 1000);
export const mfaLimiter = new RateLimiter(10, 5 * 60 * 1000);
export const passwordResetLimiter = new RateLimiter(5, 60 * 60 * 1000);
export const signUpLimiter = new RateLimiter(10, 60 * 60 * 1000);
// Emailed links: each one is a mail, so the budget is the password reset's.
export const magicLinkLimiter = new RateLimiter(5, 60 * 60 * 1000);

// Bucket key. The identifier is lowercased so casing variants share a bucket.
// Clears every limiter. The windows are process state, so an integration test
// that truncates the database still inherits the counters of the test before it —
// this is what resetDb calls to start clean. Never called in production.
export function resetRateLimiters(): void {
  for (const limiter of [
    signInLimiter,
    mfaLimiter,
    passwordResetLimiter,
    signUpLimiter,
    magicLinkLimiter,
  ]) {
    limiter.clear();
  }
}

export function rateLimitKey(ip: string | null, identifier: string): string {
  return `${ip ?? 'unknown'}|${identifier.trim().toLowerCase()}`;
}

// Password hashing.
//
// argon2id through Bun's built-in `Bun.password`, which is why this package is
// only ever imported by the api (Bun) and never by the web server (Node).
//
// There is no compatibility path for the scrypt hashes better-auth wrote: the
// replacement is a clean break, so every account is created fresh or goes through
// a password reset. `looksLegacy` exists to tell a stale row apart from a current
// one and refuse it with a clear message instead of a confusing "wrong password".

const ARGON2ID = { algorithm: 'argon2id' } as const;

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON2ID);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || looksLegacy(hash)) return false;
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    // A malformed hash is a failed verification, not a 500.
    return false;
  }
}

// better-auth stored `<salt>:<hex>`; every hash this package writes is a PHC string
// starting with `$argon2id$`.
export function looksLegacy(hash: string): boolean {
  return !hash.startsWith('$argon2');
}

// A fixed hash to verify against when no account matched, so the "unknown email"
// branch costs the same as the "wrong password" branch and cannot be told apart by
// timing. Computed once, eagerly, so the first unknown-email login does not pay for
// it and stand out as the slow one.
const dummyHash: Promise<string> = hashPassword('not-a-real-account-placeholder');

export function getDummyPasswordHash(): Promise<string> {
  return dummyHash;
}

// Burns the same work as a real verification on a branch that has already failed.
export async function equalizeTiming(password: string): Promise<void> {
  await verifyPassword(password, await dummyHash);
}

// Minimum length only. Composition rules ("one digit, one symbol") push people
// towards predictable substitutions; length is what actually helps, and the
// lockout policy covers the rest.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 512;

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

import { randomUUID } from 'node:crypto';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import { db, aiAgent, user as userTable } from '@repo/db';
import { hashPassword, verifyPassword } from './passwords';
import { clearedLockout, registerFailure, type LockoutState } from './lockout';
import { DEFAULT_STEP_UP_MODE, type StepUpMode } from './step-up';

// The user side of authentication: looking an account up by whatever was typed in
// the one sign-in field, creating one, and the bookkeeping that surrounds a
// sign-in attempt (failure counters, lockouts, password changes).
//
// Everything the app needs about the signed-in person is in `AuthUser`; the secret
// material (password hash, MFA secret, recovery codes) is loaded only by the
// functions that have to compare against it, so it cannot leak into a response by
// riding along on an object that happens to be serialized.

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  username: string | null;
  displayUsername: string | null;
  role: string;
  active: boolean;
  mfaEnabled: boolean;
  stepUpMode: StepUpMode;
  stepUpWindowMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

// The column list every session lookup selects. Kept in one place so the joined
// query in sessions.ts and the plain lookups here cannot drift apart.
export const AUTH_USER_COLUMNS = {
  id: userTable.id,
  name: userTable.name,
  email: userTable.email,
  emailVerified: userTable.emailVerified,
  image: userTable.image,
  username: userTable.username,
  displayUsername: userTable.displayUsername,
  role: userTable.role,
  active: userTable.active,
  mfaEnabled: userTable.mfaEnabled,
  stepUpMode: userTable.stepUpMode,
  stepUpWindowMinutes: userTable.stepUpWindowMinutes,
  createdAt: userTable.createdAt,
  updatedAt: userTable.updatedAt,
} as const;

export interface AuthUserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  username: string | null;
  displayUsername: string | null;
  role: string | null;
  active: boolean | null;
  mfaEnabled: boolean;
  stepUpMode: string;
  stepUpWindowMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

export function rowToAuthUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image,
    username: row.username,
    displayUsername: row.displayUsername,
    role: row.role ?? 'user',
    active: row.active ?? true,
    mfaEnabled: row.mfaEnabled,
    stepUpMode: (row.stepUpMode as StepUpMode) ?? DEFAULT_STEP_UP_MODE,
    stepUpWindowMinutes: row.stepUpWindowMinutes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// What the sign-in handler needs, and nothing else gets to see.
export interface CredentialRecord {
  user: AuthUser;
  passwordHash: string | null;
  lockout: LockoutState;
}

// The sign-in field takes an address or a username, so the lookup does too.
// Matching is case-insensitive on both: addresses are, and a username that only
// differs in case is not a different person.
export async function findCredentialByIdentifier(
  identifier: string,
): Promise<CredentialRecord | null> {
  const normalized = identifier.trim().toLowerCase();
  if (!normalized) return null;
  const rows = await db
    .select({
      ...AUTH_USER_COLUMNS,
      passwordHash: userTable.passwordHash,
      failedLoginCount: userTable.failedLoginCount,
      lockedUntil: userTable.lockedUntil,
    })
    .from(userTable)
    .where(
      or(
        eq(sql`lower(${userTable.email})`, normalized),
        eq(sql`lower(${userTable.username})`, normalized),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    user: rowToAuthUser(row),
    passwordHash: row.passwordHash,
    lockout: { failedLoginCount: row.failedLoginCount, lockedUntil: row.lockedUntil },
  };
}

export async function findUserById(id: string): Promise<AuthUser | null> {
  const rows = await db
    .select(AUTH_USER_COLUMNS)
    .from(userTable)
    .where(eq(userTable.id, id))
    .limit(1);
  return rows[0] ? rowToAuthUser(rows[0]) : null;
}

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const rows = await db
    .select(AUTH_USER_COLUMNS)
    .from(userTable)
    .where(eq(sql`lower(${userTable.email})`, email.trim().toLowerCase()))
    .limit(1);
  return rows[0] ? rowToAuthUser(rows[0]) : null;
}

export interface CreateUserInput {
  name: string;
  email: string;
  password?: string | null;
  username?: string | null;
  role?: string;
  emailVerified?: boolean;
  image?: string | null;
}

export async function createUser(input: CreateUserInput): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase();
  const username = input.username ?? (await deriveUsername(email));
  const rows = await db
    .insert(userTable)
    .values({
      id: randomUUID(),
      name: input.name.trim() || email,
      email,
      emailVerified: input.emailVerified ?? false,
      image: input.image ?? null,
      username,
      displayUsername: username,
      role: input.role ?? 'user',
      passwordHash: input.password ? await hashPassword(input.password) : null,
      passwordChangedAt: input.password ? new Date() : null,
    })
    .returning(AUTH_USER_COLUMNS);
  return rowToAuthUser(rows[0]!);
}

// A mention resolves against members and agents at once, so the two share one
// namespace: a handle an agent already answers to is taken, even though it is not
// a row in `user`.
export async function usernameHeldByAgent(username: string): Promise<boolean> {
  return (await db.$count(aiAgent, eq(sql`lower(${aiAgent.username})`, username))) > 0;
}

// Nobody is asked for a username at sign-up. It comes from the local part of the
// address, stripped of anything the format does not allow, with a counter appended
// until it is free — so existing links and mentions keep making sense.
export async function deriveUsername(email: string): Promise<string> {
  const base =
    email
      .split('@')[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 24) || 'user';
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}${suffix}`;
    const taken =
      (await db.$count(userTable, eq(sql`lower(${userTable.username})`, candidate))) > 0 ||
      (await usernameHeldByAgent(candidate));
    if (!taken) return candidate;
  }
  // A thousand collisions on one local part means something is wrong; a random
  // suffix is still better than failing the sign-up.
  return `${base}${randomUUID().slice(0, 8)}`;
}

export async function isUsernameTaken(username: string, exceptUserId?: string): Promise<boolean> {
  const normalized = username.trim().toLowerCase();
  const where = exceptUserId
    ? and(eq(sql`lower(${userTable.username})`, normalized), ne(userTable.id, exceptUserId))
    : eq(sql`lower(${userTable.username})`, normalized);
  if ((await db.$count(userTable, where)) > 0) return true;
  return usernameHeldByAgent(normalized);
}

// The format the mention parser can round-trip: letters, digits, dot, dash,
// underscore, 3-30 characters.
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_.-]{1,28})[a-z0-9]$/;

export function usernameProblem(username: string): string | null {
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) {
    return 'A username is 3 to 30 characters: letters, digits, dot, dash or underscore.';
  }
  return null;
}

export async function setUsername(userId: string, username: string): Promise<void> {
  const normalized = username.trim().toLowerCase();
  await db
    .update(userTable)
    .set({ username: normalized, displayUsername: username.trim() })
    .where(eq(userTable.id, userId));
}

// The parts of the profile the account owns. `image` is nullable on purpose:
// clearing an avatar is a legitimate edit, so undefined (leave alone) and null
// (remove) have to mean different things.
export async function updateProfile(
  userId: string,
  input: { name?: string; image?: string | null },
): Promise<void> {
  const patch: { name?: string; image?: string | null } = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.image !== undefined) patch.image = input.image;
  if (Object.keys(patch).length === 0) return;
  await db.update(userTable).set(patch).where(eq(userTable.id, userId));
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await db
    .update(userTable)
    .set({
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
      ...clearedLockout(),
    })
    .where(eq(userTable.id, userId));
}

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const rows = await db
    .select({ passwordHash: userTable.passwordHash })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  const hash = rows[0]?.passwordHash;
  if (!hash) return false;
  return verifyPassword(password, hash);
}

// Called after a failed sign-in. Returns whether this attempt locked the account,
// so the handler can say "too many attempts" instead of "wrong password" — the
// account is locked either way, and pretending otherwise just wastes the user's
// time.
export async function recordFailedLogin(
  userId: string,
  state: LockoutState,
  now = Date.now(),
): Promise<{ locked: boolean; lockedUntil: Date | null }> {
  const decision = registerFailure(state, now);
  await db
    .update(userTable)
    .set({
      failedLoginCount: decision.failedLoginCount,
      ...(decision.triggered ? { lockedUntil: decision.lockedUntil } : {}),
    })
    .where(eq(userTable.id, userId));
  return { locked: decision.triggered, lockedUntil: decision.lockedUntil };
}

export async function clearLoginFailures(userId: string): Promise<void> {
  await db.update(userTable).set(clearedLockout()).where(eq(userTable.id, userId));
}

export async function markEmailVerified(userId: string): Promise<void> {
  await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, userId));
}

export async function setActive(userId: string, active: boolean): Promise<void> {
  await db.update(userTable).set({ active }).where(eq(userTable.id, userId));
}

// --- second factor ---------------------------------------------------------

export interface MfaSecretRecord {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyFingerprint: string;
  recoveryCodeHashes: string[];
  enabled: boolean;
}

export async function getMfaRecord(userId: string): Promise<MfaSecretRecord | null> {
  const rows = await db
    .select({
      enabled: userTable.mfaEnabled,
      ciphertext: userTable.mfaSecretCiphertext,
      iv: userTable.mfaSecretIv,
      authTag: userTable.mfaSecretAuthTag,
      keyFingerprint: userTable.mfaSecretKeyFingerprint,
      recoveryCodeHashes: userTable.mfaRecoveryCodeHashes,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row?.ciphertext || !row.iv || !row.authTag || !row.keyFingerprint) return null;
  return {
    enabled: row.enabled,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    keyFingerprint: row.keyFingerprint,
    recoveryCodeHashes: row.recoveryCodeHashes ?? [],
  };
}

// Stored but not yet enabled: the secret has to survive between showing the QR
// code and the user proving they scanned it.
export async function stageMfaSecret(
  userId: string,
  secret: { ciphertext: string; iv: string; authTag: string; keyFingerprint: string },
): Promise<void> {
  await db
    .update(userTable)
    .set({
      mfaEnabled: false,
      mfaEnabledAt: null,
      mfaSecretCiphertext: secret.ciphertext,
      mfaSecretIv: secret.iv,
      mfaSecretAuthTag: secret.authTag,
      mfaSecretKeyFingerprint: secret.keyFingerprint,
      mfaRecoveryCodeHashes: [],
    })
    .where(eq(userTable.id, userId));
}

export async function enableMfa(userId: string, recoveryCodeHashes: string[]): Promise<void> {
  await db
    .update(userTable)
    .set({ mfaEnabled: true, mfaEnabledAt: new Date(), mfaRecoveryCodeHashes: recoveryCodeHashes })
    .where(eq(userTable.id, userId));
}

export async function disableMfa(userId: string): Promise<void> {
  await db
    .update(userTable)
    .set({
      mfaEnabled: false,
      mfaEnabledAt: null,
      mfaSecretCiphertext: null,
      mfaSecretIv: null,
      mfaSecretAuthTag: null,
      mfaSecretKeyFingerprint: null,
      mfaRecoveryCodeHashes: null,
    })
    .where(eq(userTable.id, userId));
}

export async function setRecoveryCodeHashes(userId: string, hashes: string[]): Promise<void> {
  await db.update(userTable).set({ mfaRecoveryCodeHashes: hashes }).where(eq(userTable.id, userId));
}

export async function setStepUpPreferences(
  userId: string,
  input: { mode?: StepUpMode; windowMinutes?: number },
): Promise<void> {
  await db
    .update(userTable)
    .set({
      ...(input.mode ? { stepUpMode: input.mode } : {}),
      ...(input.windowMinutes ? { stepUpWindowMinutes: input.windowMinutes } : {}),
    })
    .where(eq(userTable.id, userId));
}

// True while the instance has no account at all. The first sign-up on an empty
// instance becomes its administrator — the alternative is a bootstrap password in
// the environment, which then lives forever in a deployment config.
export async function instanceHasNoUsers(): Promise<boolean> {
  return (await db.$count(userTable)) === 0;
}

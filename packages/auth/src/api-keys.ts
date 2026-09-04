import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, apikey, user as userTable } from '@repo/db';
import { AUTH_USER_COLUMNS, rowToAuthUser, type AuthUser } from './users';

// API keys: how an agent, a runner or a script authenticates without a browser.
//
// A key is a high-entropy random string, so it needs no password hashing — but it
// is stored the same way a session token is: SHA-256 only. The plaintext exists
// once, in the response that creates it. That is why the UI has to show it then
// and why "lost the key" means "issue a new one".
//
// The visible prefix is the compromise that makes them manageable: enough of the
// key to recognise it in a list, not enough to use it.

// Identifies our keys on sight — in a log, in a leaked config, in a secret
// scanner's ruleset.
const KEY_PREFIX = 'itsa';
const KEY_BYTES = 32;
// How much of the key the UI may keep. Short enough to be useless on its own.
const VISIBLE_START_LENGTH = 8;

export interface ApiKeyRecord {
  id: string;
  name: string | null;
  start: string | null;
  referenceId: string;
  enabled: boolean;
  expiresAt: Date | null;
  lastRequestAt: Date | null;
  requestCount: number;
  createdAt: Date;
}

export interface CreatedApiKey extends ApiKeyRecord {
  // The one and only time the caller sees this.
  key: string;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function createApiKey(input: {
  // The account the key acts as: a person, or an agent's bot user.
  referenceId: string;
  name?: string | null;
  expiresAt?: Date | null;
  permissions?: string | null;
  metadata?: string | null;
}): Promise<CreatedApiKey> {
  const secret = randomBytes(KEY_BYTES).toString('base64url');
  const key = `${KEY_PREFIX}_${secret}`;
  const rows = await db
    .insert(apikey)
    .values({
      id: randomUUID(),
      referenceId: input.referenceId,
      name: input.name ?? null,
      start: secret.slice(0, VISIBLE_START_LENGTH),
      keyHash: hashKey(key),
      enabled: true,
      expiresAt: input.expiresAt ?? null,
      permissions: input.permissions ?? null,
      metadata: input.metadata ?? null,
    })
    .returning(API_KEY_COLUMNS);
  return { ...rows[0]!, key };
}

export interface ApiKeyPrincipal {
  user: AuthUser;
  apiKeyId: string;
}

// Resolves a key to the account it acts as, or null. Everything that makes a key
// unusable is in the one query: disabled, expired, or a deactivated owner.
//
// The usage counters are updated after the answer is decided, and a failure to
// write them is swallowed — bookkeeping must not be able to refuse a valid key.
export async function verifyApiKey(
  key: string | null | undefined,
  now = Date.now(),
): Promise<ApiKeyPrincipal | null> {
  if (!key) return null;
  const rows = await db
    .select({ ...AUTH_USER_COLUMNS, apiKeyId: apikey.id, keyHash: apikey.keyHash })
    .from(apikey)
    .innerJoin(userTable, eq(userTable.id, apikey.referenceId))
    .where(
      and(
        eq(apikey.keyHash, hashKey(key)),
        eq(apikey.enabled, true),
        or(isNull(apikey.expiresAt), gt(apikey.expiresAt, new Date(now))),
        eq(userTable.active, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // The index lookup already matched, so this is belt and braces against a
  // future where the column is compared some other way.
  if (!constantTimeEquals(row.keyHash, hashKey(key))) return null;

  void recordUse(row.apiKeyId, now);
  return { user: rowToAuthUser(row), apiKeyId: row.apiKeyId };
}

export async function listApiKeys(referenceId: string): Promise<ApiKeyRecord[]> {
  return db
    .select(API_KEY_COLUMNS)
    .from(apikey)
    .where(eq(apikey.referenceId, referenceId))
    .orderBy(desc(apikey.createdAt));
}

// Disabled rather than deleted, so a key that turns up in a log later can still
// be identified. `deleteApiKeysFor` is the hard version, used when the account
// itself goes away.
export async function revokeApiKey(referenceId: string, id: string): Promise<boolean> {
  const revoked = await db
    .update(apikey)
    .set({ enabled: false })
    .where(and(eq(apikey.id, id), eq(apikey.referenceId, referenceId), eq(apikey.enabled, true)))
    .returning({ id: apikey.id });
  return revoked.length > 0;
}

export async function deleteApiKeysFor(referenceId: string): Promise<number> {
  const deleted = await db
    .delete(apikey)
    .where(eq(apikey.referenceId, referenceId))
    .returning({ id: apikey.id });
  return deleted.length;
}

// Replaces every key an account holds with one new key. What "rotate" means for an
// agent: the old secret stops working the moment the new one is handed over.
export async function rotateApiKey(input: {
  referenceId: string;
  name?: string | null;
}): Promise<CreatedApiKey> {
  await deleteApiKeysFor(input.referenceId);
  return createApiKey(input);
}

const API_KEY_COLUMNS = {
  id: apikey.id,
  name: apikey.name,
  start: apikey.start,
  referenceId: apikey.referenceId,
  enabled: apikey.enabled,
  expiresAt: apikey.expiresAt,
  lastRequestAt: apikey.lastRequestAt,
  requestCount: apikey.requestCount,
  createdAt: apikey.createdAt,
} as const;

async function recordUse(id: string, now: number): Promise<void> {
  try {
    await db
      .update(apikey)
      .set({ lastRequestAt: new Date(now), requestCount: sql`${apikey.requestCount} + 1` })
      .where(eq(apikey.id, id));
  } catch (error) {
    console.error('auth: failed to record API key use', error);
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

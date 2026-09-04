import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db, account } from '@repo/db';

// Linked identities: the rows in `account` that tie a user to an external
// provider (Google, the instance's OIDC provider). The password is *not* here —
// it lives on the user row — but the profile screens still talk about a
// "credential" provider, so `listLinkedProviders` synthesises one for accounts
// that have a password.
//
// Tokens from the provider are stored because the OIDC group sync reads the
// `groups` claim off the last ID token. Nothing here refreshes them: this app
// only ever needs the provider at sign-in.

export const GOOGLE_PROVIDER_ID = 'google';
export const OIDC_PROVIDER_ID = 'oidc';
export const CREDENTIAL_PROVIDER_ID = 'credential';

export interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
  createdAt: Date;
}

export async function findAccountByProvider(
  providerId: string,
  accountId: string,
): Promise<{ id: string; userId: string } | null> {
  const rows = await db
    .select({ id: account.id, userId: account.userId })
    .from(account)
    .where(and(eq(account.providerId, providerId), eq(account.accountId, accountId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertAccountInput {
  userId: string;
  providerId: string;
  accountId: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scope?: string | null;
}

// Creates the link, or refreshes the tokens on an existing one. Called on every
// successful callback so the stored ID token is the latest.
export async function upsertAccount(input: UpsertAccountInput): Promise<{ id: string; created: boolean }> {
  const existing = await findAccountByProvider(input.providerId, input.accountId);
  const tokens = {
    accessToken: input.accessToken ?? null,
    refreshToken: input.refreshToken ?? null,
    idToken: input.idToken ?? null,
    accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
    scope: input.scope ?? null,
  };
  if (existing) {
    if (existing.userId !== input.userId) {
      throw new Error('This external account is already linked to another user');
    }
    await db.update(account).set(tokens).where(eq(account.id, existing.id));
    return { id: existing.id, created: false };
  }
  const id = randomUUID();
  await db.insert(account).values({
    id,
    userId: input.userId,
    providerId: input.providerId,
    accountId: input.accountId,
    ...tokens,
  });
  return { id, created: true };
}

export async function listLinkedAccounts(userId: string): Promise<LinkedAccount[]> {
  return db
    .select({
      id: account.id,
      providerId: account.providerId,
      accountId: account.accountId,
      createdAt: account.createdAt,
    })
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(account.createdAt);
}

// The latest ID token a provider gave for this user, or null.
export async function latestIdToken(userId: string, providerId: string): Promise<string | null> {
  const rows = await db
    .select({ idToken: account.idToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, providerId)))
    .orderBy(desc(account.updatedAt))
    .limit(1);
  return rows[0]?.idToken ?? null;
}

// `accountId` is the provider's own id for the identity (the `sub`), which is
// what the screens have; without it every link to that provider goes.
export async function unlinkAccount(
  userId: string,
  providerId: string,
  accountId?: string,
): Promise<boolean> {
  const where = accountId
    ? and(
        eq(account.userId, userId),
        eq(account.providerId, providerId),
        eq(account.accountId, accountId),
      )
    : and(eq(account.userId, userId), eq(account.providerId, providerId));
  const deleted = await db.delete(account).where(where).returning({ id: account.id });
  return deleted.length > 0;
}

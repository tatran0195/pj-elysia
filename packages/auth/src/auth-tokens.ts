import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db, authToken } from '@repo/db';

// Single-use links: address verification, password reset, magic sign-in.
//
// One table and one pair of functions for all three, because they are the same
// object with a different `purpose` and the rules must not drift apart:
//
//   - the link carries a 32-byte random token; only its SHA-256 is stored
//   - redeeming is a single UPDATE guarded on `consumed_at is null`, so two
//     clicks on the same link cannot both succeed, whatever the concurrency
//   - issuing a new token for a purpose supersedes the outstanding ones, so a
//     forwarded old reset mail stops working the moment a new one is requested

export const AUTH_TOKEN_PURPOSES = ['email_verification', 'password_reset', 'magic_link'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

// Long enough to survive a mail queue and a coffee break, short enough that a
// message sitting in an old inbox is not a standing key. Reset and magic links are
// sign-in-equivalent, so they get the short end.
export const TOKEN_TTL_MS: Record<AuthTokenPurpose, number> = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
  magic_link: 15 * 60 * 1000,
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export async function issueAuthToken(input: {
  purpose: AuthTokenPurpose;
  identifier: string;
  userId?: string | null;
  now?: number;
}): Promise<IssuedToken> {
  const now = input.now ?? Date.now();
  const identifier = input.identifier.trim().toLowerCase();

  // Supersede anything outstanding for this address and purpose.
  await db
    .update(authToken)
    .set({ consumedAt: new Date(now) })
    .where(
      and(
        eq(authToken.purpose, input.purpose),
        eq(authToken.identifier, identifier),
        isNull(authToken.consumedAt),
      ),
    );

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + TOKEN_TTL_MS[input.purpose]);
  await db.insert(authToken).values({
    id: randomUUID(),
    purpose: input.purpose,
    tokenHash: hashToken(token),
    identifier,
    userId: input.userId ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

export interface ConsumedToken {
  identifier: string;
  userId: string | null;
}

// Redeems a token, or returns null when it is unknown, expired, already used or
// for a different purpose. The purpose is part of the lookup on purpose: a
// verification link must not be redeemable as a password reset.
export async function consumeAuthToken(
  purpose: AuthTokenPurpose,
  token: string | null | undefined,
  now = Date.now(),
): Promise<ConsumedToken | null> {
  if (!token) return null;
  const consumed = await db
    .update(authToken)
    .set({ consumedAt: new Date(now) })
    .where(
      and(
        eq(authToken.tokenHash, hashToken(token)),
        eq(authToken.purpose, purpose),
        isNull(authToken.consumedAt),
        gt(authToken.expiresAt, new Date(now)),
      ),
    )
    .returning({ identifier: authToken.identifier, userId: authToken.userId });
  return consumed[0] ?? null;
}

// Housekeeping: expired rows are only history, and the identifier column is
// personal data. Keep it tidy.
export async function deleteStaleAuthTokens(olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(authToken)
    .where(lt(authToken.expiresAt, olderThan))
    .returning({ id: authToken.id });
  return deleted.length;
}

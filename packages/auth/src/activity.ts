import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db, authActivity } from '@repo/db';

// The authentication audit trail.
//
// Every event that changes who can get in — or fails to — lands here: sign-ins,
// failed attempts, sign-outs, password and MFA changes, revocations. Two
// audiences: the account's Security page ("was that you, from Berlin, on
// Tuesday?") and whoever is reading the logs after something went wrong.
//
// Writes deliberately swallow their errors: an audit row that cannot be written
// must never turn a successful sign-in into a 500. It is logged and stepped over.

export const AUTH_EVENTS = [
  'sign_in',
  'sign_in_failed',
  'sign_in_locked',
  'sign_up',
  'sign_out',
  'sign_out_all',
  'session_revoked',
  'password_changed',
  'password_reset_requested',
  'password_reset',
  'email_verified',
  'mfa_enabled',
  'mfa_disabled',
  'mfa_failed',
  'mfa_recovery_used',
  'step_up',
  'passkey_added',
  'passkey_removed',
  'api_key_created',
  'api_key_revoked',
  'provider_linked',
  'provider_unlinked',
] as const;

export type AuthEvent = (typeof AUTH_EVENTS)[number];

export interface RecordActivityInput {
  event: AuthEvent;
  userId?: string | null;
  // What was typed on a failed attempt when it matched no account. Never a
  // password, and never anything the caller did not already send.
  identifier?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceLabel?: string | null;
  detail?: Record<string, unknown> | null;
}

export async function recordActivity(input: RecordActivityInput): Promise<void> {
  try {
    await db.insert(authActivity).values({
      id: randomUUID(),
      event: input.event,
      userId: input.userId ?? null,
      identifier: input.identifier ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      deviceLabel: input.deviceLabel ?? null,
      detail: input.detail ?? null,
    });
  } catch (error) {
    console.error('auth: failed to record activity', input.event, error);
  }
}

export interface ActivityEntry {
  id: string;
  event: string;
  ipAddress: string | null;
  deviceLabel: string | null;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

// Newest first, capped: the page shows recent history, not an archive.
export async function listActivity(userId: string, limit = 50): Promise<ActivityEntry[]> {
  return db
    .select({
      id: authActivity.id,
      event: authActivity.event,
      ipAddress: authActivity.ipAddress,
      deviceLabel: authActivity.deviceLabel,
      detail: authActivity.detail,
      createdAt: authActivity.createdAt,
    })
    .from(authActivity)
    .where(eq(authActivity.userId, userId))
    .orderBy(desc(authActivity.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

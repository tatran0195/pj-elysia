import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import { db, session as sessionTable, user as userTable } from '@repo/db';
import { deriveDeviceLabel } from './device';
import {
  LAST_SEEN_TOUCH_DEBOUNCE_MS,
  createSessionToken,
  hashSessionToken,
  sessionAbsoluteExpiry,
  sessionIdleCutoff,
} from './tokens';
import { clampStepUpWindow } from './step-up';
import type { AuthUser } from './users';
import { AUTH_USER_COLUMNS, rowToAuthUser } from './users';

// Session storage.
//
// A session is only ever looked up by the SHA-256 of the token the browser sent,
// and a lookup enforces every reason a session might no longer be valid in one
// query: revoked, past its absolute expiry, idle too long, or belonging to an
// account that has been deactivated. Anything that gets past that is a live
// session; there is no second check to forget somewhere else.

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  deviceLabel: string;
  revokedAt: Date | null;
  mfaPassedAt: Date | null;
  stepUpExpiresAt: Date | null;
}

export interface AuthenticatedSession {
  user: AuthUser;
  session: SessionRecord;
}

export interface CreateSessionInput {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  // Null when the account has MFA on and has not entered a code yet: the row
  // exists so the code can be verified against it, but it authenticates nothing
  // until `markMfaPassed` runs.
  mfaPassedAt?: Date | null;
  now?: number;
}

export interface CreatedSession {
  // The only time the raw token exists. It goes into the cookie and is never
  // stored, logged or returned again.
  token: string;
  id: string;
  expiresAt: Date;
}

// `last_seen_at` is a write on the hottest row in the system. This collapses the
// writes to one per session per debounce window; the map is bounded so a process
// that sees many sessions cannot grow it without limit.
const lastSeenTouchedAt = new Map<string, number>();
const LAST_SEEN_TRACKER_MAX_ENTRIES = 10_000;

export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  const now = input.now ?? Date.now();
  const token = createSessionToken();
  const id = randomUUID();
  const expiresAt = sessionAbsoluteExpiry(now);
  await db.insert(sessionTable).values({
    id,
    userId: input.userId,
    idHash: hashSessionToken(token),
    createdAt: new Date(now),
    expiresAt,
    lastSeenAt: new Date(now),
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    deviceLabel: deriveDeviceLabel(input.userAgent),
    mfaPassedAt: input.mfaPassedAt ?? null,
  });
  return { token, id, expiresAt };
}

// The one query every authenticated request runs. Returns null for any reason the
// session is not usable, deliberately without saying which — the caller answers
// 401 either way, and the activity log is where the detail belongs.
export async function findSessionByToken(
  token: string | null | undefined,
  now = Date.now(),
): Promise<AuthenticatedSession | null> {
  if (!token) return null;
  const idHash = hashSessionToken(token);
  const rows = await db
    .select({ ...AUTH_USER_COLUMNS, ...SESSION_COLUMNS })
    .from(sessionTable)
    .innerJoin(userTable, eq(userTable.id, sessionTable.userId))
    .where(
      and(
        eq(sessionTable.idHash, idHash),
        isNull(sessionTable.revokedAt),
        gt(sessionTable.expiresAt, new Date(now)),
        gt(sessionTable.lastSeenAt, sessionIdleCutoff(now)),
        eq(userTable.active, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // A session that still owes a second factor is not a session yet.
  if (row.mfaEnabled && row.sessionMfaPassedAt === null) return null;

  await touchLastSeen(idHash, now);
  return { user: rowToAuthUser(row), session: rowToSession(row) };
}

// The half-authenticated state between password and code: the caller needs to know
// the session exists so it can offer the MFA form, without treating it as signed in.
export async function findMfaPendingSession(
  token: string | null | undefined,
  now = Date.now(),
): Promise<AuthenticatedSession | null> {
  if (!token) return null;
  const rows = await db
    .select({ ...AUTH_USER_COLUMNS, ...SESSION_COLUMNS })
    .from(sessionTable)
    .innerJoin(userTable, eq(userTable.id, sessionTable.userId))
    .where(
      and(
        eq(sessionTable.idHash, hashSessionToken(token)),
        isNull(sessionTable.revokedAt),
        isNull(sessionTable.mfaPassedAt),
        gt(sessionTable.expiresAt, new Date(now)),
        eq(userTable.active, true),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { user: rowToAuthUser(row), session: rowToSession(row) };
}

export async function markMfaPassed(token: string, now = Date.now()): Promise<void> {
  await db
    .update(sessionTable)
    .set({ mfaPassedAt: new Date(now), lastSeenAt: new Date(now) })
    .where(eq(sessionTable.idHash, hashSessionToken(token)));
}

// Replaces the token on an existing session, keeping its history and device.
//
// Run whenever the trust level of a session changes — after a second factor, after
// a step-up, after a password change. It closes session fixation: a token an
// attacker managed to plant before the privilege change stops working at the
// moment it would become worth having.
export async function rotateSessionToken(
  currentToken: string,
  options: { stepUpWindowMinutes?: number | null; now?: number } = {},
): Promise<{ token: string; expiresAt: Date } | null> {
  const now = options.now ?? Date.now();
  const nextToken = createSessionToken();
  const expiresAt = sessionAbsoluteExpiry(now);
  const stepUpExpiresAt =
    options.stepUpWindowMinutes == null
      ? undefined
      : new Date(now + clampStepUpWindow(options.stepUpWindowMinutes) * 60 * 1000);

  const updated = await db
    .update(sessionTable)
    .set({
      idHash: hashSessionToken(nextToken),
      expiresAt,
      lastSeenAt: new Date(now),
      ...(stepUpExpiresAt ? { stepUpExpiresAt } : {}),
    })
    .where(
      and(
        eq(sessionTable.idHash, hashSessionToken(currentToken)),
        isNull(sessionTable.revokedAt),
        gt(sessionTable.expiresAt, new Date(now)),
      ),
    )
    .returning({ id: sessionTable.id });

  if (updated.length === 0) return null;
  lastSeenTouchedAt.delete(hashSessionToken(currentToken));
  return { token: nextToken, expiresAt };
}

export async function openStepUpWindow(
  token: string,
  windowMinutes: number,
  now = Date.now(),
): Promise<Date> {
  const expiresAt = new Date(now + clampStepUpWindow(windowMinutes) * 60 * 1000);
  await db
    .update(sessionTable)
    .set({ stepUpExpiresAt: expiresAt })
    .where(eq(sessionTable.idHash, hashSessionToken(token)));
  return expiresAt;
}

// Marked, not deleted: "signed out on another device" is something the activity
// log and the session list should still be able to show.
export async function revokeSessionByToken(token: string, now = Date.now()): Promise<void> {
  const idHash = hashSessionToken(token);
  await db
    .update(sessionTable)
    .set({ revokedAt: new Date(now) })
    .where(and(eq(sessionTable.idHash, idHash), isNull(sessionTable.revokedAt)));
  lastSeenTouchedAt.delete(idHash);
}

// Revoking by id (not by token) is what the security page does, so a session can
// only ever be ended by the account that owns it.
export async function revokeSessionById(
  userId: string,
  sessionId: string,
  now = Date.now(),
): Promise<boolean> {
  const revoked = await db
    .update(sessionTable)
    .set({ revokedAt: new Date(now) })
    .where(
      and(
        eq(sessionTable.id, sessionId),
        eq(sessionTable.userId, userId),
        isNull(sessionTable.revokedAt),
      ),
    )
    .returning({ id: sessionTable.id });
  return revoked.length > 0;
}

// "Sign out everywhere else". `keepToken` is required rather than optional: a
// caller that forgets it would sign the current device out too, and the failure
// mode of that is confusing rather than obvious. Pass '' to revoke every session,
// which is what a password reset does.
export async function revokeOtherSessions(
  userId: string,
  keepToken: string,
  now = Date.now(),
): Promise<number> {
  const revoked = await db
    .update(sessionTable)
    .set({ revokedAt: new Date(now) })
    .where(
      and(
        eq(sessionTable.userId, userId),
        isNull(sessionTable.revokedAt),
        ne(sessionTable.idHash, keepToken ? hashSessionToken(keepToken) : ''),
      ),
    )
    .returning({ id: sessionTable.id });
  return revoked.length;
}

export interface SessionSummary {
  id: string;
  deviceLabel: string;
  ipAddress: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  current: boolean;
}

export async function listSessions(
  userId: string,
  currentToken: string | null,
  now = Date.now(),
): Promise<SessionSummary[]> {
  const currentHash = currentToken ? hashSessionToken(currentToken) : null;
  const rows = await db
    .select({
      id: sessionTable.id,
      idHash: sessionTable.idHash,
      deviceLabel: sessionTable.deviceLabel,
      ipAddress: sessionTable.ipAddress,
      createdAt: sessionTable.createdAt,
      lastSeenAt: sessionTable.lastSeenAt,
      expiresAt: sessionTable.expiresAt,
    })
    .from(sessionTable)
    .where(
      and(
        eq(sessionTable.userId, userId),
        isNull(sessionTable.revokedAt),
        gt(sessionTable.expiresAt, new Date(now)),
        gt(sessionTable.lastSeenAt, sessionIdleCutoff(now)),
      ),
    )
    .orderBy(desc(sessionTable.lastSeenAt));

  return rows.map(({ idHash, ...row }) => ({ ...row, current: idHash === currentHash }));
}

// Housekeeping for whatever runs periodically: rows past their absolute expiry can
// never authenticate again, so they are only taking up space.
export async function deleteExpiredSessions(now = Date.now()): Promise<number> {
  const deleted = await db
    .delete(sessionTable)
    .where(lt(sessionTable.expiresAt, new Date(now)))
    .returning({ id: sessionTable.id });
  return deleted.length;
}

const SESSION_COLUMNS = {
  sessionId: sessionTable.id,
  sessionCreatedAt: sessionTable.createdAt,
  sessionExpiresAt: sessionTable.expiresAt,
  sessionLastSeenAt: sessionTable.lastSeenAt,
  sessionIpAddress: sessionTable.ipAddress,
  sessionUserAgent: sessionTable.userAgent,
  sessionDeviceLabel: sessionTable.deviceLabel,
  sessionRevokedAt: sessionTable.revokedAt,
  sessionMfaPassedAt: sessionTable.mfaPassedAt,
  sessionStepUpExpiresAt: sessionTable.stepUpExpiresAt,
} as const;

interface SessionColumns {
  sessionId: string;
  sessionCreatedAt: Date;
  sessionExpiresAt: Date;
  sessionLastSeenAt: Date;
  sessionIpAddress: string | null;
  sessionUserAgent: string | null;
  sessionDeviceLabel: string;
  sessionRevokedAt: Date | null;
  sessionMfaPassedAt: Date | null;
  sessionStepUpExpiresAt: Date | null;
}

function rowToSession(row: SessionColumns & { id: string }): SessionRecord {
  return {
    id: row.sessionId,
    userId: row.id,
    createdAt: row.sessionCreatedAt,
    expiresAt: row.sessionExpiresAt,
    lastSeenAt: row.sessionLastSeenAt,
    ipAddress: row.sessionIpAddress,
    userAgent: row.sessionUserAgent,
    deviceLabel: row.sessionDeviceLabel,
    revokedAt: row.sessionRevokedAt,
    mfaPassedAt: row.sessionMfaPassedAt,
    stepUpExpiresAt: row.sessionStepUpExpiresAt,
  };
}

async function touchLastSeen(idHash: string, now: number): Promise<void> {
  const touchedAt = lastSeenTouchedAt.get(idHash) ?? 0;
  if (now - touchedAt < LAST_SEEN_TOUCH_DEBOUNCE_MS) return;
  if (lastSeenTouchedAt.size >= LAST_SEEN_TRACKER_MAX_ENTRIES) lastSeenTouchedAt.clear();
  lastSeenTouchedAt.set(idHash, now);
  await db
    .update(sessionTable)
    .set({ lastSeenAt: new Date(now) })
    .where(eq(sessionTable.idHash, idHash));
}

// Tests reach for this: the debounce is process state, and a test that creates and
// immediately re-reads a session should not be at the mercy of the previous one.
export function resetLastSeenTracker(): void {
  lastSeenTouchedAt.clear();
}

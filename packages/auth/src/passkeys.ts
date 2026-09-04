import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, passkey } from '@repo/db';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { configuredOrigins, canonicalOrigin } from './origin';

// WebAuthn passkeys. The ceremony itself (CBOR, COSE keys, attestation formats,
// signature checks) is `@simplewebauthn/server`'s job; this module owns the
// relying-party policy, the challenge lifecycle and the `passkey` table.
//
// Challenges are single-use and short-lived, and are kept in memory: a
// challenge is bound to the process that issued it and expires in minutes, so a
// restart only costs the user a retry. A deployment that runs several api
// processes behind a balancer should pin the two halves of a ceremony to one
// instance (or move this map to the database).

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface PendingChallenge {
  challenge: string;
  kind: 'registration' | 'authentication';
  // The signed-in user during registration; null for a usernameless sign-in.
  userId: string | null;
  expiresAt: number;
}

const pending = new Map<string, PendingChallenge>();
const PENDING_MAX = 10_000;

function rememberChallenge(entry: PendingChallenge): string {
  if (pending.size >= PENDING_MAX) {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
    if (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value!);
  }
  const id = randomUUID();
  pending.set(id, entry);
  return id;
}

function takeChallenge(id: string | null | undefined, kind: PendingChallenge['kind']): PendingChallenge | null {
  if (!id) return null;
  const entry = pending.get(id);
  if (!entry) return null;
  pending.delete(id);
  if (entry.kind !== kind || entry.expiresAt <= Date.now()) return null;
  return entry;
}

export function resetPasskeyChallenges(): void {
  pending.clear();
}

// The relying-party id is the app's hostname; the expected origins are the
// configured ones. PASSKEY_RP_ID overrides the id for a deployment where the
// api answers on one host and the app on another under a shared parent.
export function relyingParty(env: NodeJS.ProcessEnv = process.env) {
  const app = canonicalOrigin(env);
  const rpID = env.PASSKEY_RP_ID ?? (app ? new URL(app).hostname : 'localhost');
  return {
    rpID,
    rpName: env.PASSKEY_RP_NAME ?? "It's a Plan",
    origins: configuredOrigins(env),
  };
}

export interface PasskeySummary {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  aaguid: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const SUMMARY = {
  id: passkey.id,
  name: passkey.name,
  deviceType: passkey.deviceType,
  backedUp: passkey.backedUp,
  aaguid: passkey.aaguid,
  createdAt: passkey.createdAt,
  lastUsedAt: passkey.lastUsedAt,
};

export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  return db.select(SUMMARY).from(passkey).where(eq(passkey.userId, userId)).orderBy(passkey.createdAt);
}

export async function deletePasskey(userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(passkey)
    .where(and(eq(passkey.userId, userId), eq(passkey.id, id)))
    .returning({ id: passkey.id });
  return deleted.length > 0;
}

// --- registration ------------------------------------------------------------

export async function beginPasskeyRegistration(user: {
  id: string;
  email: string;
  name: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const rp = relyingParty();
  const existing = await db
    .select({ credentialId: passkey.credentialId, transports: passkey.transports })
    .from(passkey)
    .where(eq(passkey.userId, user.id));

  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: parseTransports(row.transports),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  const challengeId = rememberChallenge({
    challenge: options.challenge,
    kind: 'registration',
    userId: user.id,
    expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
  });
  return { challengeId, options };
}

export type RegistrationOutcome =
  | { status: 'ok'; passkey: PasskeySummary }
  | { status: 'no_challenge' }
  | { status: 'rejected'; message: string }
  | { status: 'duplicate' };

export async function finishPasskeyRegistration(input: {
  userId: string;
  challengeId: string;
  response: RegistrationResponseJSON;
  name?: string | null;
}): Promise<RegistrationOutcome> {
  const entry = takeChallenge(input.challengeId, 'registration');
  if (!entry || entry.userId !== input.userId) return { status: 'no_challenge' };
  const rp = relyingParty();

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: entry.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    });
  } catch (error) {
    return { status: 'rejected', message: (error as Error).message };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { status: 'rejected', message: 'Registration could not be verified' };
  }

  const info = verification.registrationInfo;
  const id = randomUUID();
  try {
    const rows = await db
      .insert(passkey)
      .values({
        id,
        userId: input.userId,
        name: input.name?.trim() || null,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        transports: info.credential.transports ? JSON.stringify(info.credential.transports) : null,
        aaguid: info.aaguid,
      })
      .returning(SUMMARY);
    return { status: 'ok', passkey: rows[0]! };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { status: 'duplicate' };
    throw error;
  }
}

// --- authentication ----------------------------------------------------------

// Usernameless: the browser is offered any discoverable credential for this
// relying party, and the response tells us which account it belongs to.
export async function beginPasskeyAuthentication(): Promise<{
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const rp = relyingParty();
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'preferred',
    allowCredentials: [],
  });
  const challengeId = rememberChallenge({
    challenge: options.challenge,
    kind: 'authentication',
    userId: null,
    expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
  });
  return { challengeId, options };
}

export type AuthenticationOutcome =
  | { status: 'ok'; userId: string; passkeyId: string }
  | { status: 'no_challenge' }
  | { status: 'unknown_credential' }
  | { status: 'rejected'; message: string };

export async function finishPasskeyAuthentication(input: {
  challengeId: string;
  response: AuthenticationResponseJSON;
}): Promise<AuthenticationOutcome> {
  const entry = takeChallenge(input.challengeId, 'authentication');
  if (!entry) return { status: 'no_challenge' };
  const rp = relyingParty();

  const rows = await db
    .select({
      id: passkey.id,
      userId: passkey.userId,
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      transports: passkey.transports,
    })
    .from(passkey)
    .where(eq(passkey.credentialId, input.response.id))
    .limit(1);
  const stored = rows[0];
  if (!stored) return { status: 'unknown_credential' };

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: entry.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter,
        transports: parseTransports(stored.transports) as never,
      },
    });
  } catch (error) {
    return { status: 'rejected', message: (error as Error).message };
  }
  if (!verification.verified) return { status: 'rejected', message: 'Assertion could not be verified' };

  await db
    .update(passkey)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
    .where(eq(passkey.id, stored.id));
  return { status: 'ok', userId: stored.userId, passkeyId: stored.id };
}

function parseTransports(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : undefined;
  } catch {
    return undefined;
  }
}

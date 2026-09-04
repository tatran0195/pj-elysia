import { consumeRecoveryCode, decryptTotpSecret, hashRecoveryCode, verifyTotpCode } from './mfa';
import { equalizeTiming, passwordProblem, verifyPassword } from './passwords';
import { lockStatus, retryAfterSeconds } from './lockout';
import { rateLimitKey, signInLimiter, mfaLimiter, signUpLimiter } from './rate-limit';
import { recordActivity } from './activity';
import {
  createSession,
  findMfaPendingSession,
  markMfaPassed,
  rotateSessionToken,
  revokeSessionByToken,
} from './sessions';
import {
  clearLoginFailures,
  createUser,
  findCredentialByIdentifier,
  getMfaRecord,
  instanceHasNoUsers,
  recordFailedLogin,
  setRecoveryCodeHashes,
  type AuthUser,
} from './users';

// The sign-in flows, kept away from HTTP so the rules can be read (and tested)
// without an Elysia context in the way. Every function returns a discriminated
// result; mapping those onto status codes is the route layer's job.
//
// The order of the checks in `signIn` is the security-relevant part:
//
//   1. rate limit        — before any database work, so grinding is cheap to refuse
//   2. account lookup    — and, when it misses, a dummy verification so the
//                          "no such account" branch takes as long as the others
//   3. lockout           — checked before the password, so a locked account cannot
//                          be used as an oracle for whether a guess was right
//   4. password          — argon2id
//   5. second factor     — a session is created either way, but one that has not
//                          passed MFA authenticates nothing (see sessions.ts)
//
// Failures are all reported to the caller as the same `invalid_credentials`. The
// detail goes to the activity log, where the account owner and the operator can
// see it and an attacker cannot.

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export type SignInResult =
  | { status: 'ok'; user: AuthUser; token: string; expiresAt: Date }
  | { status: 'mfa_required'; token: string; expiresAt: Date }
  | { status: 'invalid_credentials' }
  | { status: 'locked'; retryAfterSeconds: number }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'email_unverified'; email: string }
  | { status: 'deactivated' };

export interface SignInOptions {
  identifier: string;
  password: string;
  context: RequestContext;
  // The instance setting: sign-in is refused until the address is confirmed.
  requireVerifiedEmail?: boolean;
  now?: number;
}

export async function signIn(options: SignInOptions): Promise<SignInResult> {
  const now = options.now ?? Date.now();
  const { identifier, password, context } = options;

  const limit = signInLimiter.consume(rateLimitKey(context.ipAddress, identifier), now);
  if (!limit.ok) {
    await recordActivity({
      event: 'sign_in_failed',
      identifier,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      detail: { reason: 'rate_limited' },
    });
    return { status: 'rate_limited', retryAfterSeconds: retryAfterSeconds(limit.retryAfterMs) };
  }

  const credential = await findCredentialByIdentifier(identifier);
  if (!credential) {
    // Same work as a real verification, so timing does not reveal that the
    // address is unknown.
    await equalizeTiming(password);
    await recordActivity({
      event: 'sign_in_failed',
      identifier,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      detail: { reason: 'unknown_account' },
    });
    return { status: 'invalid_credentials' };
  }

  const lock = lockStatus(credential.lockout, now);
  if (lock.locked) {
    await recordActivity({
      event: 'sign_in_locked',
      userId: credential.user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return { status: 'locked', retryAfterSeconds: retryAfterSeconds(lock.retryAfterMs) };
  }

  if (!credential.user.active) {
    await equalizeTiming(password);
    return { status: 'deactivated' };
  }

  const passwordOk =
    credential.passwordHash !== null && (await verifyPassword(password, credential.passwordHash));
  if (!passwordOk) {
    const outcome = await recordFailedLogin(credential.user.id, credential.lockout, now);
    await recordActivity({
      event: outcome.locked ? 'sign_in_locked' : 'sign_in_failed',
      userId: credential.user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      detail: { reason: credential.passwordHash ? 'bad_password' : 'no_password_set' },
    });
    if (outcome.locked && outcome.lockedUntil) {
      return {
        status: 'locked',
        retryAfterSeconds: retryAfterSeconds(outcome.lockedUntil.getTime() - now),
      };
    }
    return { status: 'invalid_credentials' };
  }

  if (options.requireVerifiedEmail && !credential.user.emailVerified) {
    return { status: 'email_unverified', email: credential.user.email };
  }

  await clearLoginFailures(credential.user.id);
  signInLimiter.reset(rateLimitKey(context.ipAddress, identifier));

  const mfaRequired = credential.user.mfaEnabled;
  const created = await createSession({
    userId: credential.user.id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    mfaPassedAt: mfaRequired ? null : new Date(now),
    now,
  });

  if (mfaRequired) {
    // The cookie is set, but the session does not authenticate anything until the
    // code is verified. Nothing else has to know about that state.
    return { status: 'mfa_required', token: created.token, expiresAt: created.expiresAt };
  }

  await recordActivity({
    event: 'sign_in',
    userId: credential.user.id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    detail: { method: 'password' },
  });
  return {
    status: 'ok',
    user: credential.user,
    token: created.token,
    expiresAt: created.expiresAt,
  };
}

export type MfaResult =
  | { status: 'ok'; user: AuthUser; token: string; expiresAt: Date; recoveryCodesLeft?: number }
  | { status: 'invalid_code' }
  | { status: 'no_pending_session' }
  | { status: 'rate_limited'; retryAfterSeconds: number };

// The second half of a sign-in. Accepts either a TOTP code or one of the recovery
// codes; a recovery code is consumed as it is used, and the count that is left
// comes back so the UI can nag before the last one is gone.
//
// The token is rotated on success: the value minted before the second factor never
// becomes a fully authenticated session.
export async function verifyMfa(options: {
  token: string;
  code: string;
  context: RequestContext;
  now?: number;
}): Promise<MfaResult> {
  const now = options.now ?? Date.now();
  const pending = await findMfaPendingSession(options.token, now);
  if (!pending) return { status: 'no_pending_session' };

  const limit = mfaLimiter.consume(rateLimitKey(options.context.ipAddress, pending.user.id), now);
  if (!limit.ok) {
    return { status: 'rate_limited', retryAfterSeconds: retryAfterSeconds(limit.retryAfterMs) };
  }

  const record = await getMfaRecord(pending.user.id);
  if (!record) return { status: 'invalid_code' };

  let recoveryCodesLeft: number | undefined;
  let accepted = false;

  try {
    accepted = verifyTotpCode(decryptTotpSecret(record), options.code, now);
  } catch (error) {
    // A secret encrypted under a rotated key: say so in the log rather than
    // silently rejecting every code forever.
    console.error('auth: cannot decrypt MFA secret', error);
  }

  if (!accepted) {
    const remaining = consumeRecoveryCode(record.recoveryCodeHashes, options.code);
    if (remaining) {
      await setRecoveryCodeHashes(pending.user.id, remaining);
      recoveryCodesLeft = remaining.length;
      accepted = true;
      await recordActivity({
        event: 'mfa_recovery_used',
        userId: pending.user.id,
        ipAddress: options.context.ipAddress,
        userAgent: options.context.userAgent,
        detail: { remaining: remaining.length },
      });
    }
  }

  if (!accepted) {
    await recordActivity({
      event: 'mfa_failed',
      userId: pending.user.id,
      ipAddress: options.context.ipAddress,
      userAgent: options.context.userAgent,
    });
    return { status: 'invalid_code' };
  }

  await markMfaPassed(options.token, now);
  const rotated = await rotateSessionToken(options.token, { now });
  if (!rotated) return { status: 'no_pending_session' };

  mfaLimiter.reset(rateLimitKey(options.context.ipAddress, pending.user.id));
  await recordActivity({
    event: 'sign_in',
    userId: pending.user.id,
    ipAddress: options.context.ipAddress,
    userAgent: options.context.userAgent,
    detail: { method: 'password+mfa' },
  });

  return {
    status: 'ok',
    user: pending.user,
    token: rotated.token,
    expiresAt: rotated.expiresAt,
    recoveryCodesLeft,
  };
}

export type SignUpResult =
  | { status: 'ok'; user: AuthUser; token: string; expiresAt: Date }
  | { status: 'email_taken' }
  | { status: 'weak_password'; message: string }
  | { status: 'rate_limited'; retryAfterSeconds: number };

// Registration. Whether registration is open at all (and whether an invite is
// required) lives in the instance settings and is applied by the route before this
// runs — this function is about creating the account correctly.
export async function signUp(options: {
  name: string;
  email: string;
  password: string;
  context: RequestContext;
  role?: string;
  emailVerified?: boolean;
  now?: number;
}): Promise<SignUpResult> {
  const now = options.now ?? Date.now();
  const email = options.email.trim().toLowerCase();

  const limit = signUpLimiter.consume(rateLimitKey(options.context.ipAddress, email), now);
  if (!limit.ok) {
    return { status: 'rate_limited', retryAfterSeconds: retryAfterSeconds(limit.retryAfterMs) };
  }

  const problem = passwordProblem(options.password);
  if (problem) return { status: 'weak_password', message: problem };

  const existing = await findCredentialByIdentifier(email);
  if (existing) return { status: 'email_taken' };

  // The first account on an empty instance is its administrator. The alternative
  // is a bootstrap password in the environment, which then lives forever in a
  // deployment config; this way the person who installs it is the one who gets in.
  const role = options.role ?? ((await instanceHasNoUsers()) ? 'god' : 'user');

  let user: AuthUser;
  try {
    user = await createUser({
      name: options.name,
      email,
      password: options.password,
      role,
      emailVerified: options.emailVerified,
    });
  } catch (error) {
    // The unique index is the real arbiter: two sign-ups for one address can race
    // past the check above.
    if (isUniqueViolation(error)) return { status: 'email_taken' };
    throw error;
  }

  const created = await createSession({
    userId: user.id,
    ipAddress: options.context.ipAddress,
    userAgent: options.context.userAgent,
    mfaPassedAt: new Date(now),
    now,
  });

  await recordActivity({
    event: 'sign_up',
    userId: user.id,
    ipAddress: options.context.ipAddress,
    userAgent: options.context.userAgent,
  });

  return { status: 'ok', user, token: created.token, expiresAt: created.expiresAt };
}

export async function signOut(
  token: string,
  context: RequestContext,
  userId?: string,
): Promise<void> {
  await revokeSessionByToken(token);
  await recordActivity({
    event: 'sign_out',
    userId: userId ?? null,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}

export type StepUpResult =
  | { status: 'ok'; token: string; expiresAt: Date; stepUpExpiresAt: Date }
  | { status: 'invalid_password' }
  | { status: 'rate_limited'; retryAfterSeconds: number };

// Re-authentication for a sensitive action. The password is verified again and the
// session token is rotated, which is what makes a stolen cookie insufficient for
// the dangerous half of the app.
export async function stepUp(options: {
  token: string;
  user: AuthUser;
  password: string;
  passwordHash: string | null;
  context: RequestContext;
  now?: number;
}): Promise<StepUpResult> {
  const now = options.now ?? Date.now();
  const limit = signInLimiter.consume(
    rateLimitKey(options.context.ipAddress, options.user.id),
    now,
  );
  if (!limit.ok) {
    return { status: 'rate_limited', retryAfterSeconds: retryAfterSeconds(limit.retryAfterMs) };
  }

  const ok =
    options.passwordHash !== null && (await verifyPassword(options.password, options.passwordHash));
  if (!ok) {
    await equalizeTiming(options.password);
    return { status: 'invalid_password' };
  }

  const rotated = await rotateSessionToken(options.token, {
    stepUpWindowMinutes: options.user.stepUpWindowMinutes,
    now,
  });
  if (!rotated) return { status: 'invalid_password' };

  const stepUpExpiresAt = new Date(now + options.user.stepUpWindowMinutes * 60 * 1000);
  await recordActivity({
    event: 'step_up',
    userId: options.user.id,
    ipAddress: options.context.ipAddress,
    userAgent: options.context.userAgent,
  });
  return { status: 'ok', token: rotated.token, expiresAt: rotated.expiresAt, stepUpExpiresAt };
}

// Recovery codes are shown once. Returning both the plaintext (for the screen) and
// the digests (for the row) keeps the only copy of the plaintext in the response.
export function prepareRecoveryCodes(codes: readonly string[]): {
  codes: string[];
  hashes: string[];
} {
  return { codes: [...codes], hashes: codes.map(hashRecoveryCode) };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

// --- sign-in by something other than a password ------------------------------
//
// Magic links, OAuth callbacks and passkeys all end the same way: the caller has
// already proved who the user is, and a session has to be opened for them. The
// checks that still apply — deactivation, and the second factor for a method
// that does not itself count as one — live here so the three callers cannot
// disagree.

export type ExternalSignInMethod = 'magic_link' | 'google' | 'oidc' | 'passkey';

export type ExternalSignInResult =
  | { status: 'ok'; user: AuthUser; token: string; expiresAt: Date }
  | { status: 'mfa_required'; token: string; expiresAt: Date }
  | { status: 'deactivated' };

export async function signInVerifiedUser(options: {
  user: AuthUser;
  method: ExternalSignInMethod;
  context: RequestContext;
  now?: number;
}): Promise<ExternalSignInResult> {
  const now = options.now ?? Date.now();
  const { user, context } = options;
  if (!user.active) return { status: 'deactivated' };

  // A passkey is possession + user verification on its own; the others are a
  // single factor, so TOTP still stands in front of them when it is on.
  const mfaRequired = user.mfaEnabled && options.method !== 'passkey';
  await clearLoginFailures(user.id);
  const created = await createSession({
    userId: user.id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    mfaPassedAt: mfaRequired ? null : new Date(now),
    now,
  });
  if (mfaRequired) {
    return { status: 'mfa_required', token: created.token, expiresAt: created.expiresAt };
  }
  await recordActivity({
    event: 'sign_in',
    userId: user.id,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    detail: { method: options.method },
  });
  return { status: 'ok', user, token: created.token, expiresAt: created.expiresAt };
}

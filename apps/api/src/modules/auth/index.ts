import { Elysia, t } from 'elysia';
import {
  // primitives
  SESSION_COOKIE_NAME,
  clientIp,
  originAllowed,
  passwordProblem,
  sessionCookieOptions,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionTokenFromHeaders,
  // policy
  passwordResetLimiter,
  rateLimitKey,
  retryAfterSeconds,
  stepUpRequired,
  stepUpWindowOpen,
  isStepUpMode,
  clampStepUpWindow,
  // mfa
  encryptTotpSecret,
  decryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotpCode,
  // storage
  consumeAuthToken,
  findSessionByToken,
  issueAuthToken,
  listActivity,
  listSessions,
  recordActivity,
  revokeOtherSessions,
  revokeSessionById,
  disableMfa,
  enableMfa,
  getMfaRecord,
  findUserByEmail,
  setPassword,
  setStepUpPreferences,
  stageMfaSecret,
  verifyUserPassword,
  markEmailVerified,
  findCredentialByIdentifier,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  isUsernameTaken,
  setUsername,
  usernameProblem,
  updateProfile,
  findUserById,
  prepareRecoveryCodes,
  // flows
  signIn,
  signOut,
  signUp,
  stepUp,
  verifyMfa,
  type AuthUser,
  // instance settings and mail
  getAuthSettings,
  hasPendingInvite,
  sendAuthEmail,
} from '@repo/auth';
import { HttpError } from '#shared/lib';

// The HTTP surface of the first-party auth system.
//
// Mounted outside the planner's session guard, because most of it is what a
// logged-out browser talks to. Everything is `/auth/*`; the planner's own routes
// carry on using the session this establishes.
//
// Conventions:
//   - the session cookie is the only credential; no bearer tokens here
//   - a state-changing request must carry an allowed Origin (CSRF, on top of
//     SameSite=Lax) — enforced once, in the guard below
//   - failures that could be used to enumerate accounts answer the same way
//     whether or not the account exists

const cookieOptions = () => sessionCookieOptions();

// Elysia's `set.headers` allows numbers too, hence the loose shape rather than
// Record<string, string>.
type ResponseHeaders = { headers: Record<string, string | number> };

export function setSessionCookie(set: ResponseHeaders, token: string, expires: Date) {
  set.headers['set-cookie'] = serializeSessionCookie(token, expires, cookieOptions());
}

function clearSessionCookie(set: ResponseHeaders) {
  set.headers['set-cookie'] = serializeClearedSessionCookie(cookieOptions());
}

export function requestContext(request: Request) {
  return {
    ipAddress: clientIp(request.headers),
    userAgent: request.headers.get('user-agent'),
  };
}

// What the browser is told about the signed-in account. Deliberately explicit: a
// spread of the row is how a password hash ends up in a response.
export function publicUser(user: AuthUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    image: user.image,
    username: user.username,
    displayUsername: user.displayUsername,
    role: user.role,
    active: user.active,
    mfaEnabled: user.mfaEnabled,
    stepUpMode: user.stepUpMode,
    stepUpWindowMinutes: user.stepUpWindowMinutes,
    createdAt: user.createdAt.toISOString(),
  };
}

export const PublicUser = t.Object({
  id: t.String(),
  name: t.String(),
  email: t.String(),
  emailVerified: t.Boolean(),
  image: t.Union([t.String(), t.Null()]),
  username: t.Union([t.String(), t.Null()]),
  displayUsername: t.Union([t.String(), t.Null()]),
  role: t.String(),
  active: t.Boolean(),
  mfaEnabled: t.Boolean(),
  stepUpMode: t.String(),
  stepUpWindowMinutes: t.Number(),
  createdAt: t.String(),
});

// Maps a flow result that is not `ok` onto the HTTP answer. One place, so a new
// failure mode cannot be given a different status by accident in two handlers.
export function refuse(result: { status: string; retryAfterSeconds?: number; message?: string }): never {
  switch (result.status) {
    case 'invalid_credentials':
    case 'invalid_password':
    case 'invalid_code':
      throw new HttpError(401, 'Invalid credentials');
    case 'locked':
      throw new HttpError(
        429,
        `Too many failed attempts. Try again in ${result.retryAfterSeconds ?? 60} seconds.`,
      );
    case 'rate_limited':
      throw new HttpError(
        429,
        `Too many attempts. Try again in ${result.retryAfterSeconds ?? 60} seconds.`,
      );
    case 'deactivated':
      throw new HttpError(403, 'This account is deactivated');
    case 'email_unverified':
      throw new HttpError(403, 'Confirm your email address before signing in');
    case 'email_taken':
      throw new HttpError(409, 'An account with this email already exists');
    case 'weak_password':
      throw new HttpError(400, result.message ?? 'Password is too weak');
    case 'no_pending_session':
      throw new HttpError(401, 'Start again from the sign-in screen');
    default:
      throw new HttpError(400, 'Request refused');
  }
}

export const authRoutes = new Elysia({ name: 'auth', detail: { tags: ['Auth'] } })
  // CSRF, defence in depth over SameSite=Lax. Runs before every handler below.
  .onBeforeHandle(({ request }) => {
    if (!originAllowed(request)) throw new HttpError(403, 'Origin not allowed');
  })

  // Resolves the session once per request. Handlers that need a user call
  // `requireSession`; the ones that do not (sign-in, reset) ignore it.
  .resolve({ as: 'scoped' }, async ({ request }) => {
    const token = sessionTokenFromHeaders(request.headers);
    const resolved = token ? await findSessionByToken(token) : null;
    return { token, authed: resolved };
  })

  // --- sign in / out -------------------------------------------------------

  .post(
    '/auth/sign-in',
    async ({ body, request, set }) => {
      const settings = await getAuthSettings();
      if (!settings.emailPassword) {
        throw new HttpError(403, 'Password sign-in is disabled on this instance');
      }
      const result = await signIn({
        identifier: body.identifier,
        password: body.password,
        context: requestContext(request),
        requireVerifiedEmail: settings.requireEmailVerification,
      });

      if (result.status === 'mfa_required') {
        // The cookie is set now so the code can be verified against this session,
        // but it authenticates nothing until it is.
        setSessionCookie(set, result.token, result.expiresAt);
        return { status: 'mfa_required' as const, user: null };
      }
      if (result.status !== 'ok') refuse(result);

      setSessionCookie(set, result.token, result.expiresAt);
      return { status: 'ok' as const, user: publicUser(result.user) };
    },
    {
      body: t.Object({
        // One field: an address or a username, whichever was typed.
        identifier: t.String({ minLength: 1, maxLength: 320 }),
        password: t.String({ minLength: 1, maxLength: 512 }),
      }),
      response: {
        200: t.Object({
          status: t.Union([t.Literal('ok'), t.Literal('mfa_required')]),
          user: t.Union([PublicUser, t.Null()]),
        }),
      },
      detail: { summary: 'Sign in with a password' },
    },
  )

  .post(
    '/auth/mfa/verify',
    async ({ body, request, token, set }) => {
      if (!token) throw new HttpError(401, 'Start again from the sign-in screen');
      const result = await verifyMfa({ token, code: body.code, context: requestContext(request) });
      if (result.status !== 'ok') refuse(result);
      setSessionCookie(set, result.token, result.expiresAt);
      return {
        user: publicUser(result.user),
        recoveryCodesLeft: result.recoveryCodesLeft ?? null,
      };
    },
    {
      body: t.Object({ code: t.String({ minLength: 4, maxLength: 32 }) }),
      response: {
        200: t.Object({ user: PublicUser, recoveryCodesLeft: t.Union([t.Number(), t.Null()]) }),
      },
      detail: { summary: 'Finish a sign-in with a TOTP or recovery code' },
    },
  )

  .post(
    '/auth/sign-out',
    async ({ token, authed, request, set }) => {
      if (token) await signOut(token, requestContext(request), authed?.user.id);
      clearSessionCookie(set);
      return { ok: true };
    },
    {
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Sign out of this device' },
    },
  )

  .post(
    '/auth/sign-up',
    async ({ body, request, set }) => {
      const settings = await getAuthSettings();
      if (settings.registration === 'closed') {
        throw new HttpError(403, 'Registration is closed on this instance');
      }
      if (settings.registration === 'invite' && !(await hasPendingInvite(body.email))) {
        throw new HttpError(
          403,
          'This instance is invite-only. Ask a project owner to invite this address.',
        );
      }

      const result = await signUp({
        name: body.name,
        email: body.email,
        password: body.password,
        context: requestContext(request),
      });
      if (result.status !== 'ok') refuse(result);

      // Address confirmation. Sent on every sign-up, and only *required* when the
      // instance says so — the link is useful either way.
      await sendVerificationMail(result.user.email, result.user.id);

      setSessionCookie(set, result.token, result.expiresAt);
      return { user: publicUser(result.user) };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 120 }),
        email: t.String({ format: 'email', maxLength: 320 }),
        password: t.String({ minLength: 1, maxLength: 512 }),
      }),
      response: { 200: t.Object({ user: PublicUser }) },
      detail: { summary: 'Create an account' },
    },
  )

  // --- the current session -------------------------------------------------

  .get(
    '/auth/session',
    ({ authed }) => (authed ? { user: publicUser(authed.user) } : { user: null }),
    {
      response: { 200: t.Object({ user: t.Union([PublicUser, t.Null()]) }) },
      detail: {
        summary: 'The signed-in user, or null',
        description:
          'Answers 200 with `user: null` when there is no session — it is what the app asks first.',
      },
    },
  )

  .get(
    '/auth/sessions',
    async ({ authed, token }) => {
      const user = requireSession(authed);
      const rows = await listSessions(user.id, token);
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      }));
    },
    {
      response: {
        200: t.Array(
          t.Object({
            id: t.String(),
            deviceLabel: t.String(),
            ipAddress: t.Union([t.String(), t.Null()]),
            createdAt: t.String(),
            lastSeenAt: t.String(),
            expiresAt: t.String(),
            current: t.Boolean(),
          }),
        ),
      },
      detail: { summary: 'Devices this account is signed in on' },
    },
  )

  .delete(
    '/auth/sessions/:id',
    async ({ authed, params, request }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      const revoked = await revokeSessionById(user.id, params.id);
      if (!revoked) throw new HttpError(404, 'Session not found');
      await recordActivity({
        event: 'session_revoked',
        userId: user.id,
        ...requestContext(request),
        detail: { sessionId: params.id },
      });
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String() }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Revoke one device' },
    },
  )

  .post(
    '/auth/sessions/revoke-others',
    async ({ authed, token, request }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      const revoked = await revokeOtherSessions(user.id, token!);
      await recordActivity({
        event: 'sign_out_all',
        userId: user.id,
        ...requestContext(request),
        detail: { revoked },
      });
      return { revoked };
    },
    {
      response: { 200: t.Object({ revoked: t.Number() }) },
      detail: { summary: 'Sign out every other device' },
    },
  )

  .post(
    '/auth/step-up',
    async ({ authed, token, body, request, set }) => {
      const user = requireSession(authed);
      const credential = await findCredentialByIdentifier(user.email);
      const result = await stepUp({
        token: token!,
        user,
        password: body.password,
        passwordHash: credential?.passwordHash ?? null,
        context: requestContext(request),
      });
      if (result.status !== 'ok') refuse(result);
      setSessionCookie(set, result.token, result.expiresAt);
      return { stepUpExpiresAt: result.stepUpExpiresAt.toISOString() };
    },
    {
      body: t.Object({ password: t.String({ minLength: 1, maxLength: 512 }) }),
      response: { 200: t.Object({ stepUpExpiresAt: t.String() }) },
      detail: {
        summary: 'Re-enter the password to unlock sensitive actions',
        description:
          'Opens the step-up window on this session and rotates its token. Sensitive endpoints answer 401 `step_up_required` until it is open.',
      },
    },
  )

  .get(
    '/auth/activity',
    async ({ authed, query }) => {
      const user = requireSession(authed);
      const rows = await listActivity(user.id, query.limit ?? 50);
      return rows.map((row) => ({
        id: row.id,
        event: row.event,
        ipAddress: row.ipAddress,
        deviceLabel: row.deviceLabel,
        createdAt: row.createdAt.toISOString(),
      }));
    },
    {
      query: t.Object({ limit: t.Optional(t.Number({ minimum: 1, maximum: 200 })) }),
      response: {
        200: t.Array(
          t.Object({
            id: t.String(),
            event: t.String(),
            ipAddress: t.Union([t.String(), t.Null()]),
            deviceLabel: t.Union([t.String(), t.Null()]),
            createdAt: t.String(),
          }),
        ),
      },
      detail: { summary: 'Recent security events on this account' },
    },
  )

  // --- passwords -----------------------------------------------------------

  .post(
    '/auth/password/change',
    async ({ authed, body, request }) => {
      const user = requireSession(authed);
      if (!(await verifyUserPassword(user.id, body.currentPassword))) {
        throw new HttpError(401, 'Current password is incorrect');
      }
      const problem = passwordProblem(body.newPassword);
      if (problem) throw new HttpError(400, problem);
      await setPassword(user.id, body.newPassword);
      await recordActivity({
        event: 'password_changed',
        userId: user.id,
        ...requestContext(request),
      });
      return { ok: true };
    },
    {
      body: t.Object({
        currentPassword: t.String({ minLength: 1, maxLength: 512 }),
        newPassword: t.String({ minLength: 1, maxLength: 512 }),
      }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Change the password' },
    },
  )

  .post(
    '/auth/password/forgot',
    async ({ body, request }) => {
      const context = requestContext(request);
      const limit = passwordResetLimiter.consume(
        rateLimitKey(context.ipAddress, body.email.trim().toLowerCase()),
      );
      if (!limit.ok) {
        throw new HttpError(
          429,
          `Too many attempts. Try again in ${retryAfterSeconds(limit.retryAfterMs)} seconds.`,
        );
      }
      const user = await findUserByEmail(body.email);
      if (user) {
        const { token } = await issueAuthToken({
          purpose: 'password_reset',
          identifier: user.email,
          userId: user.id,
        });
        await sendAuthEmail({
          to: user.email,
          subject: 'Reset your password',
          text: 'Use the link below to set a new password. Ignore this email if you did not ask for it.',
          url: `${appUrl()}/reset-password?token=${token}`,
        });
        await recordActivity({
          event: 'password_reset_requested',
          userId: user.id,
          ...requestContext(request),
        });
      }
      // Always the same answer: whether an address has an account is not something
      // this endpoint gets to reveal.
      return { ok: true };
    },
    {
      body: t.Object({ email: t.String({ format: 'email', maxLength: 320 }) }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Send a password reset link' },
    },
  )

  .post(
    '/auth/password/reset',
    async ({ body, request }) => {
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
      const consumed = await consumeAuthToken('password_reset', body.token);
      if (!consumed?.userId) throw new HttpError(400, 'This reset link is no longer valid');
      await setPassword(consumed.userId, body.password);
      // A password change ends every session: if the reset was because someone else
      // had the old one, leaving their session open defeats the point.
      await revokeOtherSessions(consumed.userId, '');
      await recordActivity({
        event: 'password_reset',
        userId: consumed.userId,
        ...requestContext(request),
      });
      return { ok: true };
    },
    {
      body: t.Object({
        token: t.String({ minLength: 1 }),
        password: t.String({ minLength: 1, maxLength: 512 }),
      }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Set a new password with a reset token' },
    },
  )

  // --- address verification ------------------------------------------------

  .post(
    '/auth/email/send-verification',
    async ({ authed }) => {
      const user = requireSession(authed);
      if (user.emailVerified) return { ok: true };
      await sendVerificationMail(user.email, user.id);
      return { ok: true };
    },
    {
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Resend the address confirmation link' },
    },
  )

  .post(
    '/auth/email/verify',
    async ({ body, request }) => {
      const consumed = await consumeAuthToken('email_verification', body.token);
      if (!consumed?.userId) throw new HttpError(400, 'This confirmation link is no longer valid');
      await markEmailVerified(consumed.userId);
      await recordActivity({
        event: 'email_verified',
        userId: consumed.userId,
        ...requestContext(request),
      });
      return { ok: true };
    },
    {
      body: t.Object({ token: t.String({ minLength: 1 }) }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Confirm an email address' },
    },
  )

  // --- second factor -------------------------------------------------------

  .post(
    '/auth/mfa/setup',
    async ({ authed }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      const secret = generateTotpSecret();
      await stageMfaSecret(user.id, encryptTotpSecret(secret));
      return {
        secret,
        uri: totpProvisioningUri({
          issuer: "It's a Plan",
          accountName: user.email,
          secret,
        }),
      };
    },
    {
      response: { 200: t.Object({ secret: t.String(), uri: t.String() }) },
      detail: {
        summary: 'Begin enrolling an authenticator',
        description:
          'Stores a pending secret and returns it with the otpauth URI to scan. It is not active until /auth/mfa/enable succeeds.',
      },
    },
  )

  .post(
    '/auth/mfa/enable',
    async ({ authed, body, request }) => {
      const user = requireSession(authed);
      const record = await getMfaRecord(user.id);
      if (!record) throw new HttpError(400, 'Start the setup again');
      if (!verifyTotpCode(decryptTotpSecret(record), body.code)) {
        throw new HttpError(401, 'That code is not right');
      }
      const { codes, hashes } = prepareRecoveryCodes(generateRecoveryCodes());
      await enableMfa(user.id, hashes);
      await recordActivity({ event: 'mfa_enabled', userId: user.id, ...requestContext(request) });
      // The only time the codes exist in plaintext.
      return { recoveryCodes: codes };
    },
    {
      body: t.Object({ code: t.String({ minLength: 6, maxLength: 12 }) }),
      response: { 200: t.Object({ recoveryCodes: t.Array(t.String()) }) },
      detail: { summary: 'Confirm the authenticator and turn MFA on' },
    },
  )

  .post(
    '/auth/mfa/disable',
    async ({ authed, body, request }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      if (!(await verifyUserPassword(user.id, body.password))) {
        throw new HttpError(401, 'Password is incorrect');
      }
      await disableMfa(user.id);
      await recordActivity({ event: 'mfa_disabled', userId: user.id, ...requestContext(request) });
      return { ok: true };
    },
    {
      body: t.Object({ password: t.String({ minLength: 1, maxLength: 512 }) }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Turn MFA off' },
    },
  )

  .post(
    '/auth/mfa/recovery-codes',
    async ({ authed }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      const record = await getMfaRecord(user.id);
      if (!record?.enabled) throw new HttpError(400, 'MFA is not enabled');
      const { codes, hashes } = prepareRecoveryCodes(generateRecoveryCodes());
      await enableMfa(user.id, hashes);
      return { recoveryCodes: codes };
    },
    {
      response: { 200: t.Object({ recoveryCodes: t.Array(t.String()) }) },
      detail: { summary: 'Replace the recovery codes' },
    },
  )

  // --- personal API keys ---------------------------------------------------

  .get(
    '/auth/api-keys',
    async ({ authed }) => {
      const user = requireSession(authed);
      const keys = await listApiKeys(user.id);
      return keys
        .filter((key) => key.enabled)
        .map((key) => ({
          id: key.id,
          name: key.name,
          start: key.start,
          lastRequestAt: key.lastRequestAt?.toISOString() ?? null,
          createdAt: key.createdAt.toISOString(),
        }));
    },
    {
      response: {
        200: t.Array(
          t.Object({
            id: t.String(),
            name: t.Union([t.String(), t.Null()]),
            start: t.Union([t.String(), t.Null()]),
            lastRequestAt: t.Union([t.String(), t.Null()]),
            createdAt: t.String(),
          }),
        ),
      },
      detail: { summary: 'The account personal API keys' },
    },
  )

  .post(
    '/auth/api-keys',
    async ({ authed, body, request }) => {
      const user = requireSession(authed);
      // A key is a long-lived credential, so issuing one is a sensitive action:
      // the browser answers the 401 `step_up_required` with its password dialog
      // and retries.
      await requireStepUp(authed, 'sensitive');
      const created = await createApiKey({ referenceId: user.id, name: body.name?.trim() || null });
      await recordActivity({
        event: 'api_key_created',
        userId: user.id,
        ...requestContext(request),
        detail: { apiKeyId: created.id },
      });
      // The only time the secret leaves the server.
      return { id: created.id, name: created.name, start: created.start, key: created.key };
    },
    {
      body: t.Object({ name: t.Optional(t.String({ maxLength: 120 })) }),
      response: {
        200: t.Object({
          id: t.String(),
          name: t.Union([t.String(), t.Null()]),
          start: t.Union([t.String(), t.Null()]),
          key: t.String(),
        }),
      },
      detail: { summary: 'Issue a personal API key' },
    },
  )

  .delete(
    '/auth/api-keys/:id',
    async ({ authed, params, request }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      if (!(await revokeApiKey(user.id, params.id))) throw new HttpError(404, 'Key not found');
      await recordActivity({
        event: 'api_key_revoked',
        userId: user.id,
        ...requestContext(request),
        detail: { apiKeyId: params.id },
      });
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String() }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'Revoke a personal API key' },
    },
  )

  // --- profile handle ------------------------------------------------------

  .patch(
    '/auth/profile',
    async ({ authed, body }) => {
      const user = requireSession(authed);
      if (body.username !== undefined) {
        const problem = usernameProblem(body.username);
        if (problem) throw new HttpError(400, problem);
        // Members and agents share one mention namespace, so this checks both.
        if (await isUsernameTaken(body.username, user.id)) {
          throw new HttpError(409, 'Username is already taken. Please try another.');
        }
        await setUsername(user.id, body.username);
      }
      if (body.name !== undefined || body.image !== undefined) {
        await updateProfile(user.id, { name: body.name, image: body.image });
      }
      const updated = await findUserById(user.id);
      return { user: publicUser(updated ?? user) };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
        username: t.Optional(t.String({ minLength: 3, maxLength: 30 })),
        image: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      response: { 200: t.Object({ user: PublicUser }) },
      detail: { summary: 'Change the display name, handle or avatar' },
    },
  )

  .patch(
    '/auth/username',
    async ({ authed, body }) => {
      const user = requireSession(authed);
      const problem = usernameProblem(body.username);
      if (problem) throw new HttpError(400, problem);
      // Members and agents share one mention namespace, so this checks both.
      if (await isUsernameTaken(body.username, user.id)) {
        throw new HttpError(409, 'Username is already taken. Please try another.');
      }
      await setUsername(user.id, body.username);
      return { username: body.username.trim().toLowerCase() };
    },
    {
      body: t.Object({ username: t.String({ minLength: 3, maxLength: 30 }) }),
      response: { 200: t.Object({ username: t.String() }) },
      detail: { summary: 'Change the account handle' },
    },
  )

  // --- step-up preferences -------------------------------------------------

  .patch(
    '/auth/step-up/preferences',
    async ({ authed, body }) => {
      const user = requireSession(authed);
      await requireStepUp(authed, 'sensitive');
      if (body.mode !== undefined && !isStepUpMode(body.mode)) {
        throw new HttpError(400, 'Unknown step-up mode');
      }
      await setStepUpPreferences(user.id, {
        mode: body.mode,
        windowMinutes:
          body.windowMinutes === undefined ? undefined : clampStepUpWindow(body.windowMinutes),
      });
      return { ok: true };
    },
    {
      body: t.Object({
        mode: t.Optional(t.String()),
        windowMinutes: t.Optional(t.Number({ minimum: 1, maximum: 480 })),
      }),
      response: { 200: t.Object({ ok: t.Boolean() }) },
      detail: { summary: 'How often this account is asked to re-enter its password' },
    },
  );

// --- helpers ---------------------------------------------------------------
//
// Shared with ./external, which mounts the magic-link, OAuth, passkey and linked
// account routes over the same conventions.

export function requireSession(authed: { user: AuthUser } | null): AuthUser {
  if (!authed) throw new HttpError(401, 'Authentication required');
  return authed.user;
}

// The gate in front of a dangerous action. Answers 401 with a body the client can
// branch on, which is what opens the "confirm your password" dialog.
export async function requireStepUp(
  authed: { user: AuthUser; session: { stepUpExpiresAt: Date | null } } | null,
  sensitivity: 'sensitive' | 'routine',
): Promise<void> {
  const session = authed?.session;
  const user = authed?.user;
  if (!user || !session) throw new HttpError(401, 'Authentication required');
  if (!stepUpRequired(user.stepUpMode, sensitivity)) return;
  if (stepUpWindowOpen(session.stepUpExpiresAt)) return;
  throw new HttpError(401, 'step_up_required');
}

export function appUrl(): string {
  return (process.env.APP_URL ?? '').split(',')[0]?.trim().replace(/\/+$/, '') ?? '';
}

async function sendVerificationMail(email: string, userId: string): Promise<void> {
  const { token } = await issueAuthToken({
    purpose: 'email_verification',
    identifier: email,
    userId,
  });
  await sendAuthEmail({
    to: email,
    subject: 'Confirm your email address',
    text: 'Use the link below to confirm this address and finish signing up.',
    url: `${appUrl()}/verify-email?token=${token}`,
  });
}

export type { ResponseHeaders };
export { SESSION_COOKIE_NAME };

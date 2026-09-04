import { relations } from 'drizzle-orm';
import { pgTable, text, timestamp, boolean, integer, index, jsonb } from 'drizzle-orm/pg-core';

// The authentication tables. Owned by @repo/auth — no framework generates them any
// more, so the column set is exactly what this app uses and every choice below is
// deliberate.
//
// The three rules that shape it:
//
//  1. Nothing that can be used to authenticate is stored in a form that can be
//     replayed. Session tokens, API keys and recovery codes are SHA-256 digests
//     (they are already high-entropy random values); passwords are argon2id.
//  2. A row is never deleted to end access — it is marked revoked, so the security
//     page and the activity log can still show what happened.
//  3. Anything an operator has to reason about during an incident (which device,
//     which address, when last used) is a column, not a JSON blob.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  role: text('role').default('user'),
  active: boolean('active').default(true),
  scimExternalId: text('scim_external_id'),

  // argon2id, or null for an account that only signs in through a provider or a
  // passkey. Lives on the user rather than on a credential `account` row: there is
  // exactly one password per account, and hiding it inside a provider table is how
  // "which row is the password again?" bugs start.
  passwordHash: text('password_hash'),
  passwordChangedAt: timestamp('password_changed_at'),

  // Brute-force state (see @repo/auth/lockout). Counted per account so an attack
  // spread across many addresses still trips it.
  failedLoginCount: integer('failed_login_count').default(0).notNull(),
  lockedUntil: timestamp('locked_until'),

  // Second factor. The TOTP secret is encrypted with the instance key; the
  // fingerprint identifies which key, so a rotated key reports honestly instead of
  // rejecting every code. Recovery codes are stored as digests, one per array
  // entry, and removed as they are used.
  mfaEnabled: boolean('mfa_enabled').default(false).notNull(),
  mfaEnabledAt: timestamp('mfa_enabled_at'),
  mfaSecretCiphertext: text('mfa_secret_ciphertext'),
  mfaSecretIv: text('mfa_secret_iv'),
  mfaSecretAuthTag: text('mfa_secret_auth_tag'),
  mfaSecretKeyFingerprint: text('mfa_secret_key_fingerprint'),
  mfaRecoveryCodeHashes: jsonb('mfa_recovery_code_hashes').$type<string[]>(),

  // Per-user step-up policy: how often re-entering the password is demanded before
  // a sensitive action, and for how long that counts.
  stepUpMode: text('step_up_mode').default('sensitive').notNull(),
  stepUpWindowMinutes: integer('step_up_window_minutes').default(15).notNull(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    // SHA-256 of the token in the cookie. The token itself is never stored, so a
    // dump of this table cannot be replayed as a set of logins.
    idHash: text('id_hash').notNull().unique(),

    // Two clocks: `expiresAt` is the absolute ceiling (90 days), `lastSeenAt`
    // drives the idle timeout (30 days) and is written at most once per 30s.
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    // "Chrome on macOS" — what the security page shows so a session can be
    // recognised. Empty string when the agent is unrecognisable.
    deviceLabel: text('device_label').default('').notNull(),

    // Set instead of deleting the row, so "signed out from another device" stays
    // visible in the activity log.
    revokedAt: timestamp('revoked_at'),

    // When the second factor was satisfied. Null on a session that has passed the
    // password but still owes a code — that session authenticates nothing.
    mfaPassedAt: timestamp('mfa_passed_at'),

    // Open step-up window: until this instant, sensitive actions may proceed.
    stepUpExpiresAt: timestamp('step_up_expires_at'),
  },
  (table) => [
    index('session_user_id_idx').on(table.userId),
    index('session_last_seen_at_idx').on(table.lastSeenAt),
  ],
);

// A sign-in provider linked to an account: Google, the instance's OIDC provider.
// Passwords are not here (see user.passwordHash) — this table is only ever about a
// third party's idea of the user.
export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('account_user_id_idx').on(table.userId),
    index('account_provider_idx').on(table.providerId, table.accountId),
  ],
);

// One table for every single-use link the app mails out — address verification,
// password reset, magic sign-in, invite acceptance. One table because they are the
// same object with a different `purpose`, and because a token that can be consumed
// in exactly one place is easier to reason about than four near-copies.
export const authToken = pgTable(
  'auth_token',
  {
    id: text('id').primaryKey(),
    // 'email_verification' | 'password_reset' | 'magic_link'
    purpose: text('purpose').notNull(),
    // SHA-256 of the token in the link.
    tokenHash: text('token_hash').notNull().unique(),
    // The address the link was sent to. Kept alongside the user id because a
    // verification link is valid for the address it was mailed to, even if the
    // account's address changes in between.
    identifier: text('identifier').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    // Set the moment the token is redeemed; a second redemption is refused.
    consumedAt: timestamp('consumed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('auth_token_identifier_idx').on(table.identifier),
    index('auth_token_expires_at_idx').on(table.expiresAt),
  ],
);

// WebAuthn credentials. The public key is public by definition; what matters is
// that `counter` moves forward, which is how a cloned authenticator is spotted.
export const passkey = pgTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name'),
    credentialId: text('credential_id').notNull().unique(),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').default(0).notNull(),
    deviceType: text('device_type').default('').notNull(),
    backedUp: boolean('backed_up').default(false).notNull(),
    transports: text('transports'),
    aaguid: text('aaguid'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at'),
  },
  (table) => [index('passkey_user_id_idx').on(table.userId)],
);

// Personal and agent API keys. Only the digest is stored, so a key is shown once
// at creation and never again; `start` is the visible prefix used to tell keys
// apart in the UI.
export const apikey = pgTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    // The user the key acts as. Named `reference_id` because an agent's key
    // references its bot user rather than a person.
    referenceId: text('reference_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name'),
    start: text('start'),
    keyHash: text('key_hash').notNull().unique(),
    enabled: boolean('enabled').default(true).notNull(),
    expiresAt: timestamp('expires_at'),
    lastRequestAt: timestamp('last_request_at'),
    requestCount: integer('request_count').default(0).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('apikey_reference_id_idx').on(table.referenceId)],
);

// The in-flight state of an OAuth/OIDC redirect. Short-lived rows rather than a
// cookie: the callback has to be able to reject a `state` that was never issued,
// and PKCE's verifier must not travel to the browser at all.
export const oauthState = pgTable(
  'oauth_state',
  {
    state: text('state').primaryKey(),
    providerId: text('provider_id').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce'),
    // Where to send the browser after a successful callback. Validated against the
    // app origin before use — an open redirect here would be a phishing gift.
    redirectTo: text('redirect_to'),
    // Set when the flow links a provider to an already signed-in account rather
    // than signing in.
    linkUserId: text('link_user_id').references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => [index('oauth_state_expires_at_idx').on(table.expiresAt)],
);

// What the account's Security page shows and what an operator reads after an
// incident: every sign-in, failed attempt, password change, MFA change and
// revocation, with where it came from.
export const authActivity = pgTable(
  'auth_activity',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    // 'sign_in' | 'sign_in_failed' | 'sign_out' | 'password_changed' | …
    event: text('event').notNull(),
    // The address typed on a failed attempt, when no user matched it.
    identifier: text('identifier'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    deviceLabel: text('device_label'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('auth_activity_user_id_idx').on(table.userId),
    index('auth_activity_created_at_idx').on(table.createdAt),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  passkeys: many(passkey),
  apikeys: many(apikey),
  authTokens: many(authToken),
  authActivity: many(authActivity),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, { fields: [passkey.userId], references: [user.id] }),
}));

export const apikeyRelations = relations(apikey, ({ one }) => ({
  user: one(user, { fields: [apikey.referenceId], references: [user.id] }),
}));

export const authTokenRelations = relations(authToken, ({ one }) => ({
  user: one(user, { fields: [authToken.userId], references: [user.id] }),
}));

export const authActivityRelations = relations(authActivity, ({ one }) => ({
  user: one(user, { fields: [authActivity.userId], references: [user.id] }),
}));

// @repo/auth — the first-party authentication system.
//
// The primitives (tokens, passwords, MFA, lockout, rate limiting, origin checks)
// are framework-free and unit tested; the repositories talk to @repo/db; `service`
// holds the sign-in flows; `oauth` and `passkeys` are the relying-party halves of
// OpenID Connect and WebAuthn. apps/api mounts the HTTP layer over this.
export * from './tokens';
export * from './passwords';
export * from './lockout';
export * from './rate-limit';
export * from './origin';
export * from './device';
export * from './mfa';
export * from './step-up';
export * from './sessions';
export * from './users';
export * from './activity';
export * from './auth-tokens';
export * from './api-keys';
export * from './accounts';
export * from './oauth';
export * from './passkeys';
export * from './service';

// Frontend origins, from APP_URL (comma separated). Mandatory: cookies, the
// WebAuthn relying party and every emailed link are derived from it, so a deploy
// that misses it fails at startup instead of running on a localhost default.
export const trustedOrigins = (process.env.APP_URL ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
if (trustedOrigins.length === 0) {
  throw new Error('APP_URL is not set: public origin(s) of the web app.');
}
if (!process.env.API_URL) {
  throw new Error('API_URL is not set: public origin of the backend.');
}

// User roles. "god" is the owner of the instance: the very first registered user
// gets it automatically; everyone after is a plain "user".
export const USER_ROLES = ['god', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

// The exact values that have to be registered with each identity provider. Shown
// in god mode so the owner can copy them instead of assembling them by hand.
import { redirectUri } from './oauth';
export const GOOGLE_REDIRECT_URI = redirectUri('google');
export const OIDC_REDIRECT_URI = redirectUri('oidc');

// The SCIM provisioner derives a handle the same way sign-up does.
export { deriveUsername as generateUsername } from './users';

// Instance-wide authentication settings (registration mode, mail provider, invite
// links, provider credentials). Managed over HTTP by god mode in apps/api.
export { hasPendingInvite } from './instance';
export { sendAuthEmail } from './mail';
export {
  REGISTRATION_MODES,
  getAuthSettings,
  setAuthSettings,
  getEmailSettings,
  setEmailSettings,
  getEmailConfig,
  resolveEmailConfig,
  getProjectEmailConfig,
  hasConfiguredEmailProvider,
  getGoogleSettings,
  setGoogleSettings,
  getGoogleConfig,
  hasConfiguredGoogle,
  getOidcSettings,
  setOidcSettings,
  getOidcConfig,
  getOidcLabel,
  hasConfiguredOidc,
  getScimSettings,
  setScimSettings,
  rotateScimToken,
  isScimEnabled,
  verifyScimToken,
} from './instance';
export type {
  RegistrationMode,
  AuthSettings,
  InstanceEmailDto,
  InstanceEmailPatch,
  InstanceEmailConfig,
  InstanceGoogleDto,
  InstanceGooglePatch,
  InstanceGoogleConfig,
  InstanceOidcDto,
  InstanceOidcPatch,
  InstanceOidcConfig,
  InstanceScimDto,
} from './instance';

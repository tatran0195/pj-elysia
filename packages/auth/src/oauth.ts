import { and, eq, gt, lt } from 'drizzle-orm';
import { db, oauthState } from '@repo/db';
import * as oidc from 'openid-client';
import { getGoogleConfig, getOidcConfig, isGoogleUsable, isOidcUsable } from './instance';
import { GOOGLE_PROVIDER_ID, OIDC_PROVIDER_ID } from './accounts';

// The OAuth 2.0 / OpenID Connect relying party. Two providers: Google (a fixed
// issuer) and the instance's own OIDC provider (discovered from its well-known
// document). Both go through the authorization-code flow with PKCE and a nonce.
// The protocol itself is delegated to `openid-client` (the certified, WebCrypto
// based client on top of `oauth4webapi`): discovery, authorization URL, code
// exchange, ID token signature/issuer/audience/nonce checks and userinfo.
//
// State lives in the `oauth_state` table rather than a cookie: the callback can
// then be verified without trusting anything the browser sends back beyond the
// state value itself, and a state can be consumed exactly once.

export const OAUTH_PROVIDER_IDS = [GOOGLE_PROVIDER_ID, OIDC_PROVIDER_ID] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(value);
}

// Ten minutes: long enough for a consent screen, short enough that a leaked
// state is worthless by the time anyone finds it.
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const GOOGLE_DISCOVERY = 'https://accounts.google.com/.well-known/openid-configuration';

export interface ProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
}

export interface ResolvedProvider {
  id: OAuthProviderId;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  pkce: boolean;
  metadata: ProviderMetadata;
  // The openid-client configuration behind the metadata: it carries the
  // discovered server document, the client credentials and the JWKS cache.
  config: oidc.Configuration;
}

// Discovered configurations are cached per (discovery URL, client) for a while;
// the JWKS behind them is cached inside openid-client (refreshing on an unknown
// `kid`).
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const configCache = new Map<string, { at: number; config: oidc.Configuration }>();

// Overridable for tests: the test suite stands up a fake provider and routes
// discovery, token and JWKS calls to it.
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (url, init) => fetch(url, init);
let fetchImpl: FetchLike = defaultFetch;
export function setOAuthFetch(next: FetchLike | null): void {
  fetchImpl = next ?? defaultFetch;
  configCache.clear();
}

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function str(doc: Record<string, unknown>, key: string): string | null {
  return typeof doc[key] === 'string' ? (doc[key] as string) : null;
}

// Discovers the issuer behind `discoveryUrl` and builds a client configuration
// for it. Plain-http issuers are only tolerated outside production (the test
// suite's fake provider and local development).
async function discover(
  discoveryUrl: string,
  client: { clientId: string; clientSecret: string },
): Promise<{ metadata: ProviderMetadata; config: oidc.Configuration }> {
  const key = `${discoveryUrl}\u0000${client.clientId}\u0000${client.clientSecret}`;
  const cached = configCache.get(key);
  const insecure = !discoveryUrl.startsWith('https://');
  if (insecure && process.env.NODE_ENV === 'production') {
    throw new OAuthError('insecure_discovery', 'The discovery URL must use https');
  }
  let config = cached && Date.now() - cached.at < DISCOVERY_TTL_MS ? cached.config : null;
  if (!config) {
    try {
      config = await oidc.discovery(
        new URL(discoveryUrl),
        client.clientId,
        { client_secret: client.clientSecret },
        oidc.ClientSecretPost(client.clientSecret),
        {
          [oidc.customFetch]: (url, init) => fetchImpl(url, init as RequestInit),
          execute: insecure ? [oidc.allowInsecureRequests] : [],
        },
      );
    } catch (error) {
      throw new OAuthError('discovery_failed', `Discovery failed: ${(error as Error).message}`);
    }
    // The spec lets a client trust an ID token that arrived over the TLS-secured
    // token endpoint without checking its signature; verify it against the
    // issuer's JWKS anyway so a compromised path still cannot forge identities.
    oidc.enableNonRepudiationChecks(config);
    configCache.set(key, { at: Date.now(), config });
  }
  const doc = config.serverMetadata() as unknown as Record<string, unknown>;
  const issuer = str(doc, 'issuer');
  const authorizationEndpoint = str(doc, 'authorization_endpoint');
  const tokenEndpoint = str(doc, 'token_endpoint');
  const jwksUri = str(doc, 'jwks_uri');
  if (!issuer || !authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    throw new OAuthError('discovery_invalid', 'The discovery document is missing required fields');
  }
  return {
    config,
    metadata: { issuer, authorizationEndpoint, tokenEndpoint, jwksUri, userinfoEndpoint: str(doc, 'userinfo_endpoint') },
  };
}

// Loads the provider's credentials from the instance settings and its endpoints
// from discovery. Returns null when the provider is not usable, which the routes
// turn into a refusal before any redirect happens.
export async function resolveProvider(id: OAuthProviderId): Promise<ResolvedProvider | null> {
  if (id === GOOGLE_PROVIDER_ID) {
    const google = await getGoogleConfig();
    if (!isGoogleUsable(google)) return null;
    const { metadata, config } = await discover(process.env.GOOGLE_DISCOVERY_URL ?? GOOGLE_DISCOVERY, google);
    return {
      id,
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      scopes: ['openid', 'email', 'profile'],
      pkce: true,
      metadata,
      config,
    };
  }
  const settings = await getOidcConfig();
  if (!isOidcUsable(settings)) return null;
  const scopes = settings.scopes.includes('openid') ? settings.scopes : ['openid', ...settings.scopes];
  const { metadata, config } = await discover(settings.discoveryUrl, settings);
  return {
    id,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    scopes,
    pkce: settings.pkce,
    metadata,
    config,
  };
}

// The value registered with the provider. Fixed per provider, and shown in god
// mode so the operator can copy it.
export function redirectUri(id: OAuthProviderId, apiUrl = process.env.API_URL ?? ''): string {
  return `${apiUrl.split(',')[0]!.trim().replace(/\/+$/, '')}/auth/oauth/${id}/callback`;
}

export interface StartedFlow {
  url: string;
  state: string;
}

// Begins the round trip. `redirectTo` is the app path to land on afterwards and
// `linkUserId` is set when a signed-in user is attaching the provider to their
// account rather than signing in.
export async function startOAuthFlow(input: {
  provider: ResolvedProvider;
  redirectTo: string | null;
  linkUserId?: string | null;
  now?: number;
}): Promise<StartedFlow> {
  const now = input.now ?? Date.now();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();

  await db.insert(oauthState).values({
    state,
    providerId: input.provider.id,
    codeVerifier: verifier,
    nonce,
    redirectTo: input.redirectTo,
    linkUserId: input.linkUserId ?? null,
    expiresAt: new Date(now + OAUTH_STATE_TTL_MS),
  });

  const parameters: Record<string, string> = {
    redirect_uri: redirectUri(input.provider.id),
    scope: input.provider.scopes.join(' '),
    state,
    nonce,
  };
  if (input.provider.pkce) {
    parameters.code_challenge = await oidc.calculatePKCECodeChallenge(verifier);
    parameters.code_challenge_method = 'S256';
  }
  if (input.provider.id === GOOGLE_PROVIDER_ID) {
    // Google only returns a refresh token on the first consent; this app never
    // needs one, but asking for online access keeps the consent screen small.
    parameters.access_type = 'online';
  }
  const url = oidc.buildAuthorizationUrl(input.provider.config, parameters);
  return { url: url.toString(), state };
}

export interface ConsumedState {
  providerId: OAuthProviderId;
  codeVerifier: string;
  nonce: string | null;
  redirectTo: string | null;
  linkUserId: string | null;
}

// Redeems a state exactly once. Unknown, expired or already-used states all
// return null; the callback answers the same way for each.
export async function consumeOAuthState(
  state: string | null | undefined,
  now = Date.now(),
): Promise<ConsumedState | null> {
  if (!state) return null;
  const rows = await db
    .delete(oauthState)
    .where(and(eq(oauthState.state, state), gt(oauthState.expiresAt, new Date(now))))
    .returning({
      providerId: oauthState.providerId,
      codeVerifier: oauthState.codeVerifier,
      nonce: oauthState.nonce,
      redirectTo: oauthState.redirectTo,
      linkUserId: oauthState.linkUserId,
    });
  const row = rows[0];
  if (!row || !isOAuthProviderId(row.providerId)) return null;
  return { ...row, providerId: row.providerId };
}

export async function deleteExpiredOAuthStates(now = Date.now()): Promise<number> {
  const deleted = await db
    .delete(oauthState)
    .where(lt(oauthState.expiresAt, new Date(now)))
    .returning({ state: oauthState.state });
  return deleted.length;
}

export interface TokenResponse {
  accessToken: string;
  idToken: string | null;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
  // The ID token's claims as validated by openid-client (signature against the
  // issuer's JWKS, issuer, audience, expiry, nonce). Null for a plain OAuth
  // response without an ID token.
  claims: JWTPayload | null;
}

export type JWTPayload = oidc.IDToken;

function protocolError(error: unknown): OAuthError {
  if (error instanceof OAuthError) return error;
  const message = (error as Error).message ?? String(error);
  const code = (error as { code?: string }).code;
  // openid-client wraps oauth4webapi's error, which in turn names the claim it
  // compared: error.cause (OperationProcessingError).cause.claim.
  const inner = (error as { cause?: { cause?: { claim?: string } } }).cause;
  if (/nonce/i.test(message) || inner?.cause?.claim === 'nonce') {
    return new OAuthError('nonce_mismatch', 'ID token nonce does not match');
  }
  if (error instanceof oidc.ResponseBodyError) {
    return new OAuthError('token_exchange_failed', `Token exchange failed: ${error.error}`);
  }
  // oauth4webapi error codes: OAUTH_JWT_CLAIM_COMPARISON_FAILED,
  // OAUTH_JWT_TIMESTAMP_CHECK_FAILED, OAUTH_KEY_SELECTION_FAILED, …
  if (/^OAUTH_(JWT_|KEY_SELECTION|INVALID_RESPONSE|PARSE_ERROR)/.test(code ?? '') || /ID Token|JWT|signature/i.test(message)) {
    return new OAuthError('id_token_invalid', `ID token rejected: ${message}`);
  }
  return new OAuthError('token_exchange_failed', `Token exchange failed: ${message}`);
}

// Redeems the authorization code. openid-client validates the token response
// and, when `nonce` is given, the ID token that came with it.
export async function exchangeCode(input: {
  provider: ResolvedProvider;
  code: string;
  codeVerifier: string;
  state?: string | null;
  nonce?: string | null;
}): Promise<TokenResponse> {
  const currentUrl = new URL(redirectUri(input.provider.id));
  currentUrl.searchParams.set('code', input.code);
  if (input.state) currentUrl.searchParams.set('state', input.state);
  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(input.provider.config, currentUrl, {
      ...(input.provider.pkce ? { pkceCodeVerifier: input.codeVerifier } : {}),
      ...(input.state ? { expectedState: input.state } : {}),
      ...(input.nonce ? { expectedNonce: input.nonce, idTokenExpected: true } : {}),
    });
  } catch (error) {
    throw protocolError(error);
  }
  return {
    accessToken: tokens.access_token,
    idToken: tokens.id_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiresIn: typeof tokens.expires_in === 'number' ? tokens.expires_in : null,
    scope: tokens.scope ?? null,
    claims: tokens.claims() ?? null,
  };
}

export interface Identity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  claims: JWTPayload;
}

// Reads the identity from the validated ID token claims; when the token did
// not carry an address or name, asks userinfo (openid-client checks that its
// subject matches the token's).
export async function verifyIdentity(input: {
  provider: ResolvedProvider;
  tokens: TokenResponse;
  nonce: string | null;
}): Promise<Identity> {
  const { provider, tokens } = input;
  if (!tokens.idToken || !tokens.claims) {
    throw new OAuthError('no_id_token', 'The provider did not return an ID token');
  }
  const payload = tokens.claims;
  if (input.nonce && payload.nonce !== input.nonce) {
    throw new OAuthError('nonce_mismatch', 'ID token nonce does not match');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new OAuthError('no_subject', 'ID token has no subject');
  }

  let email = typeof payload.email === 'string' ? payload.email : null;
  let emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  let name = typeof payload.name === 'string' ? payload.name : null;
  let picture = typeof payload.picture === 'string' ? payload.picture : null;

  if ((!email || !name) && provider.metadata.userinfoEndpoint) {
    try {
      const info = await oidc.fetchUserInfo(provider.config, tokens.accessToken, payload.sub);
      email ??= typeof info.email === 'string' ? info.email : null;
      if (info.email_verified === true) emailVerified = true;
      name ??= typeof info.name === 'string' ? info.name : null;
      picture ??= typeof info.picture === 'string' ? info.picture : null;
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (/subject/i.test(message)) {
        throw new OAuthError('userinfo_mismatch', 'userinfo subject does not match the ID token');
      }
      // userinfo is a convenience; the ID token already authenticated the user.
    }
  }

  return {
    subject: payload.sub,
    email: email ? email.trim().toLowerCase() : null,
    emailVerified,
    name,
    picture,
    claims: payload,
  };
}

// The unverified payload of a JWT. Used to read an optional claim (OIDC groups)
// off a token that was already verified when it was stored.
export function readJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

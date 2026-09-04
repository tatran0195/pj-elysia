import { useCallback, useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { API_URL, markSigningOut } from '@/lib/api';

// The browser side of authentication.
//
// This used to be better-auth's React client. It is now a thin shim over the
// app's own `/auth/*` endpoints, and it deliberately keeps the shape the rest of
// the app already expects — `signIn.email(...)`, `useSession()`, `{ data, error }`
// results that never throw — so the forty-odd files that call it did not have to
// change when the server moved.
//
// Two conventions worth knowing:
//
//   * every call returns `{ data, error }`. `error` is `{ message, status, code }`
//     or null. Nothing here throws on a refused request; the caller decides.
//   * `credentials: 'include'` everywhere, because the session is an HttpOnly
//     cookie the JavaScript cannot see. Sending the Origin header is what the
//     server's CSRF check reads.

export interface AuthError {
  message: string;
  status: number;
  code?: string;
}

export interface Result<T> {
  data: T | null;
  error: AuthError | null;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  username: string | null;
  displayUsername: string | null;
  role: string;
  active: boolean;
  mfaEnabled: boolean;
  stepUpMode: string;
  stepUpWindowMinutes: number;
  createdAt: string;
}

export interface SessionData {
  user: SessionUser;
}

// Empty while the shell is prerendered in Node, where there is no instance
// environment yet; the browser always has it.
const base = API_URL ? API_URL.replace(/\/+$/, '') : '';

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Result<T>> {
  try {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      credentials: 'include',
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      return { data: null, error: toError(payload, response.status) };
    }
    return { data: payload as T, error: null };
  } catch (cause) {
    // A network failure is not a refusal; say so rather than reporting a status
    // the server never sent.
    return {
      data: null,
      error: { message: cause instanceof Error ? cause.message : 'Network error', status: 0 },
    };
  }
}

function toError(payload: unknown, status: number): AuthError {
  if (typeof payload === 'string' && payload.trim()) {
    return { message: payload, status, code: payload };
  }
  if (payload && typeof payload === 'object') {
    const body = payload as { message?: string; error?: string; code?: string };
    const message = body.message ?? body.error ?? 'Request failed';
    return { message, status, code: body.code ?? message };
  }
  return { message: 'Request failed', status };
}

// --- session ---------------------------------------------------------------

// Module-level cache so every component that calls useSession() shares one
// request and one answer, and a sign-in updates all of them at once.
let cached: SessionData | null = null;
let loaded = false;
let inFlight: Promise<SessionData | null> | null = null;
const subscribers = new Set<(session: SessionData | null) => void>();

function publish(session: SessionData | null): void {
  cached = session;
  loaded = true;
  for (const notify of subscribers) notify(session);
}

export async function getSession(): Promise<Result<SessionData | null>> {
  const result = await call<{ user: SessionUser | null }>('/auth/session');
  if (result.error) return { data: null, error: result.error };
  const session = result.data?.user ? { user: result.data.user } : null;
  publish(session);
  return { data: session, error: null };
}

function loadOnce(): Promise<SessionData | null> {
  inFlight ??= getSession()
    .then((result) => result.data ?? null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useSession(): {
  data: SessionData | null;
  isPending: boolean;
  refetch: () => Promise<void>;
} {
  const [session, setSession] = useState<SessionData | null>(cached);
  const [isPending, setPending] = useState(!loaded);

  useEffect(() => {
    subscribers.add(setSession);
    if (!loaded) {
      void loadOnce().then(() => setPending(false));
    } else {
      setPending(false);
    }
    return () => {
      subscribers.delete(setSession);
    };
  }, []);

  const refetch = useCallback(async () => {
    await getSession();
  }, []);

  return { data: session, isPending, refetch };
}

// --- sign in and out -------------------------------------------------------

interface SignInAnswer {
  status: 'ok' | 'mfa_required';
  user: SessionUser | null;
}

async function passwordSignIn(identifier: string, password: string): Promise<Result<SignInAnswer>> {
  const result = await call<SignInAnswer>('/auth/sign-in', {
    method: 'POST',
    body: { identifier, password },
  });
  if (result.data?.user) publish({ user: result.data.user });
  return result;
}

export const signIn = {
  // The sign-in screen has one field; both of these post the same request, which
  // is why the server takes an `identifier` rather than an email or a username.
  email: ({ email, password }: { email: string; password: string }) =>
    passwordSignIn(email, password),
  username: ({ username, password }: { username: string; password: string }) =>
    passwordSignIn(username, password),

  // The second factor, when the account has one. The cookie from the first step
  // is already set; this exchanges it for a full session.
  mfa: async ({ code }: { code: string }) => {
    const result = await call<{ user: SessionUser; recoveryCodesLeft: number | null }>(
      '/auth/mfa/verify',
      { method: 'POST', body: { code } },
    );
    if (result.data?.user) publish({ user: result.data.user });
    return result;
  },

  // The redirect-based methods. The server answers with the provider's
  // authorization URL and the browser navigates there; the provider sends it
  // back to the api callback, which sets the cookie and redirects into the app.
  social: async (body: { provider: string; callbackURL?: string; errorCallbackURL?: string }) =>
    beginOAuth(body.provider, body.callbackURL),
  oauth2: async (body: { providerId: string; callbackURL?: string; errorCallbackURL?: string }) =>
    beginOAuth(body.providerId, body.callbackURL),

  magicLink: (body: { email: string; callbackURL?: string }) =>
    call<{ ok: boolean }>('/auth/magic-link/send', { method: 'POST', body }),

  // Redeems the token from the emailed link.
  magicLinkVerify: async ({ token }: { token: string }) => {
    const result = await call<SignInAnswer>('/auth/magic-link/verify', {
      method: 'POST',
      body: { token },
    });
    if (result.data?.user) publish({ user: result.data.user });
    return result;
  },

  // WebAuthn: fetch a challenge, let the browser/authenticator sign it, hand the
  // assertion back. Usernameless — the authenticator says whose credential it is.
  passkey: async (): Promise<Result<SignInAnswer>> => {
    const options = await call<{ challengeId: string; options: never }>(
      '/auth/passkeys/authenticate/options',
      { method: 'POST' },
    );
    if (options.error || !options.data) return { data: null, error: options.error };
    let assertion: unknown;
    try {
      assertion = await startAuthentication({ optionsJSON: options.data.options });
    } catch (cause) {
      return { data: null, error: webAuthnError(cause) };
    }
    const result = await call<SignInAnswer>('/auth/passkeys/authenticate/verify', {
      method: 'POST',
      body: { challengeId: options.data.challengeId, response: assertion },
    });
    if (result.data?.user) publish({ user: result.data.user });
    return result;
  },
};

async function beginOAuth(provider: string, callbackURL?: string): Promise<Result<{ url: string }>> {
  const result = await call<{ url: string }>(`/auth/oauth/${provider}/start`, {
    method: 'POST',
    body: { callbackURL: callbackURL ?? '/' },
  });
  if (result.data?.url) window.location.assign(result.data.url);
  return result;
}

// The browser's own WebAuthn refusals: a cancelled prompt, no authenticator, an
// insecure context. Surfaced as an error the form can show; nothing was sent.
function webAuthnError(cause: unknown): AuthError {
  const name = cause instanceof Error ? cause.name : '';
  const message =
    name === 'NotAllowedError'
      ? 'The passkey prompt was cancelled'
      : cause instanceof Error
        ? cause.message
        : 'Passkey unavailable';
  return { message, status: 0, code: name || 'webauthn' };
}

export const signUp = {
  // `callbackURL` is accepted for call-site compatibility; the confirmation
  // link always lands on the app's own /verify-email route.
  email: async ({
    email,
    password,
    name,
  }: {
    email: string;
    password: string;
    name?: string;
    callbackURL?: string;
  }) => {
    const result = await call<{ user: SessionUser }>('/auth/sign-up', {
      method: 'POST',
      body: { email, password, name: name ?? email.split('@')[0] ?? email },
    });
    if (result.data?.user) publish({ user: result.data.user });
    return result;
  },
};

// Sign out through this wrapper rather than through the client: it tells lib/api
// that the 401s the dropped session causes are expected, so they do not send the
// browser to the expired-session screen.
export async function signOut(): Promise<Result<{ ok: boolean }>> {
  markSigningOut();
  const result = await call<{ ok: boolean }>('/auth/sign-out', { method: 'POST' });
  publish(null);
  return result;
}

// --- account ---------------------------------------------------------------

export const updateUser = async (body: {
  name?: string;
  username?: string;
  displayUsername?: string;
  image?: string | null;
}) => {
  const result = await call<{ user: SessionUser }>('/auth/profile', {
    method: 'PATCH',
    // displayUsername follows the handle; the server derives it.
    body: { name: body.name, username: body.username, image: body.image },
  });
  if (result.data?.user) publish({ user: result.data.user });
  return result;
};

export const changePassword = (body: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}) => call<{ ok: boolean }>('/auth/password/change', { method: 'POST', body });

export const requestPasswordReset = (body: { email: string; redirectTo?: string }) =>
  call<{ ok: boolean }>('/auth/password/forgot', { method: 'POST', body: { email: body.email } });

export const resetPassword = (body: { newPassword: string; token: string }) =>
  call<{ ok: boolean }>('/auth/password/reset', {
    method: 'POST',
    body: { password: body.newPassword, token: body.token },
  });

export const sendVerificationEmail = (_body: { email: string; callbackURL?: string }) =>
  call<{ ok: boolean }>('/auth/email/send-verification', { method: 'POST', body: {} });

export const verifyEmail = (body: { token: string }) =>
  call<{ ok: boolean }>('/auth/email/verify', { method: 'POST', body });

// Devices and the security history, which the account's Security page shows.
export const listSessions = () =>
  call<
    {
      id: string;
      deviceLabel: string;
      ipAddress: string | null;
      createdAt: string;
      lastSeenAt: string;
      current: boolean;
    }[]
  >('/auth/sessions');

export const revokeSession = (id: string) =>
  withStepUp(() =>
    call<{ ok: boolean }>(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  );

export const revokeOtherSessions = () =>
  withStepUp(() => call<{ revoked: number }>('/auth/sessions/revoke-others', { method: 'POST' }));

export const listActivity = () =>
  call<{ id: string; event: string; ipAddress: string | null; createdAt: string }[]>(
    '/auth/activity',
  );

// Re-enter the password to unlock a sensitive action for a while.
export const stepUp = (body: { password: string }) =>
  call<{ stepUpExpiresAt: string }>('/auth/step-up', { method: 'POST', body });

export const mfa = {
  setup: () =>
    withStepUp(() => call<{ secret: string; uri: string }>('/auth/mfa/setup', { method: 'POST' })),
  enable: (body: { code: string }) =>
    call<{ recoveryCodes: string[] }>('/auth/mfa/enable', { method: 'POST', body }),
  disable: (body: { password: string }) =>
    withStepUp(() => call<{ ok: boolean }>('/auth/mfa/disable', { method: 'POST', body })),
  newRecoveryCodes: () =>
    withStepUp(() =>
      call<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { method: 'POST' }),
    ),
};

// --- personal API keys -----------------------------------------------------

interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: string;
}

export const apiKey = {
  // Shaped as `{ apiKeys }` because that is what the keys page already reads.
  list: async () => {
    const result = await call<ApiKeyRow[]>('/auth/api-keys');
    if (result.error) return { data: null, error: result.error };
    return { data: { apiKeys: result.data ?? [] }, error: null };
  },
  create: (body: { name?: string }) =>
    withStepUp(() =>
      call<{ id: string; name: string | null; start: string | null; key: string }>('/auth/api-keys', {
        method: 'POST',
        body,
      }),
    ),
  delete: ({ keyId }: { keyId: string }) =>
    withStepUp(() =>
      call<{ ok: boolean }>(`/auth/api-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' }),
    ),
};

// --- passkeys and linked providers -----------------------------------------

export interface PasskeyRecord {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  aaguid: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export const passkey = {
  // Registration is a sensitive action: the options call is behind step-up,
  // which `withStepUp` answers with the password dialog when needed.
  addPasskey: async (body?: { name?: string }): Promise<Result<PasskeyRecord>> => {
    const options = await withStepUp(() =>
      call<{ challengeId: string; options: never }>('/auth/passkeys/register/options', {
        method: 'POST',
      }),
    );
    if (options.error || !options.data) return { data: null, error: options.error };
    let attestation: unknown;
    try {
      attestation = await startRegistration({ optionsJSON: options.data.options });
    } catch (cause) {
      return { data: null, error: webAuthnError(cause) };
    }
    return call<PasskeyRecord>('/auth/passkeys/register/verify', {
      method: 'POST',
      body: { challengeId: options.data.challengeId, response: attestation, name: body?.name ?? null },
    });
  },
  deletePasskey: (body: { id: string }) =>
    withStepUp(() => call<{ ok: boolean }>(`/auth/passkeys/${body.id}`, { method: 'DELETE' })),
  listUserPasskeys: () => call<PasskeyRecord[]>('/auth/passkeys'),
};

export interface LinkedAccountRecord {
  id: string;
  providerId: string;
  accountId: string;
  createdAt: string;
}

export const listAccounts = () => call<LinkedAccountRecord[]>('/auth/accounts');

export const linkSocial = async (body: { provider: string; callbackURL?: string }) => {
  const result = await call<{ url: string }>(`/auth/oauth/${body.provider}/start`, {
    method: 'POST',
    body: { callbackURL: body.callbackURL ?? '/account/accounts', link: true },
  });
  if (result.data?.url) window.location.assign(result.data.url);
  return result;
};

export const unlinkAccount = (body: { providerId: string; accountId?: string }) =>
  withStepUp(() =>
    call<{ ok: boolean }>(
      `/auth/accounts/${body.providerId}${body.accountId ? `?accountId=${encodeURIComponent(body.accountId)}` : ''}`,
      { method: 'DELETE' },
    ),
  );

// --- step-up ---------------------------------------------------------------
//
// A sensitive endpoint answers 401 `step_up_required` when the session has not
// confirmed its password recently. The security page registers a prompt here;
// `withStepUp` runs the call, and on that refusal asks the prompt for the
// password, posts it, and retries once. Without a registered prompt the refusal
// is returned as is.

type StepUpPrompt = () => Promise<string | null>;
let stepUpPrompt: StepUpPrompt | null = null;

export function registerStepUpPrompt(prompt: StepUpPrompt | null): void {
  stepUpPrompt = prompt;
}

export function isStepUpRefusal(error: AuthError | null): boolean {
  return !!error && error.status === 401 && /step_up_required/.test(error.message);
}

export async function withStepUp<T>(action: () => Promise<Result<T>>): Promise<Result<T>> {
  const first = await action();
  if (!isStepUpRefusal(first.error) || !stepUpPrompt) return first;
  const password = await stepUpPrompt();
  if (!password) return first;
  const unlocked = await stepUp({ password });
  if (unlocked.error) return { data: null, error: unlocked.error };
  return action();
}

// The object the app used to import from better-auth. Kept so existing imports
// (`authClient.apiKey.list()`, `authClient.signOut()`) resolve unchanged.
export const authClient = {
  signIn,
  withStepUp,
  registerStepUpPrompt,
  signUp,
  signOut,
  useSession,
  getSession,
  updateUser,
  changePassword,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  verifyEmail,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  listActivity,
  stepUp,
  mfa,
  apiKey,
  passkey,
  listAccounts,
  linkSocial,
  unlinkAccount,
};

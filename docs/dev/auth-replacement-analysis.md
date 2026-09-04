# Replacing better-auth with an instatic-style auth system

Analysis of what better-auth actually does for this repo, what
[kulczy/instatic](https://github.com/kulczy/instatic) does instead, and what a
replacement would cost. Written before any code changed, so it can be argued with.

---

## 1. What better-auth does here today

### 1.1 Where it lives

| Piece | Path | Size |
| --- | --- | --- |
| Server instance | `packages/auth/src/index.ts` | 620 lines |
| Instance settings (god mode) | `packages/auth/src/instance.ts` | 533 lines |
| Mail hooks | `packages/auth/src/mail.ts` | 32 lines |
| HTTP mount | `apps/api/src/app.ts` — `.all('/api/auth/*')` | 1 route |
| Session on the request | `apps/api/src/shared/auth-context.ts` — `auth.api.getSession()` | 42 lines |
| Browser client | `apps/web/src/lib/auth-client.ts` | ~70 lines |
| Call sites | 42 web files reference `authClient`; 37 files across the repo import `better-auth` | — |

### 1.2 Feature surface actually in use

Plugins enabled in `packages/auth/src/index.ts`:

- **email + password** (`signIn.email`, `signUp.email`)
- **username** (`signIn.username`; the sign-in field accepts either, and a username
  is derived from the address at sign-up)
- **passkey / WebAuthn** (`@better-auth/passkey`) — add from the security page,
  then `signIn.passkey`
- **API keys** (`@better-auth/api-key`) — personal keys on `/account/api-keys`,
  also how agents authenticate
- **magic link** — offered when the instance enables it
- **generic OAuth (OIDC)** + **Google social** — one configurable provider each
- **openAPI** — the auth surface's own docs

Around them: email verification, password reset by email, change password,
account linking/unlinking (`/account/accounts`), instance policies read from
`/auth-config`, SCIM provisioning (`apps/api/src/modules/scim`, 3 files import
better-auth), project invites that sign up or sign in the invitee, and a
`role: 'god'` column driving god mode.

### 1.3 The model

- **Session** = a random token stored **in plaintext** in `session.token`
  (unique), plus `expires_at`, `ip_address`, `user_agent`. Cookie is
  `better-auth.session_token` (or `__Secure-…` on https), signed, `SameSite=Lax`,
  optional `Domain` from `COOKIE_DOMAIN` via the cross-subdomain plugin.
- **Password** hashing is better-auth's default (scrypt), stored on
  `account.password` for `provider_id = 'credential'`.
- **Authorization** is ad hoc: `session.user.role === 'god'` for instance
  administration, project membership tables for everything else.
- **Deactivation** is checked twice — `session.create.before` (SCIM sets
  `user.active = false`) and again in `auth-context` for already-open sessions.
- **CSRF** relies on `SameSite=Lax` plus better-auth's `trustedOrigins`.

### 1.4 What it costs

- Six `node_modules` packages (`better-auth`, two official plugins,
  `@better-auth/passkey`, `@better-auth/api-key`, the client) and their schema
  expectations pinned into `packages/db/src/schema/auth.ts`.
- Framework opacity: this migration already hit two examples — the client reads
  any path in `baseURL` as its base path (so an API behind `/__api` 404s every
  auth call), and `getSessionCookie()` picks the cookie name from the request
  scheme (so a proxy that forgets `x-forwarded-proto` signs everyone out).
- Behaviour you cannot see in this repo's source: token format, rotation policy,
  rate limiting, what `Set-Cookie` gets emitted.

---

## 2. What instatic does instead

All of it is first-party code, ~2,500 lines, no auth dependency:

| Concern | File | Approach |
| --- | --- | --- |
| Token + hashing | `server/auth/tokens.ts` | 32 random bytes, base64url; **only the SHA-256 hash** is stored (`sessions.id_hash`); argon2id passwords via `Bun.password` |
| Session lifecycle | `server/auth/sessions.ts` | 90-day absolute expiry, 30-day idle expiry via `last_seen_at`, whose write is debounced to one per session per 30 s; rotation on privilege change |
| Cookie | `server/handlers/cms/session.ts` | `instatic_admin_session`, `Path=/admin; HttpOnly; SameSite=Lax` + `Secure` derived from the **configured public origin**, never from `X-Forwarded-Proto` |
| Request guards | `server/auth/authz.ts` | `requireAuthenticatedUser`, `requireCapability`, `requireAnyCapability`, `requireStepUp` |
| Roles | `server/auth/capabilities.ts` | capability strings on a role row, not a magic `role === 'god'` string |
| CSRF | `server/auth/security.ts` | explicit `Origin` allowlist on POST/PUT/PATCH/DELETE, from `PUBLIC_ORIGIN`; forwarded headers deliberately ignored |
| Client IP | `server/auth/security.ts` | `X-Forwarded-For` honoured only from configured `TRUSTED_PROXY_CIDRS`, for audit/rate-limit keys only |
| Brute force | `rateLimit.ts` + `lockout.ts` | in-process sliding window keyed by `(ip, email)`, **and** per-account exponential lockout 15 min → 24 h after 5 failures |
| Timing | `session.ts` | fixed argon2id dummy hash verified on the unknown-email branch |
| MFA | `mfa.ts`, `totpSecrets.ts` | TOTP with ±1 step window, recovery codes, secret encrypted at rest (ciphertext + IV + key fingerprint) |
| Step-up | `stepUpPolicy.ts` | `step_up_expires_at` on the session; sensitive actions return `401 {error:'step_up_required'}` |
| Devices | `deviceLabel.ts`, `authSessions.ts` | UA-derived label, session list, revoke one, revoke all others |

Endpoints (`server/handlers/cms/auth.ts`, 841 lines):
`POST /login`, `POST /auth/mfa/verify`, `POST /logout`, `GET /me`,
`GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/step-up`,
`GET /auth/activity`, `POST /logout-all`.

**What instatic does not have:** OAuth/OIDC, social sign-in, passkeys, magic
links, API keys, email verification, password reset by email, invites, SCIM. It
is a single-tenant admin login for a CMS — the whole design assumes an operator
with a password and a TOTP app.

---

## 3. Side by side

| Capability | better-auth (today) | instatic | If we port instatic's approach |
| --- | --- | --- | --- |
| Email + password | ✅ scrypt | ✅ argon2id | Straight port; legacy hashes need a verify-and-upgrade path |
| Username sign-in | ✅ plugin | ➖ | ~20 lines (one more `where`) |
| Session storage | plaintext token | SHA-256 hash | **Security win** — a DB leak stops being a session leak |
| Idle timeout | ➖ | ✅ 30 d | New |
| Session list / revoke device | partial | ✅ | New, with device labels |
| Rate limit + lockout | better-auth defaults | ✅ explicit, two layers | New and auditable |
| MFA (TOTP) | ➖ | ✅ | New |
| Step-up re-auth | ➖ | ✅ | New |
| CSRF | `SameSite` + trustedOrigins | explicit Origin check | Equivalent, but visible |
| Capabilities | `role === 'god'` | capability strings | Optional refactor |
| Passkeys | ✅ | ➖ | **Must be written** (~400 lines + WebAuthn lib) or dropped |
| API keys | ✅ | ➖ | **Must be written** (~200 lines) or dropped |
| Magic link | ✅ | ➖ | ~150 lines (token table + mail) or dropped |
| OIDC / Google | ✅ | ➖ | **Must be written** (~500 lines, the risky part) or dropped |
| Email verification / reset | ✅ | ➖ | ~250 lines (both are the same token flow) |
| SCIM user provisioning | ✅ (3 files) | ➖ | Rewires onto the new user repo |

---

## 4. What a replacement looks like in this repo

### 4.1 Target shape

```
packages/auth/src/
  tokens.ts        random token, sha256, argon2id, expiry windows
  sessions.ts      create / find / touch / rotate / revoke, idle + absolute
  passwords.ts     hash, verify, verify-and-upgrade legacy scrypt
  lockout.ts       per-account exponential backoff (pure)
  rate-limit.ts    per (ip, identifier) sliding window (pure)
  origin.ts        CSRF origin allowlist, client IP attribution
  index.ts         requireUser / requireGod / requireStepUp guards for Elysia

apps/api/src/modules/auth/
  routes.ts        POST /auth/login|logout|register|password/*,
                   GET  /auth/me|sessions|activity,
                   DELETE /auth/sessions/:id, POST /auth/step-up

apps/web/src/lib/auth-client.ts   thin fetch wrapper, same exported names
```

`apps/web` keeps its current API — `signIn`, `signUp`, `useSession`,
`signOut`, … — so the 42 call sites stay untouched, exactly like the
`next-intl` → `use-intl` swap.

### 4.2 Schema

Keep `user`; replace `session`:

```sql
alter table "session" add column id_hash text;      -- sha256, unique
alter table "session" add column last_seen_at timestamptz not null default now();
alter table "session" add column device_label text not null default '';
alter table "session" add column revoked_at timestamptz;
alter table "session" add column step_up_expires_at timestamptz;
-- later: drop column token
alter table "user" add column failed_login_count int not null default 0;
alter table "user" add column locked_until timestamptz;
```

`account` stays (it holds the password and any linked provider). `passkey` and
`apikey` stay or go with the decision below.

### 4.3 Password hashes

better-auth wrote **scrypt** hashes; instatic verifies **argon2id**. Existing
users must not be locked out, so login does: try argon2id → on a legacy-format
hash, verify with the old scheme, and on success re-hash to argon2id in place.
That code is ~30 lines and can be deleted a release later.

### 4.4 Phasing

1. Primitives + schema migration + tests (no behaviour change; better-auth still serves).
2. New `/auth/*` endpoints alongside better-auth; both read the same tables.
3. Web client swapped to the new endpoints behind the existing exports.
4. Passkeys / API keys / OIDC / magic link — per the scope decision below.
5. SCIM + invites rewired; better-auth and its five packages removed.
6. Optional: MFA, step-up, capabilities, device list — the parts of instatic that
   are *better* than what is here now.

Each phase is independently shippable and the browser walk
(`~/shots/walk.mjs`, 43 screens) re-runs as the regression net.

### 4.5 Risks

- **OIDC/Google.** Writing an OAuth client is where bespoke auth usually gets it
  wrong (state/PKCE/nonce, token validation, JWKS rotation). If the instance
  needs SSO, keeping a library for *just* that is defensible.
- **Passkeys.** WebAuthn needs a verification library (`@simplewebauthn/server`)
  regardless; only the plugin glue disappears.
- **API keys** authenticate agents and the MCP surface — anything dropped there
  breaks integrations already issued.
- **Sessions are invalidated** the moment the cookie name or token format
  changes. Everyone signs in again once; that has to be an accepted cost (or the
  old cookie is honoured read-only for one release).

---

## 5. Recommendation

Port instatic's **core**: hashed session tokens, argon2id, idle+absolute
expiry, explicit origin/CSRF handling, rate limit + lockout, and the guard
helpers. That removes the framework from the hot path, is strictly more secure
than the current session storage, and is ~1,200 lines this repo owns.

Be deliberate about the plugins. Email/password, username, magic link, email
verification, password reset and API keys are all small and worth owning.
Passkeys need a WebAuthn library; OIDC/Google is the one place where "replace
the library" buys the least and risks the most.

---

## 6. Where it stands

All five phases are done. `better-auth` and its plugins are gone from every
`package.json` and from the lockfile; nothing under `apps/` or `packages/`
imports it.

| Phase | What it did | State |
| --- | --- | --- |
| 1 | Primitives (tokens, passwords, lockout, rate limit, origin, MFA, step-up), schema, migration `0115` | done, 70 unit tests |
| 2 | Session/user/activity repositories, sign-in flows, ~20 `/auth/*` endpoints | done, 20 integration tests |
| 3 | Hand-written API keys | done, 9 integration tests |
| 4 | The browser: `lib/auth-client.ts` is a fetch shim over `/auth/*`; profile and personal-key endpoints | done, 13 browser checks |
| 5 | Magic links, OAuth/OIDC relying party, passkeys, linked providers, step-up dialog; dependency removed | done, 22 integration tests |

### What phase 5 added

- **Magic links** (`packages/auth/src/auth-tokens.ts`, purpose `magic_link`;
  routes `POST /auth/magic-link/send|verify`). The link points at the app
  (`/login?magic=<token>`), which redeems it, so the token never appears in a
  URL on the api origin. Sending is rate limited per (ip, address) and answers
  identically for known and unknown addresses. Redeeming marks the address
  confirmed and, when registration allows, creates the account.
- **OAuth 2.0 / OIDC** (`packages/auth/src/oauth.ts`). A relying party on `openid-client`:
  discovery, authorization-code with PKCE (S256) and a nonce, state in
  the `oauth_state` table (single use, 10 min), token exchange, ID-token
  verification against the issuer's JWKS via `openid-client` (signature, issuer,
  audience, expiry, nonce), userinfo fallback. Google is the fixed issuer; the
  instance OIDC provider is discovered from its configured URL. The callback
  links by `(provider, sub)`, matches an existing account by address only when
  both sides have the address confirmed, and otherwise registers subject to the
  instance registration mode. Redirect URIs are now
  `<API_URL>/auth/oauth/{google|oidc}/callback` — **operators must re-register
  these with their provider.** The OIDC `groups` → SCIM group sync is preserved
  (`apps/api/src/modules/scim/oidc-sync.ts`).
- **Passkeys** (`packages/auth/src/passkeys.ts`). `@simplewebauthn/server`
  does the ceremony; this repo owns the relying-party policy, the single-use
  in-memory challenge store (5 min) and the `passkey` table. Registration is
  behind step-up; sign-in is usernameless. A passkey counts as both factors,
  so TOTP is not asked after it. `@simplewebauthn/browser` on the web side.
- **Linked providers** (`packages/auth/src/accounts.ts`; `GET /auth/accounts`,
  `DELETE /auth/accounts/:provider`). The password is reported as provider
  `credential`. Disconnecting the last way in is refused.
- **Step-up in the browser.** `StepUpPrompt` is mounted at the root; the
  client's `withStepUp()` wraps every sensitive call, catches
  `step_up_required`, asks for the password, posts `/auth/step-up` and retries.
  The gate is back on personal API keys, and on passkey/provider removal, MFA
  management and session revocation.
- **MFA code step on the sign-in form**, reached from a password, a magic link
  or an OAuth callback (`?mfa=1`).
- `/auth/password/forgot` is now rate limited (the limiter existed but was not
  wired).

### Dependencies

Two were added, both current and narrow:

- `openid-client` 6 (on `oauth4webapi`, WebCrypto-only, certified relying
  party) does the OAuth 2.0 / OIDC protocol work in `packages/auth/src/oauth.ts`:
  discovery, authorization URL, PKCE, code exchange, ID-token signature /
  issuer / audience / expiry / nonce checks (`enableNonRepudiationChecks` is on
  so the signature is always verified against the JWKS) and userinfo with the
  subject check. It replaced an earlier hand-written exchange that only used
  `jose` for JWS verification; `jose` is no longer a dependency anywhere.
- `@simplewebauthn/server` + `@simplewebauthn/browser` 14 for CBOR / COSE /
  attestation parsing.

Everything else — sessions, passwords, MFA, lockout, rate limits, CSRF, API
keys, tokens, OAuth state storage and the account-linking policy, the passkey
policy — is first-party. The test suite's fake identity provider signs its
RS256 ID tokens with `node:crypto` directly.

### Verified in a browser

Headless Chromium against the production build, signing in through the real
form: the session cookie is set and HttpOnly, pages behind the session gate
load, the account pages render, a profile rename persists, a password change
takes effect, an API key can be created *after the step-up dialog*, and
signing out lands back on `/login`. No console or page errors.

### Known gaps

- Passkey challenges live in process memory. Behind a load balancer, pin both
  halves of a ceremony to one api instance or move the map to a table.
- The MFA enrolment, device-list and activity endpoints are live and tested
  but the account UI for them is still to come.
- Provider linking from the Accounts page is wired for Google; the OIDC
  provider can be linked through the same endpoint but has no button yet.

### Running the checks

`apps/api/src/__tests__/helpers/db.ts` no longer TRUNCATEs all ~110 tables
between tests (that fsyncs a file per table and cost 1–3 s per test); it
DELETEs from the tables that actually hold rows inside one transaction with
FK triggers off, then restarts used sequences. Same end state, ~50× faster:
the auth/god/scim/shared subset went from 362 s to 47 s and the whole
`apps/api` suite (1532 tests) now runs in about five minutes. The attachment,
import, chat and agent-skill suites need an S3 endpoint on `:9000`
(`S3_*` in `.env.test`); a local MinIO with the `planner-attachments` bucket is
enough.

```sh
bash /home/user/check-auth-work.sh      # every edit still present after a sandbox reset
cd packages/auth && bun test            # 70 unit tests
cd apps/api && bun test --env-file=../../.env.test src/modules/auth   # 51 integration tests
node /home/user/shots/auth-walk.mjs     # browser checks (needs the stack on :8080)
grep -rn better-auth --include=package.json . | grep -v node_modules   # nothing
```

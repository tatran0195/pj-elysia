# The web runtime

`apps/web` is a **React Router 8 app in framework mode with `ssr: false`** — a client-rendered
single-page app, built by Vite, served by a small Express process. This page describes the pieces
that are not obvious from the route table, and what replaced each Next.js feature.

## The build

| Command                | What it does                                                        |
| ---------------------- | -------------------------------------------------------------------- |
| `bun run dev`          | `react-router dev` — Vite dev server on :3001, HMR, typegen on change |
| `bun run build`        | `react-router build` — `build/client` (assets + one `index.html`)     |
| `bun run start`        | `node server/index.mjs` — serves that build                           |
| `bun run typecheck`    | `react-router typegen && tsc --noEmit`                                |

The toolchain runs on Node (22.22+ is the React Router 8 floor); the rest of the monorepo still
runs on Bun.

## Routing

`src/routes.ts` is the whole route table, and `src/routes/**` holds one thin module per route that
mounts a feature page — the same split the `app/` tree had. Two layout routes carry the chrome:

- `routes/project/layout.tsx` — the planner `Shell` for everything under `/project/:projectKey`
- `routes/god/layout.tsx` — the instance-wide `GodShell` under `/god`
- `routes/share/layout.tsx` — the public read-only pages, marked `noindex` through its `meta`

`src/root.tsx` is the document: `<html>`, the providers (theme, translations, TanStack Query, the
session gate) and the error boundary. It is rendered once in Node at build time to produce
`index.html`, so nothing it touches at module scope may assume a browser.

There are no loaders or actions. Every screen reads through TanStack Query against the API, which
is what the app did before the migration.

## The server

`server/index.mjs` (Express) serves `build/client` and falls back to `index.html`. Everything with
request-time behaviour lives in `server/middleware.mjs`, which the Vite dev server loads too, so
dev and production behave the same:

- **`/__env.js`** — `API_URL`, `PRIVACY_URL` and `TERMS_URL` read from the process and written as
  `window.__ITSAPLAN_ENV__`. `root.tsx` loads it as a blocking script in `<head>`, so a module
  reading `runtimeEnv()` while it is imported already sees the values. Nothing per-instance is
  ever baked into the bundle: one image serves any instance.
- **`/media/*`** — a narrow proxy for the API's public avatar and attachment routes, so the
  browser fetches them same-origin. Only three roots are reachable and no request header is
  forwarded.
- **The session gate** — the optimistic better-auth cookie check that used to be Next middleware.
  It only runs on document requests; `src/components/session-gate.tsx` mirrors the same rules for
  in-app navigations, which in a SPA is most of them. Neither validates the session: the API does
  that on every request, and `apiFailure` in `lib/api.ts` signs out on a 401.

## What replaced what

| Next.js                        | Here                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| `app/**/page.tsx`              | `src/routes.ts` + `src/routes/**`                                  |
| `layout.tsx`                   | `src/root.tsx` and the three layout routes                         |
| `next/link`                    | `@/components/common/Link` (React Router `Link` behind `href`)     |
| `next/navigation`              | `@/lib/navigation` (`useRouter`, `usePathname`, `useSearchParams`) |
| `next/image`                   | `@/components/common/Image` (a plain lazy `<img>`)                 |
| `next/dynamic`                 | `@/lib/dynamic` (`React.lazy` + `Suspense`)                        |
| `next-intl`                    | `@/i18n/runtime` (hooks) + `@/i18n/provider`, both on `use-intl`   |
| `next/headers` (`cookies()`)   | `@/utils/cookies` — `document.cookie`                              |
| `router.refresh()`             | `@/lib/refresh` — drops the query cache, re-reads the language     |
| middleware (`src/proxy.ts`)    | `server/middleware.mjs` + `session-gate.tsx`                       |
| `app/media/[...path]/route.ts` | the `/media` proxy in `server/middleware.mjs`                      |
| `runtime-env-script.tsx`       | `/__env.js`                                                        |
| `output: 'standalone'`         | `build/client` + `server/index.mjs` in the Docker image            |

The call sites kept their shapes on purpose: `useTranslations('issue')`, `router.push(path)` and
`<Link href={…}>` read exactly as they did, so the migration is one import specifier per file
rather than a rewrite of 80k lines.

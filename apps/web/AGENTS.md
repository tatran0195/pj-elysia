# web (React Router) — rules

React Router 8 in framework mode, client-rendered (SPA: `ssr: false`), built by Vite.
Tailwind v4 + shadcn/ui. See root `AGENTS.md`, and `docs/dev/web-runtime.md` for the routing,
the server (`server/`) and what replaced each Next.js feature.

## Imports

- A feature is a self-contained module: imports **within the same feature** use relative paths
  (`./`, `../`); imports of the **shared layer or another feature** use the `@/` alias.
- A feature imports the shared layer (`@/utils`, `@/lib`, `@/hooks`, `@/context`, `@/services`,
  `@/components/*`), never another feature —
  one accepted one-way exception: `work-items` may compose `issue` presentational components. Keep it
  one-directional, no cycles; if a second such need appears, move the shared piece to
  `components/common`.
- The shared layer never imports a feature. Route modules in `src/routes/` stay thin: mount the
  feature page and providers only.

## Feature structure & decomposition

- **One component per file — no exceptions.** A file exports exactly one component, even when the
  extra one is three lines long. On finding a file with two, split it: each component moves to its
  own file named after it, and the imports are updated.
- Keep components small and single-purpose. Split when one grows past ~120 lines or mixes concerns
  (layout + fetch + mutation + dialog). The entry component becomes a thin composition; each part
  is its own file. Push state to where it is used; the parent holds only what it coordinates.
- A feature's own parts go in purpose folders: `components/`, `hooks/`, `context/`, `services/`,
  `utils/`. Split by purpose even when a folder holds one file. A React context and its `use*`
  reader go in `context/`, not `hooks/`. The feature root holds only the entry
  component (named after the feature) — no `pages/` folder (routing is `src/routes.ts`, which
  points at the thin modules in `src/routes/`).
- **A feature with more than two pages groups its components by page.** `components/` gets one
  subfolder per page, named after that page (`components/profile/`, `components/security/`), and
  each page's parts go in its own folder. A component used by two or more of the feature's pages
  stays directly in `components/`. A feature with one or two pages keeps `components/` flat.
- Types live next to the code that produces them (API-response type in its service, prop type in
  its component), not in a `types/` folder. Add a `types/` file only for a standalone shape shared
  by several modules with no single owner.
- Shared vs local decides feature-folder vs `src/`: a part used by more than one feature goes to
  the shared layer (`src/utils`, `src/lib`, `src/hooks`, `src/context`, `src/services`,
  `components/{common,ui}`); a part used by one feature stays in it. Promote only when a second
  feature needs it (YAGNI) — don't pre-share.
- The shared layer splits by what a module depends on: `src/lib` holds wrappers over external
  packages (`api.ts`, `auth-client.ts`, `markdown.ts`, `dnd.ts`) plus shadcn's `utils.ts` (`cn`,
  fixed by `components.json`); `src/utils` holds own helpers and constants with no external
  package behind them. `src/context` holds shared React contexts and their `use*` readers.
- `components/common` groups by purpose: `agent-chat/`, `editor/`, `fields/`, `inputs/`, `page/`,
  `overlay/`, `permissions/`, `hotkeys/`, `skeleton/`. A component that fits none of them stays at the
  `common/` root.
  Imports of a sibling in the same folder are relative; everything else uses `@/`.
- Component files use the feature name as a PascalCase prefix, file name = exported name. Service
  files carry a `.service.ts` suffix (`passkeys.service.ts`). Other non-component files use plain
  descriptive names (the folder gives the context).

## Translations

`use-intl` behind `@/i18n/runtime` (hooks) and `@/i18n/provider` (the provider that resolves the
language and loads the catalogues). The language comes from the `NEXT_LOCALE` cookie, read in the
browser — no locale route segment, so every URL is the same in every language.
`messages/<locale>/<namespace>.json`, one file per namespace, namespaces are domains
(`issue`, `settings`) not pages.

- English is the source: `src/i18n/messages.ts` imports it statically, merges the chosen
  language over it, and types every `t('…')`. A new key goes there first or typecheck fails;
  an untranslated one renders its English text.
- A new namespace needs its file in every language plus an entry in `defaultMessages`.
- A new language: `messages/<code>/`, `src/i18n/locales.ts`, `src/hooks/useDateFnsLocale.ts`,
  and `LOCALES`/`Locale` in `apps/api/src/modules/user-preferences/`. No migration — the `locale`
  column has no CHECK. One written right to left also goes in `RTL_LOCALES`.
- Don't subset messages per route with `pick()`: a missing namespace then fails at runtime
  instead of at typecheck.
- The layout mirrors for a right-to-left language, so position new components with the logical
  utilities — `ms`/`me`, `ps`/`pe`, `start`/`end`, `border-s`/`border-e`, `text-start`/`text-end`
  — not `ml-`, `left-` or `text-left`, which compile to physical CSS and ignore `dir`. A
  `left`/`translate-x` centring pair and an edge the caller names (`Sheet side="right"`) stay
  physical; content that is not prose (timelines, charts, code) sits in a `dir="ltr"` container,
  and user-written text gets `dir="auto"`. `docs/dev/i18n.md` has the whole picture.
- `bun run lint` checks the message files themselves (`eslint-plugin-i18n-json`, wired in
  `eslint.config.mjs`): every language carries every namespace of `messages/en` with the same
  key set, and each message parses as ICU. A key added to English alone fails CI. Angle
  brackets in a message are rich-text tags to `use-intl` — write `owner/repo`, not
  `<owner>/<repo>`, or the message does not parse.

`docs/dev/i18n.md` has the whole picture, including how a switch reaches the rest of the app.

## Rules

- Every screen is client-rendered and reads through TanStack Query against the API — there is no
  server render and no loader/action data. A route module is a component (plus `meta` where a page
  needs it); fetch in the feature, not in the route.
- Navigate through `@/lib/navigation` (`useRouter`, `usePathname`, `useSearchParams`, `useParams`)
  and link with `@/components/common/Link`, which take React Router's primitives and keep one
  shape across the app. `router.refresh()` is the "re-read what the server owned" signal: it drops
  the query cache and re-reads the language (see `@/lib/refresh`).
- A screen that has to stay live calls `useLiveRefresh({ scope, targets })` with a scope from
  `@/utils/revScopes` — never its own polling. `SyncProvider` polls every registered scope in one
  request and invalidates the targets of the ones that moved.
- Call the backend over HTTP at the API origin. `lib/api.ts` takes it from `utils/runtimeEnv`,
  which reads `window.__ITSAPLAN_ENV__`; the web server publishes it per request at `/__env.js`
  from `API_URL` in its own process (`server/middleware.mjs`, loaded by both the Vite dev server
  and `server/index.mjs`). A per-instance value goes through there — never `import.meta.env.*` in
  a component, which the build inlines and which pins the image to one instance.
- Avatars and attachments render from `/media/...` on the web origin (proxied to the api by
  `server/middleware.mjs`), not from an absolute api url: the api origin is per-instance, and the
  browser then treats the bytes as same-origin. `@/components/common/Image` is the `<img>` wrapper
  every call site uses.
- Add shadcn components with `bunx shadcn@latest add <name>` (config in `components.json`).
- **Don't edit `src/components/ui/`** — those files are generated and re-adding a component
  overwrites them. Style them from the outside instead: every primitive carries a `data-slot`
  attribute, so a rule in `globals.css` targeting `[data-slot='…']` survives the update (the
  overlay shadows and the right-to-left corrections both work this way). Such a rule has to sit
  outside `@layer`: Tailwind orders its layers `theme, base, components, utilities`, so anything
  in `@layer components` loses to the utility classes on the element. When the change is a prop
  the component already exposes (`Sidebar side`), pass it from the caller rather than writing CSS.
  One prop reaches neither the caller nor CSS and has to be re-applied after a re-add:
  `chart.tsx` passes `debounce` to recharts' `ResponsiveContainer`, without which a chart in a
  container that resizes itself loops until React reports "Maximum update depth exceeded".
- Tailwind v4 through `@tailwindcss/vite`: no `tailwind.config`; tokens live in
  `src/globals.css` (`@theme`, CSS vars), which `src/root.tsx` imports.
- Nothing per-instance may reach the bundle: the image is published once and serves every
  instance. New config of that kind belongs in `utils/runtimeEnv`.
- The build is a static client bundle (`build/client`) plus one `index.html`; `server/index.mjs`
  serves it, applies the session gate and proxies `/media`. Keep the two in step — the Docker
  image copies exactly those two folders.
- The root shell (`src/root.tsx` and everything it imports at module scope) is rendered once in
  Node at build time to produce `index.html`. Keep module-level work in that path free of
  `window`, and guard a render-path `localStorage`/`window` read with
  `typeof window === 'undefined'`.

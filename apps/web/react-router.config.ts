import type { Config } from '@react-router/dev/config';

// The planner is a single-page app: every screen is client-rendered behind a
// session, so there is nothing for a server render to add. `ssr: false` builds a
// static client bundle plus one `index.html`, which `server/index.mjs` serves for
// every route (after the session gate and the /media proxy have had their say).
//
// `appDirectory: 'src'` keeps the existing `@/*` import paths working: root.tsx,
// routes.ts and the route modules live next to the features they render.
export default {
  appDirectory: 'src',
  ssr: false,
} satisfies Config;

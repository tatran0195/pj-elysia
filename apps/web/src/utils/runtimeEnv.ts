// The per-instance origins the browser needs. A value inlined into the bundle at
// build time would pin one build to one instance; these are published by the web
// server on every document load through `/__env.js` (see server/middleware.mjs) and
// read from `window` here, so the same build serves any instance.

export interface RuntimeEnv {
  apiUrl: string;
  privacyUrl: string;
  termsUrl: string;
}

declare global {
  interface Window {
    __ITSAPLAN_ENV__?: RuntimeEnv;
  }
}

const EMPTY: RuntimeEnv = { apiUrl: '', privacyUrl: '', termsUrl: '' };

export function runtimeEnv(): RuntimeEnv {
  if (typeof window === 'undefined') return EMPTY;
  return window.__ITSAPLAN_ENV__ ?? EMPTY;
}

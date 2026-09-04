// Cookies the browser owns and the app reads while rendering: the sidebar's
// open/collapsed state and the interface language. They used to be read on the
// server through `next/headers`; in a client-rendered app they come off
// `document.cookie` instead, which is the same value the same code writes.
export function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

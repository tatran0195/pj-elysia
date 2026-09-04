import { useMemo } from 'react';
import {
  useLocation,
  useNavigate,
  useParams as useRouterParams,
  useSearchParams as useRouterSearchParams,
} from 'react-router';
import { triggerRefresh } from '@/lib/refresh';

// The navigation surface the app is written against, on top of React Router. It
// keeps the shape the call sites already use (`router.push`, `usePathname()`,
// read-only search params), so routing changed underneath the app without 60 files
// changing with it.

export interface AppRouter {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  forward: () => void;
  /**
   * Re-reads everything the app treats as server state. There is no server render
   * to redo in a SPA, so this drops the query cache and the cached session instead
   * — which is what the call sites (sign-in, sign-out, accepting an invite, leaving
   * a project) actually want.
   */
  refresh: () => void;
  /** Kept for call-site compatibility; React Router preloads route modules itself. */
  prefetch: (href: string) => void;
}

export function useRouter(): AppRouter {
  const navigate = useNavigate();

  return useMemo(
    () => ({
      push: (href: string) => void navigate(href),
      replace: (href: string) => void navigate(href, { replace: true }),
      back: () => void navigate(-1),
      forward: () => void navigate(1),
      refresh: () => triggerRefresh(),
      prefetch: () => {},
    }),
    [navigate],
  );
}

/** The current path, without the query string or the hash. */
export function usePathname(): string {
  return useLocation().pathname;
}

/**
 * Read-only search params. React Router returns a `[params, setParams]` pair; the
 * app only ever reads, and writes its query strings by navigating to a built URL.
 */
export function useSearchParams(): URLSearchParams {
  return useRouterSearchParams()[0];
}

/** The dynamic segments of the matched route. */
export function useParams<T extends Record<string, string | undefined> = Record<string, string>>() {
  return useRouterParams() as T;
}

import { useEffect, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useSession } from '@/lib/auth-client';

// Routes reachable without a session, and that bounce a signed-in user back to
// the app. Everything else requires one.
const PUBLIC_PATHS = ['/login', '/register'];

// Routes reachable with or without a session, and never bounced: the invite accept
// page (the invitee may still have to register), the password screens (a reset link
// opened in a browser that still holds a session must show the form) and the public
// read-only share pages.
const OPEN_PATHS = ['/invite', '/forgot-password', '/reset-password', '/share'];

function target(pathname: string, hasSession: boolean): string | null {
  const matches = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  if (OPEN_PATHS.some(matches)) return null;
  if (PUBLIC_PATHS.some(matches)) return hasSession ? '/' : null;
  return hasSession ? null : '/login';
}

// The client half of the session gate. The web server applies the same rules to
// document requests (server/middleware.mjs); this one covers navigations that never
// reach it, which in a SPA is most of them.
//
// It stays optimistic in the same way: it only asks whether a session exists, and
// the API validates it on every request. A session the API no longer accepts is
// handled by `apiFailure` in lib/api.ts, which signs out and lands on
// `/login?expired=1`.
export default function SessionGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const destination = isPending ? null : target(pathname, session != null);

  useEffect(() => {
    if (destination) void navigate(destination, { replace: true });
  }, [destination, navigate]);

  // Nothing of the gated screen is rendered while it is being sent away, so a page
  // behind a session never mounts its queries for a visitor without one.
  if (destination) return null;

  return <>{children}</>;
}

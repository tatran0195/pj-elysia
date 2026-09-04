import { ThemeProvider } from 'next-themes';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import { Providers } from '@/components/providers';
import DocumentTitle from '@/components/document-title';
import SessionGate from '@/components/session-gate';
import { I18nProvider } from '@/i18n/provider';
import type { Route } from './+types/root';
import './globals.css';

// The document shell. It is rendered once at build time into `index.html` (the app
// is a SPA — see react-router.config.ts) and hydrated in the browser.
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        {/* The per-instance origins, served by the web server at request time (see
            server/middleware.mjs). A blocking script in <head>, so a module that
            reads runtimeEnv() while it is being imported already sees them, and so
            one build can serve any instance. */}
        <script src="/__env.js" />
      </head>
      <body className="antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      // A distinct key: next-themes defaults to "theme", which collides with any
      // other app sharing the same localhost origin. A shared key makes two such
      // apps fight over the value through cross-tab storage events.
      storageKey="itsaplan-theme"
    >
      <I18nProvider>
        <DocumentTitle />
        <Providers>
          <SessionGate>
            <Outlet />
          </SessionGate>
        </Providers>
      </I18nProvider>
    </ThemeProvider>
  );
}

// Shown while the bundle boots and while a route module is still loading. Kept to
// the page background alone: anything with text would need translations that have
// not been loaded yet at that point.
export function HydrateFallback() {
  return <div className="h-svh bg-background" />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const is404 = isRouteErrorResponse(error) && error.status === 404;
  const title = is404 ? 'Page not found' : 'Something went wrong';
  const detail = isRouteErrorResponse(error)
    ? error.statusText || String(error.status)
    : error instanceof Error
      ? error.message
      : 'Unexpected error';

  return (
    <main className="flex h-svh flex-col items-center justify-center gap-2 bg-background p-6 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-prose text-sm text-muted-foreground">{detail}</p>
      <a className="text-sm underline underline-offset-4" href="/">
        Back to the app
      </a>
    </main>
  );
}

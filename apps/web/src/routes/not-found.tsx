import NotFound from '@/components/common/NotFound';

// Every URL the table above does not claim. A route rather than the root
// ErrorBoundary's 404 branch on purpose: the shell is prerendered with the
// HydrateFallback (the app is a SPA), so rendering the boundary during hydration
// would not match that HTML. A lazily loaded route module renders after hydration
// instead, and it gets the translated page the rest of the app uses.
export default function Page() {
  return (
    <main className="flex h-svh flex-col items-center justify-center bg-background">
      <NotFound />
    </main>
  );
}

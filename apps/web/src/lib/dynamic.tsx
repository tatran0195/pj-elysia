import { Suspense, lazy, type ComponentType, type ReactNode } from 'react';

type Loader<P> = () => Promise<{ default: ComponentType<P> } | ComponentType<P>>;

interface Options {
  /** Rendered while the chunk is in flight. */
  loading?: () => ReactNode;
  /**
   * Accepted and ignored: the app is client-rendered, so every dynamic import is
   * already browser-only.
   */
  ssr?: boolean;
}

// Code-splits a component behind `React.lazy`, keeping the `dynamic(() => import(…))`
// shape the call sites use. A heavy, rarely-opened panel (charts, the API reference)
// then stays out of the main bundle.
export default function dynamic<P extends object>(loader: Loader<P>, options: Options = {}) {
  const Lazy = lazy(async () => {
    const loaded = await loader();
    return 'default' in loaded ? (loaded as { default: ComponentType<P> }) : { default: loaded };
  });

  return function Dynamic(props: P) {
    return (
      <Suspense fallback={options.loading?.() ?? null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

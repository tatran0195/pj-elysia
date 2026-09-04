// A single "reload everything the server owned" signal. Next re-rendered the route
// on `router.refresh()`; here the same call drops the cached data instead: the
// providers subscribe (query cache, session, interface language) and the call sites
// stay unchanged.

type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function triggerRefresh(): void {
  for (const listener of listeners) listener();
}

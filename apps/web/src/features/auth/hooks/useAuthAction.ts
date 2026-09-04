import { useState } from 'react';
import { useRouter } from '@/lib/navigation';
import { useTranslations } from '@/i18n/runtime';

// Runs an auth action while tracking pending + error, and redirects into the
// planner on success. `setError` is exposed so a form can report client-side
// validation before calling `run`.
//
// Actions that only send an email (reset link, sign-in link, confirmation) end on
// the same screen with a "check your inbox" message instead, so they pass
// `redirect: false` and keep `pending` cleared.
//
// A failure carries the message the auth server sent; `fallback` covers the ones
// that arrive without one and where the generic wording is too vague.
//
// An action that succeeded but has more to do on the same screen (a password
// that was right, with a second factor still to enter) throws `StayOnScreen`:
// no redirect, no error.
export class StayOnScreen extends Error {
  constructor() {
    super('stay');
  }
}

export function useAuthAction() {
  const router = useRouter();
  const t = useTranslations('auth.errors');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(
    action: () => Promise<void>,
    options?: { redirect?: boolean; fallback?: string },
  ) {
    setError(null);
    setPending(true);
    try {
      await action();
      if (options?.redirect === false) {
        setPending(false);
        return;
      }
      router.push('/');
      router.refresh();
    } catch (err) {
      if (err instanceof StayOnScreen) {
        setPending(false);
        return;
      }
      const message = err instanceof Error ? err.message : '';
      setError(message || options?.fallback || t('generic'));
      setPending(false);
    }
  }

  return { error, pending, setError, run };
}

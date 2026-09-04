import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { localeFromAcceptLanguage } from '@/i18n/accept-language';
import {
  LOCALE_COOKIE,
  DEFAULT_LOCALE,
  isLocale,
  localeDirection,
  type Locale,
} from '@/i18n/locales';
import { loadMessages, type Messages } from '@/i18n/messages';
import { subscribeRefresh } from '@/lib/refresh';
import { canonicalTimezone, getDisplayTimezone, subscribeDisplayTimezone } from '@/utils/dates';

// The translation provider: it decides which language the interface renders in and
// loads that catalogue. The hooks the app calls come from `@/i18n/runtime`.
// Which language to render, decided in the browser: the cookie the language picker
// and PreferencesSync write is the durable copy across a signed-out screen, and the
// browser's own preference decides the first visit without one. The URL never
// carries a locale, so every path stays the same in every language.
export function resolveLocale(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  const cookie = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${LOCALE_COOKIE}=`))
    ?.split('=')[1];
  if (isLocale(cookie)) return cookie;
  const preferred = typeof navigator !== 'undefined' ? navigator.languages.join(',') : null;
  return localeFromAcceptLanguage(preferred);
}

// English ships in the bundle, so the first paint never waits on a fetch. Any other
// language loads its catalogue before rendering the tree, which keeps a screen from
// flashing English and then swapping.
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(resolveLocale);
  const [messages, setMessages] = useState<Messages | null>(null);

  // `router.refresh()` (used by PreferencesSync after it writes the cookie) is what
  // re-reads the choice, standing in for the server re-render Next used to do.
  useEffect(() => subscribeRefresh(() => setLocale(resolveLocale())), []);

  useEffect(() => {
    let active = true;
    void loadMessages(locale).then((loaded) => {
      if (active) setMessages(loaded);
    });
    return () => {
      active = false;
    };
  }, [locale]);

  // The zone the formatters render in: the account preference once PreferencesSync
  // has it, the browser's zone until then. Passing it explicitly is also what keeps
  // use-intl from falling back to the environment zone and logging about it.
  const preferredZone = useSyncExternalStore(
    subscribeDisplayTimezone,
    getDisplayTimezone,
    () => '',
  );
  const browserZone = useMemo(
    () => canonicalTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    [],
  );

  // The reference point for relative times. Fixed per language load and advanced by
  // RelativeTimeProvider from there, so a list of timestamps agrees with itself.
  const now = useMemo(() => new Date(), []);

  // The document's own language and writing direction. Radix reads the direction
  // from a context instead (see components/providers), but the page still needs it
  // for text selection, scrollbars and anything rendered outside the app root.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDirection(locale);
  }, [locale]);

  if (!messages) return null;

  return (
    <IntlProvider
      locale={locale}
      messages={messages}
      now={now}
      timeZone={preferredZone || browserZone}
    >
      {children}
    </IntlProvider>
  );
}

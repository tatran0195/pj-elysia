// The app's translation hooks. They are the framework-agnostic ones from `use-intl`
// (the core `next-intl` itself is built on), so every `useTranslations`,
// `useFormatter`, `useLocale` and `useNow` call site reads exactly as it did before
// translation moved off Next — only the import specifier changed.
//
// Nothing but the hooks lives here: the provider that resolves the language and
// loads the catalogues is `@/i18n/provider`, so importing a hook never pulls the
// message files (or the bundler-specific glob that finds them) into a module.
export {
  useTranslations,
  useLocale,
  useFormatter,
  useNow,
  useTimeZone,
  useMessages,
} from 'use-intl';
export type { Messages } from '@/i18n/messages';

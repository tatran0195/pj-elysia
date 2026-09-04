import type { Messages } from './src/i18n/messages';

// Types every translation key against the English catalogue: a `t('…')` for a key
// that does not exist there fails typecheck instead of rendering the key path.
// `use-intl` is the translation runtime behind `@/i18n/runtime`.
declare module 'use-intl' {
  interface AppConfig {
    Messages: Messages;
  }
}

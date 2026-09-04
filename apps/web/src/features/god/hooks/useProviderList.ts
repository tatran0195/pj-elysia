import { useTranslations } from '@/i18n/runtime';

// Sign-in method labels. the api reports the password provider as "credential";
// anything else is a social or passkey provider and keeps its own id, which the
// messages may not carry — such a provider is listed under its id.
export function useProviderList() {
  const t = useTranslations('god.providers');

  return (ids: string[]) =>
    ids
      .map((id) => {
        const key = id as Parameters<typeof t.has>[0];
        return t.has(key) ? t(key) : id;
      })
      .join(', ');
}

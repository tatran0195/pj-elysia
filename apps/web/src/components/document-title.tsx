import { useEffect } from 'react';
import { useTranslations } from '@/i18n/runtime';

// The document title and description, in the interface language. They used to come
// from the route's `generateMetadata`; in a client-rendered app the language is only
// known in the browser, so they are written once the catalogue is in.
export default function DocumentTitle() {
  const t = useTranslations('meta');
  const title = t('title');
  const description = t('description');

  useEffect(() => {
    document.title = title;
    let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!tag) {
      tag = document.createElement('meta');
      tag.name = 'description';
      document.head.appendChild(tag);
    }
    tag.content = description;
  }, [title, description]);

  return null;
}

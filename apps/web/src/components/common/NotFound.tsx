import { FileQuestion } from 'lucide-react';
import { useTranslations } from '@/i18n/runtime';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

// What a route renders when the URL points at something that cannot exist — a
// cycle id that is not a number, for instance. It stands in for Next's `notFound()`,
// which had a server render to abort; here the route simply renders this instead.
export default function NotFound() {
  const t = useTranslations('common');
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion />
          </EmptyMedia>
          <EmptyTitle>{t('notFoundTitle')}</EmptyTitle>
          <EmptyDescription>{t('notFoundHint')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

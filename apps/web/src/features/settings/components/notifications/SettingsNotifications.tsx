import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import EmailSettings from './EmailSettings';
import TelegramSettings from './TelegramSettings';
import MsTeamsSettings from './MsTeamsSettings';
import type { EmailForm } from '../../hooks/useEmailForm';
import type { TelegramForm } from '../../hooks/useTelegramForm';
import type { MsTeamsForm } from '../../hooks/useMsTeamsForm';
import { useTranslations } from '@/i18n/runtime';

export type NotificationTab = 'email' | 'telegram' | 'msteams';

// The email (SMTP or Resend), Telegram bot, and MS Teams incoming webhook
// credentials the project delivers through, one tab per channel.
export default function SettingsNotifications({
  tab,
  onTabChange,
  emailForm,
  telegramForm,
  msteamsForm,
}: {
  tab: NotificationTab;
  onTabChange: (v: NotificationTab) => void;
  emailForm: EmailForm;
  telegramForm: TelegramForm;
  msteamsForm: MsTeamsForm;
}) {
  const t = useTranslations('settings.notifications');
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => onTabChange(v as NotificationTab)}
      className="flex flex-col gap-8"
    >
      <TabsList variant="line">
        <TabsTrigger value="email">{t('email')}</TabsTrigger>
        <TabsTrigger value="telegram">{t('telegram')}</TabsTrigger>
        <TabsTrigger value="msteams">{t('msteams')}</TabsTrigger>
      </TabsList>

      <TabsContent value="email" className="mt-0">
        <EmailSettings form={emailForm} />
      </TabsContent>

      <TabsContent value="telegram" className="mt-0">
        <TelegramSettings form={telegramForm} />
      </TabsContent>

      <TabsContent value="msteams" className="mt-0">
        <MsTeamsSettings form={msteamsForm} />
      </TabsContent>
    </Tabs>
  );
}

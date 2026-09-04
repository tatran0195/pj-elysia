import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@/i18n/runtime';
import type { NotificationSettings } from '@/lib/api';
import { useUpdateNotificationSettings } from '../services/settings.service';

export interface MsTeamsForm {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  webhookUrl: string;
  setWebhookUrl: (v: string) => void;
  settings: NotificationSettings;
  editable: boolean;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<void>;
}

// Form state for the Microsoft Teams notification provider tab. Shared between the
// header Save button and the body fields. The webhook URL is sent only when changed.
export function useMsTeamsForm(
  projectKey: string,
  settings: NotificationSettings,
  editable: boolean,
): MsTeamsForm {
  const t = useTranslations('settings.notifications');
  const update = useUpdateNotificationSettings(projectKey);
  const [enabled, setEnabled] = useState(settings.msteams.enabled);
  const [webhookUrl, setWebhookUrl] = useState('');

  const dirty = enabled !== settings.msteams.enabled || webhookUrl.length > 0;

  async function save() {
    await update.mutateAsync({
      msteams: {
        enabled,
        ...(webhookUrl.length > 0 ? { webhookUrl } : {}),
      },
    });
    setWebhookUrl('');
    toast.success(t('msteamsSaved'));
  }

  return {
    enabled,
    setEnabled,
    webhookUrl,
    setWebhookUrl,
    settings,
    editable,
    dirty,
    saving: update.isPending,
    save,
  };
}

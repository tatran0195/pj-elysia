import { Label } from '@/components/ui/label';
import SettingsSection from '@/components/common/page/SettingsSection';
import EnabledSwitch from '@/components/common/inputs/EnabledSwitch';
import SecretInput from '@/components/common/inputs/SecretInput';
import type { MsTeamsForm } from '../../hooks/useMsTeamsForm';
import { useTranslations } from '@/i18n/runtime';

// Microsoft Teams notification provider settings: incoming webhook URL the
// project delivers through. The webhook URL is sent only when changed.
export default function MsTeamsSettings({ form }: { form: MsTeamsForm }) {
  const t = useTranslations('settings.notifications');
  const { settings, editable } = form;

  return (
    <SettingsSection
      title={t('msteams')}
      description={t('msteamsHint')}
      action={
        editable && (
          <EnabledSwitch checked={form.enabled} onChange={form.setEnabled} disabled={!editable} />
        )
      }
    >
      <div className="space-y-1.5 sm:max-w-md">
        <Label htmlFor="msteams-url">{t('msteamsWebhookUrl')}</Label>
        <SecretInput
          id="msteams-url"
          value={form.webhookUrl}
          onChange={form.setWebhookUrl}
          hasStored={settings.msteams.hasWebhookUrl}
          editable={editable}
          placeholder="https://...webhook.office.com/..."
        />
      </div>
    </SettingsSection>
  );
}

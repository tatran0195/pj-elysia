import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from '@/i18n/runtime';
import { registerStepUpPrompt } from '@/lib/auth-client';
import Modal from '@/components/common/overlay/Modal';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

// The password dialog behind sensitive actions. Mounted once, at the root; the
// auth client asks it for a password when an endpoint answers
// `step_up_required`, then posts it to /auth/step-up and retries the call.
//
// The dialog resolves the pending promise with the typed password (the client
// verifies it), or null when dismissed. A wrong password comes back as the
// retry's own error, so the caller's normal error path shows it.
export default function StepUpPrompt() {
  const t = useTranslations('account.security');
  const tc = useTranslations('common');
  const [resolver, setResolver] = useState<((password: string | null) => void) | null>(null);
  const [password, setPassword] = useState('');

  useEffect(() => {
    registerStepUpPrompt(
      () =>
        new Promise<string | null>((resolve) => {
          setPassword('');
          setResolver(() => resolve);
        }),
    );
    return () => registerStepUpPrompt(null);
  }, []);

  if (!resolver) return null;

  function finish(value: string | null) {
    resolver?.(value);
    setResolver(null);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!password) return;
    finish(password);
  }

  return (
    <Modal title={t('stepUpTitle')} description={t('stepUpDescription')} onClose={() => finish(null)}>
      <form onSubmit={onSubmit} className="space-y-4" data-testid="step-up-form">
        <Field>
          <FieldLabel htmlFor="step-up-password">{t('currentPassword')}</FieldLabel>
          <Input
            id="step-up-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => finish(null)}>
            {tc('cancel')}
          </Button>
          <Button type="submit" disabled={!password}>
            {t('stepUpConfirm')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

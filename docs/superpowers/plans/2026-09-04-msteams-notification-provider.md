# Microsoft Teams Notification Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support Microsoft Teams as an outbound notification provider using project-level Incoming Webhooks and Adaptive Cards.

**Architecture:** Project administrators configure an MS Teams Incoming Webhook URL and choose event types in project settings. When issue events occur, `enqueueOutbound` in the API enqueues deduplicated delivery rows in `notification_delivery`. The worker claims these rows, and the API sends formatted Adaptive Card 1.4 messages to the Teams webhook.

**Tech Stack:** Bun, Elysia, PostgreSQL, Drizzle ORM, React Router 8 (SPA), Vite, Tailwind CSS, shadcn/ui.

## Global Constraints

- Runtime is Bun. Run commands from repo root.
- Follow KISS and YAGNI. Minimum comments.
- Do not commit changes automatically — present Conventional Commit subjects for the user to run.
- All strings, comments, and code in English.
- No direct package imports in web app; communicate via API HTTP.

---

### Task 1: Database Schema & Migration (`packages/db`)

**Files:**
- Modify: `packages/db/src/schema/app.ts:846`
- Generate: `packages/db/drizzle/XXXX_*.sql`

**Interfaces:**
- Consumes: Existing `notification_delivery` table definition
- Produces: Updated `notification_delivery_channel_check` allowing `'email'`, `'telegram'`, `'msteams'`

- [ ] **Step 1: Update channel check constraint in `packages/db/src/schema/app.ts`**

Change line 846 from:
```ts
check('notification_delivery_channel_check', sql`${t.channel} IN ('email', 'telegram')`),
```
to:
```ts
check('notification_delivery_channel_check', sql`${t.channel} IN ('email', 'telegram', 'msteams')`),
```

- [ ] **Step 2: Generate Drizzle migration**

Run:
```bash
bun run db:generate
```
Verify a new SQL migration file is generated in `packages/db/drizzle/` altering the check constraint.

- [ ] **Step 3: Apply migrations locally**

Run:
```bash
bun run db:migrate
```
Expected: Migration applied successfully (or skip if dev DB not running, verified via SQL generation).

---

### Task 2: Backend Notification Settings & Types (`apps/api`)

**Files:**
- Modify: `apps/api/src/modules/notification-settings/service.ts`
- Modify: `apps/api/src/modules/notification-settings/model.ts`
- Modify: `apps/api/src/modules/notifications/model.ts:63-79`

**Interfaces:**
- Consumes: `projectNotificationSetting`, `EventToggles` from `#modules/notification-preferences/service`
- Produces: `MsTeamsConfig`, `MsTeamsSettingsDto`, updated `NotificationSettingsResponse` and `NotificationSettingsBody`

- [ ] **Step 1: Update `NotificationConfig` and DTOs in `apps/api/src/modules/notification-settings/service.ts`**

Add `MsTeamsConfig` and `MsTeamsSettingsDto`:
```ts
import type { EventToggles } from '#modules/notification-preferences/service';

export interface MsTeamsConfig {
  enabled: boolean;
  webhookUrl: string; // secret
  events: EventToggles;
}

export interface MsTeamsSettingsDto {
  enabled: boolean;
  hasWebhookUrl: boolean;
  events: EventToggles;
}
```

Add `msteams` to `NotificationConfig`, `NotificationSettingsDto`, and `NotificationSettingsPatch`:
```ts
export interface NotificationConfig {
  system: { enabled: boolean };
  smtp: SmtpConfig;
  resend: ResendConfig;
  telegram: TelegramConfig;
  msteams: MsTeamsConfig;
}

export interface NotificationSettingsDto {
  system: { enabled: boolean };
  smtp: ...;
  resend: ...;
  telegram: ...;
  msteams: MsTeamsSettingsDto;
}

export interface NotificationSettingsPatch {
  system?: ...;
  smtp?: ...;
  resend?: ...;
  telegram?: ...;
  msteams?: {
    enabled: boolean;
    webhookUrl?: string;
    events?: Partial<EventToggles>;
  };
}
```

Update `defaultConfig()`, `toDto()`, and `applyPatch()` to initialize and merge `msteams`:
Default config has `msteams: { enabled: false, webhookUrl: '', events: { assigned: true, mentioned: true, commented: true, state_changed: true } }`.

- [ ] **Step 2: Update validation schema in `apps/api/src/modules/notification-settings/model.ts`**

Add `msteams` schema to `NotificationSettingsResponse`:
```ts
  msteams: t.Object({
    enabled: t.Boolean(),
    hasWebhookUrl: t.Boolean(),
    events: t.Object({
      assigned: t.Boolean(),
      mentioned: t.Boolean(),
      commented: t.Boolean(),
      state_changed: t.Boolean(),
    }),
  }),
```

Add `msteams` optional schema to `NotificationSettingsBody`:
```ts
  msteams: t.Optional(
    t.Object({
      enabled: t.Boolean(),
      webhookUrl: t.Optional(t.String()),
      events: t.Optional(
        t.Object({
          assigned: t.Boolean(),
          mentioned: t.Boolean(),
          commented: t.Boolean(),
          state_changed: t.Boolean(),
        }),
      ),
    }),
  ),
```

- [ ] **Step 3: Update `sendDeliveryBody` in `apps/api/src/modules/notifications/model.ts`**

Update `channel`:
```ts
channel: t.UnionEnum(['email', 'telegram', 'msteams']),
```

- [ ] **Step 4: Verify typecheck**

Run:
```bash
bun --filter='@repo/db' run typecheck
bun --filter=api run typecheck
```
Expected: Clean pass with no type errors.

---

### Task 3: Outbound Enqueue & Delivery Sender (`apps/api`)

**Files:**
- Modify: `apps/api/src/modules/notifications/outbound.ts`
- Modify: `apps/api/src/modules/notifications/send.ts`
- Create / Modify: `apps/api/src/modules/notifications/__tests__/integration/msteams-delivery.test.ts`

**Interfaces:**
- Consumes: `readRedactedSettings`, `getDeliveryConfig`
- Produces: `sendMsTeams`, updated `enqueueOutbound` handling `'msteams'` channel

- [ ] **Step 1: Write integration tests for MS Teams settings & outbound sending**

Test saving MS Teams settings (masked webhook URL) and delivery format in `apps/api/src/modules/notifications/__tests__/integration/msteams-delivery.test.ts`:
- Saving MS Teams webhook settings updates `redacted` with `hasWebhookUrl: true`.
- Calling `sendMsTeams` with mocked HTTP response posts Adaptive Card payload with issue title, action text, and URL.

- [ ] **Step 2: Update `apps/api/src/modules/notifications/outbound.ts`**

In `enqueueOutbound`:
- Update `OutboxRow.channel` type: `'email' | 'telegram' | 'msteams'`.
- Check if `settings.msteams.enabled && settings.msteams.hasWebhookUrl`.
- If enabled, collect distinct event types present in `notifications`.
- For each event type where `settings.msteams.events[type]` is true:
  - Enqueue one row:
    ```ts
    out.push({
      projectId,
      channel: 'msteams',
      recipient: null,
      payload: {
        subject: `${ref}: ${issueRow.title}`,
        text: stateChange ? `Status changed from ${stateChange.from} to ${stateChange.to} by ${actor}` : `${action} by ${actor}`,
        url,
      },
    });
    ```

- [ ] **Step 3: Implement `sendMsTeams` in `apps/api/src/modules/notifications/send.ts`**

Add `sendMsTeams(input: SendInput): Promise<SendResult>`:
```ts
async function sendMsTeams(input: SendInput): Promise<SendResult> {
  const { msteams } = input.config;
  if (!msteams?.enabled || !msteams.webhookUrl) {
    return { ok: false, retryable: false, error: 'msteams not configured' };
  }

  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              size: 'Medium',
              weight: 'Bolder',
              text: input.payload.subject ?? input.payload.text,
            },
            {
              type: 'TextBlock',
              text: input.payload.text,
              wrap: true,
            },
          ],
          actions: input.payload.url
            ? [
                {
                  type: 'Action.OpenUrl',
                  title: 'View Issue',
                  url: input.payload.url,
                },
              ]
            : [],
        },
      },
    ],
  };

  try {
    const res = await fetch(msteams.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(card),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      retryable: res.status === 429 || res.status >= 500,
      error: `MS Teams HTTP ${res.status}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      error: err instanceof Error ? err.message : 'msteams request failed',
    };
  }
}
```
Update `sendDelivery()` to handle `input.channel === 'msteams'`.

- [ ] **Step 4: Run tests**

Run:
```bash
bun test apps/api/src/modules/notifications
```
Expected: All tests pass.

---

### Task 4: Frontend Web UI for MS Teams Provider (`apps/web`)

**Files:**
- Modify: `apps/web/src/lib/api.ts:1060-1100`
- Create: `apps/web/src/features/settings/hooks/useMsTeamsForm.ts`
- Create: `apps/web/src/features/settings/components/notifications/MsTeamsSettings.tsx`
- Modify: `apps/web/src/features/settings/components/notifications/SettingsNotifications.tsx`
- Modify: `apps/web/src/features/settings/SettingsNotificationsPage.tsx`
- Modify: `apps/web/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: `NotificationSettings`, `useUpdateNotificationSettings`
- Produces: `MsTeamsSettings` UI component, `useMsTeamsForm` hook

- [ ] **Step 1: Update types in `apps/web/src/lib/api.ts`**

Add `msteams` to `NotificationSettings` and `NotificationSettingsPatch`:
```ts
export interface NotificationSettings {
  ...
  msteams: {
    enabled: boolean;
    hasWebhookUrl: boolean;
    events: NotificationEventToggles;
  };
}

export interface NotificationSettingsPatch {
  ...
  msteams?: {
    enabled: boolean;
    webhookUrl?: string;
    events?: Partial<NotificationEventToggles>;
  };
}
```

- [ ] **Step 2: Create `useMsTeamsForm.ts`**

State hook managing `enabled`, `webhookUrl`, `events`, and saving via `useUpdateNotificationSettings`:
- Tracks `dirty` when `enabled`, `webhookUrl`, or `events` differ from saved settings.
- Clears `webhookUrl` on successful save.
- Displays `toast.success(t('msteamsSaved'))`.

- [ ] **Step 3: Create `MsTeamsSettings.tsx`**

Component rendering:
- `SettingsSection` with title `{t('msteams')}`, description `{t('msteamsHint')}`, and `EnabledSwitch`.
- `SecretInput` for `webhookUrl` with `hasStored={settings.msteams.hasWebhookUrl}` and placeholder `https://...webhook.office.com/...`.
- Event checkboxes for each event in `NOTIFICATION_EVENTS` (`assigned`, `mentioned`, `commented`, `state_changed`).

- [ ] **Step 4: Update `SettingsNotifications.tsx` and `SettingsNotificationsPage.tsx`**

- Extend `NotificationTab = 'email' | 'telegram' | 'msteams'`.
- Add MS Teams tab trigger and content in `SettingsNotifications.tsx`.
- Wire `useMsTeamsForm` and pass to `SettingsNotifications` in `SettingsNotificationsPage.tsx`.

- [ ] **Step 5: Add translation strings**

Add keys under `settings.notifications` in `apps/web/src/i18n/locales/en.json`:
- `msteams`: "Microsoft Teams"
- `msteamsHint`: "Deliver issue notifications to a Microsoft Teams channel via Incoming Webhook."
- `msteamsWebhookUrl`: "Webhook URL"
- `msteamsSaved`: "Microsoft Teams settings saved"
- `msteamsEvents`: "Delivered events"

---

### Task 5: Verification & Quality Checks

**Files:**
- Entire workspace

- [ ] **Step 1: Run typecheck across the workspace**

```bash
bun run typecheck
```
Expected: 0 errors.

- [ ] **Step 2: Run linter across the workspace**

```bash
bun run lint
```
Expected: 0 errors.

- [ ] **Step 3: Run all unit & integration tests**

```bash
bun run test
```
Expected: All tests pass.

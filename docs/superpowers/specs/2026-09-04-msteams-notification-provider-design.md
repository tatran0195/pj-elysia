# Microsoft Teams Notification Provider Design

## Overview
Support Microsoft Teams as a project notification provider alongside Email (SMTP/Resend) and Telegram. Project owners can configure an Incoming Webhook URL in project settings, allowing issue events (assignments, mentions, comments, status changes) to be formatted as rich Adaptive Cards and posted to the project's Microsoft Teams channel.

## Architecture & Data Flow

```
+-------------------------------------------------------------+
| Project Settings (/project/:key/settings/notifications)    |
| - MS Teams Tab: enabled, webhookUrl, event checkboxes       |
+-------------------------------------------------------------+
                              | (AES-256-GCM encrypted)
                              v
                +----------------------------+
                | projectNotificationSetting |
                +----------------------------+
                              |
+-----------------------------+-------------------------------+
| Issue Event (comment, mention, assignment, status change)   |
+-------------------------------------------------------------+
                              |
                              v
                  enqueueOutbound() in API
                              |
    (Deduplicates events in batch, verifies msteams enabled)
                              |
                              v
                 +--------------------------+
                 |   notificationDelivery   |
                 | channel: 'msteams'       |
                 +--------------------------+
                              |
                              v
                     Worker Outbox Claim
                              |
                              v
            POST /internal/notification-deliveries/send
                              |
                              v
                 sendMsTeams() in API
                              |
            (Builds Adaptive Card 1.4 JSON)
                              |
                              v
            POST to Microsoft Teams Webhook URL
```

## Database Schema Changes (`@repo/db`)

1. **`notification_delivery` Table Constraint:**
   - Update `notification_delivery_channel_check` in `packages/db/src/schema/app.ts`:
     ```ts
     check('notification_delivery_channel_check', sql`${t.channel} IN ('email', 'telegram', 'msteams')`)
     ```
   - Generate Drizzle migration (`bun run db:generate`).

## Backend API & Worker Changes (`apps/api`, `apps/worker`)

### 1. `apps/api/src/modules/notification-settings/service.ts`
- Extend `NotificationConfig` and `NotificationSettingsDto`:
  ```ts
  export interface MsTeamsConfig {
    enabled: boolean;
    webhookUrl: string; // Secret at rest
    events: EventToggles;
  }

  export interface MsTeamsSettingsDto {
    enabled: boolean;
    hasWebhookUrl: boolean;
    events: EventToggles;
  }
  ```
- Update `defaultConfig()`, `toDto()`, `applyPatch()` to merge secret webhook URL and handle partial updates.
- Redacted DTO masks `webhookUrl` to `hasWebhookUrl`.

### 2. `apps/api/src/modules/notifications/model.ts`
- Update `sendDeliveryBody`:
  ```ts
  channel: t.UnionEnum(['email', 'telegram', 'msteams'])
  ```

### 3. `apps/api/src/modules/notifications/outbound.ts`
- Extend `OutboxRow.channel` to include `'msteams'`.
- In `enqueueOutbound()`:
  - Check `settings.msteams.enabled && settings.msteams.hasWebhookUrl`.
  - For each distinct event type in the notification batch matching `settings.msteams.events[type]`:
    - Enqueue a single delivery row with `channel: 'msteams'`, `recipient: null`, and payload containing title, ref, action description, and issue URL.

### 4. `apps/api/src/modules/notifications/send.ts`
- Implement `sendMsTeams(input: SendInput)`:
  - Validates `config.msteams.enabled` and `config.msteams.webhookUrl`.
  - Generates an **Adaptive Card 1.4** JSON body:
    - Title: `📌 [IAP-42] Issue Title`
    - Subtitle / text: `${actor} changed the status...` / `${actor} commented...`
    - Action: `Action.OpenUrl` with label "View Issue" pointing to `payload.url`.
  - Sends `POST` with 15-second timeout and `content-type: application/json`.
  - Returns `SendResult`:
    - 200/202 -> `{ ok: true }`
    - 429/5xx -> `{ ok: false, retryable: true, error }`
    - 4xx -> `{ ok: false, retryable: false, error }`
- Route `channel === 'msteams'` to `sendMsTeams(input)` in `sendDelivery()`.

## Frontend Changes (`apps/web`)

1. **`apps/web/src/lib/api.ts`:**
   - Update `NotificationSettings` and `NotificationSettingsPatch` types to include `msteams`.
2. **`SettingsNotifications.tsx`:**
   - Add `'msteams'` to `NotificationTab`.
   - Add `<TabsTrigger value="msteams">{t('msteams')}</TabsTrigger>`.
   - Add `<TabsContent value="msteams"><MsTeamsSettings form={msteamsForm} /></TabsContent>`.
3. **`useMsTeamsForm.ts`:**
   - Form hook to manage `enabled`, `webhookUrl`, and `events` toggles, tracking dirty state and saving.
4. **`MsTeamsSettings.tsx`:**
   - UI component featuring:
     - Master enable switch
     - Webhook URL input with `hasStored` badge and clear/change action
     - Event toggles (Assigned, Mentioned, Commented, Status Changed)
5. **`SettingsNotificationsPage.tsx`:**
   - Hook up `msteamsForm` and pass to `SettingsNotifications`.
6. **Localization (`apps/web/src/i18n/locales/*.json`):**
   - Add translations for MS Teams settings strings.

## Testing & Verification Plan

1. **Automated Integration Tests (`apps/api`):**
   - Add tests in `apps/api/src/modules/notifications/__tests__/` verifying:
     - Saving and redacting MS Teams settings.
     - Outbound enqueueing for MS Teams delivery rows with deduplication.
     - Sending Adaptive Card payload to a mocked webhook endpoint.
2. **Typecheck & Linting:**
   - `bun run typecheck` across workspace.
   - `bun run lint` across workspace.

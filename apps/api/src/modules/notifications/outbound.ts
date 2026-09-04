import { db, notificationDelivery, issue, issueActivity, project, user } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { getProjectEmailConfig } from '@repo/auth';
import { emailSource, readRedactedSettings } from '#modules/notification-settings/service';
import { getPreferencesForUsers } from '#modules/notification-preferences/service';
import { getTelegramChatIds, hasUsableInstanceBot } from '#modules/telegram/service';
import { escapeHtml } from '#shared/lib';
import type { NotificationType, NewNotificationRow } from './service';

// Outbound notification delivery: turns the inbox notification rows produced by an
// issue event into notification_delivery outbox rows. Delivery is per member and per
// their own preferences: for each inbox row (already one per recipient), the member's
// notification-preferences decide whether it goes by email (to their account address)
// and/or Telegram (to the chat of the Telegram account they linked). The project
// supplies the provider credentials (SMTP/Resend, and optionally its own bot token —
// Telegram otherwise goes through the instance bot). The message text is composed
// here at enqueue time and stored on the row; the worker drains the outbox and the
// sender reads the credentials at send time.
//
// This is best-effort: enqueue never throws into the caller (a failure here must not
// break creating a comment or updating an issue), so callers wrap it in try/catch.

// The stored message. `subject`/`html` are channel-specific: email uses `subject`
// and builds its own HTML from `text`; Telegram sends `html` (parse_mode HTML) and
// falls back to `text`. The sender appends `url` to plain-text bodies.
export interface DeliveryPayload {
  subject?: string;
  text: string;
  html?: string;
  url?: string;
  emailSource?: 'project' | 'instance';
  idempotencyKey?: string;
  dedupeKey?: string;
  projectInviteId?: number;
}

interface OutboxRow {
  projectId: number;
  channel: 'email' | 'telegram' | 'msteams';
  recipient: string | null;
  payload: DeliveryPayload;
}

// The issue reference shown in messages, e.g. "IAP-42".
function issueRef(projectKey: string, seq: number): string {
  return `${projectKey}-${seq}`;
}

// The public URL of an issue, or undefined when the web origin is not configured
// (then messages carry no link rather than a localhost fallback).
function issueUrl(projectKey: string, seq: number): string | undefined {
  const base = process.env.APP_URL;
  return base ? `${base}/project/${projectKey}/issue/${seq}` : undefined;
}

interface StateChange {
  from: string;
  to: string;
}

async function readStateChange(activityId: number): Promise<StateChange | null> {
  const [row] = await db
    .select({ payload: issueActivity.payload })
    .from(issueActivity)
    .where(eq(issueActivity.id, activityId));
  const from = row?.payload.from?.value;
  const to = row?.payload.to?.value;
  if (!from || !to) return null;
  return { from, to };
}

// Email copy, addressed to the recipient in the second person.
function emailPayload(
  type: NotificationType,
  ref: string,
  title: string,
  actor: string,
  url: string | undefined,
  stateChange: StateChange | null,
): DeliveryPayload {
  const line: Record<NotificationType, { subject: string; text: string }> = {
    assigned: { subject: `${ref}: assigned to you`, text: `${actor} assigned this issue to you.` },
    mentioned: {
      subject: `${ref}: you were mentioned`,
      text: `${actor} mentioned you on this issue.`,
    },
    commented: { subject: `${ref}: new comment`, text: `${actor} commented on this issue.` },
    state_changed: {
      subject: stateChange
        ? `${ref}: status changed to ${stateChange.to}`
        : `${ref}: status changed`,
      text: stateChange
        ? `${actor} changed the status of this issue from ${stateChange.from} to ${stateChange.to}.`
        : `${actor} changed the status of this issue.`,
    },
  };
  const { subject, text } = line[type];
  return { subject, text: `${text}\n\n${ref}: ${title}`, url };
}

// Telegram copy. Rendered as HTML (parse_mode HTML) with the issue reference as a
// clickable link, plus a plain-text fallback. Issue-centric third person, matching
// the email copy without repeating the second-person address.
function telegramPayload(
  type: NotificationType,
  ref: string,
  title: string,
  actor: string,
  url: string | undefined,
  stateChange: StateChange | null,
): DeliveryPayload {
  const meta: Record<NotificationType, { emoji: string; action: string }> = {
    assigned: { emoji: '📌', action: `Assigned by ${actor}` },
    mentioned: { emoji: '💬', action: `Mentioned by ${actor}` },
    commented: { emoji: '💬', action: `New comment by ${actor}` },
    state_changed: {
      emoji: '🔄',
      action: stateChange
        ? `Status changed from ${stateChange.from} to ${stateChange.to} by ${actor}`
        : `Status changed by ${actor}`,
    },
  };
  const { emoji, action } = meta[type];

  // HTML (parse_mode=HTML): the issue reference is the clickable link, so no raw URL
  // is shown. A blank line (\n\n) separates the title line from the action line. The
  // plain-text fallback carries no URL here; the sender appends it once.
  const refLink = url
    ? `<a href="${escapeHtml(url)}"><b>${escapeHtml(ref)}</b></a>`
    : `<b>${escapeHtml(ref)}</b>`;
  const html = `${emoji} ${refLink} ${escapeHtml(title)}\n\n<i>${escapeHtml(action)}</i>`;
  const text = `${emoji} ${ref} ${title}\n\n${action}`;
  return { text, html, url };
}

// MS Teams copy. Structured for Adaptive Card 1.4: subject is the title with
// emoji and issue ref, text carries the action, and url provides the action button.
function msteamsPayload(
  type: NotificationType,
  ref: string,
  title: string,
  actor: string,
  url: string | undefined,
  stateChange: StateChange | null,
): DeliveryPayload {
  const meta: Record<NotificationType, { emoji: string; action: string }> = {
    assigned: { emoji: '📌', action: `Assigned by ${actor}` },
    mentioned: { emoji: '💬', action: `Mentioned by ${actor}` },
    commented: { emoji: '💬', action: `New comment by ${actor}` },
    state_changed: {
      emoji: '🔄',
      action: stateChange
        ? `Status changed from ${stateChange.from} to ${stateChange.to} by ${actor}`
        : `Status changed by ${actor}`,
    },
  };
  const { emoji, action } = meta[type];
  const subject = `${emoji} ${ref}: ${title}`;
  return { subject, text: action, url };
}

export interface OutboundEvent {
  type: NotificationType;
  sourceActivityId?: number | null;
  candidateUserIds: (string | null | undefined)[];
}

export interface EnqueueOutboundInput {
  projectId: number;
  issueId: number;
  actorUserId: string | null;
  actorName?: string | null;
  notifications?: NewNotificationRow[];
  events?: OutboundEvent[];
}

async function resolveActorName(id: string): Promise<string> {
  const [row] = await db.select({ name: user.name }).from(user).where(eq(user.id, id));
  return row?.name ?? 'Someone';
}

// Enqueues outbound delivery rows for issue events. Email and Telegram deliver to
// individual recipients per their inbox rows; MS Teams delivers to the project's
// channel webhook when enabled and any participant (actor, watcher, assignee, or
// mention) has subscribed to that event type.
export async function enqueueOutbound(
  input: EnqueueOutboundInput | NewNotificationRow[],
  legacyActorName?: string | null,
): Promise<void> {
  let projectId: number;
  let issueId: number;
  let actorUserId: string | null;
  let actorName: string | null;
  let notifications: NewNotificationRow[];
  let events: OutboundEvent[];

  if (Array.isArray(input)) {
    if (input.length === 0) return;
    projectId = input[0].projectId;
    issueId = input[0].issueId;
    actorUserId = input[0].actorUserId;
    actorName = legacyActorName ?? null;
    notifications = input;
    events = [];
  } else {
    projectId = input.projectId;
    issueId = input.issueId;
    actorUserId = input.actorUserId;
    actorName = input.actorName ?? null;
    notifications = input.notifications ?? [];
    events = input.events ?? [];
  }

  const settings = await readRedactedSettings(projectId);

  // The project's own provider when it configured one, otherwise the instance
  // provider when the project asked for it and the instance shares it.
  const source = emailSource(settings);
  const emailEnabled =
    source === 'smtp'
      ? settings.smtp.host.length > 0 && settings.smtp.hasPassword
      : source === 'resend'
        ? settings.resend.hasApiKey
        : source === 'system'
          ? (await getProjectEmailConfig()) !== null
          : false;
  // The project turns Telegram on; the bot that sends is either its own or, when it
  // set no token, the instance bot.
  const telegramEnabled =
    settings.telegram.enabled && (settings.telegram.hasBotToken || (await hasUsableInstanceBot()));
  const msteamsEnabled = settings.msteams.enabled && settings.msteams.hasWebhookUrl;
  if (!emailEnabled && !telegramEnabled && !msteamsEnabled) return;

  const [issueRow] = await db
    .select({ seq: issue.sequenceNumber, title: issue.title })
    .from(issue)
    .where(eq(issue.id, issueId));
  const [projectRow] = await db
    .select({ key: project.key, name: project.name })
    .from(project)
    .where(eq(project.id, projectId));
  if (!issueRow || !projectRow) return;

  const ref = issueRef(projectRow.key, issueRow.seq);
  const url = issueUrl(projectRow.key, issueRow.seq);
  const actor = actorName ?? (actorUserId ? await resolveActorName(actorUserId) : 'Someone');

  const statusActivityId =
    notifications.find((n) => n.type === 'state_changed')?.sourceActivityId ??
    events.find((e) => e.type === 'state_changed')?.sourceActivityId ??
    null;
  const stateChange = statusActivityId != null ? await readStateChange(statusActivityId) : null;

  const candidateIds = new Set<string>();
  for (const n of notifications) {
    candidateIds.add(n.userId);
  }
  for (const e of events) {
    for (const id of e.candidateUserIds) {
      if (id) candidateIds.add(id);
    }
  }
  if (actorUserId) candidateIds.add(actorUserId);

  const userIds = [...candidateIds];
  const [users, prefsByUser, chatIdByUser] = await Promise.all([
    emailEnabled && notifications.length > 0 && userIds.length > 0
      ? db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, userIds))
      : Promise.resolve([]),
    userIds.length > 0 ? getPreferencesForUsers(projectId, userIds) : Promise.resolve(new Map()),
    telegramEnabled && notifications.length > 0 && userIds.length > 0
      ? getTelegramChatIds(userIds)
      : Promise.resolve(new Map<string, string>()),
  ]);
  const emailById = new Map(users.map((u) => [u.id, u.email]));

  const out: OutboxRow[] = [];
  const msteamsTypesToDeliver = new Set<NotificationType>();

  for (const n of notifications) {
    const prefs = prefsByUser.get(n.userId);
    if (!prefs) continue; // member has not opted in

    if (emailEnabled && prefs.emailEvents[n.type]) {
      const email = emailById.get(n.userId);
      if (email) {
        out.push({
          projectId,
          channel: 'email',
          recipient: email,
          payload: emailPayload(n.type, ref, issueRow.title, actor, url, stateChange),
        });
      }
    }
    if (telegramEnabled && prefs.telegramEvents[n.type]) {
      // No linked Telegram account means nowhere to send; the member sees the prompt
      // to link one in the project's notification settings.
      const chatId = chatIdByUser.get(n.userId);
      if (chatId) {
        out.push({
          projectId,
          channel: 'telegram',
          recipient: chatId,
          payload: telegramPayload(n.type, ref, issueRow.title, actor, url, stateChange),
        });
      }
    }
    if (msteamsEnabled && prefs.msteamsEvents[n.type]) {
      msteamsTypesToDeliver.add(n.type);
    }
  }

  if (msteamsEnabled) {
    for (const ev of events) {
      const shouldDeliver = ev.candidateUserIds.some((id) => {
        if (!id) return false;
        const prefs = prefsByUser.get(id);
        return prefs?.msteamsEvents[ev.type] === true;
      });
      if (shouldDeliver) {
        msteamsTypesToDeliver.add(ev.type);
      }
    }

    for (const type of msteamsTypesToDeliver) {
      out.push({
        projectId,
        channel: 'msteams',
        recipient: null,
        payload: msteamsPayload(type, ref, issueRow.title, actor, url, stateChange),
      });
    }
  }

  if (out.length === 0) return;
  await db.insert(notificationDelivery).values(out);
}

import { describe, it, expect, beforeEach } from 'bun:test';
import { app } from '#tests/helpers/app';
import { authedApi, type Api } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { db, notificationDelivery } from '@repo/db';
import { eq } from 'drizzle-orm';

interface Member {
  api: Api;
  userId: string;
  username: string;
}

async function setup(): Promise<{
  owner: Member;
  projectKey: string;
  projectId: number;
  columnId: number;
}> {
  const u = await signUpTestUser();
  const api = authedApi(u.cookie);
  const key = 'MST';
  await api.projects.post({ key, name: 'MS Teams Project' });
  const view = await api.projects({ projectKey: key }).get();
  const proj = (await api.projects.get()).data!.find((p) => p.key === key)!;
  const columns = view.data!.columns;
  return {
    owner: { api, userId: u.userId, username: u.username },
    projectKey: key,
    projectId: proj.id,
    columnId: columns[0].id,
  };
}

async function addMember(owner: Member, projectKey: string): Promise<Member> {
  const u = await signUpTestUser();
  const invite = await owner.api
    .projects({ projectKey })
    .invites.post({ email: u.email, role: 'member' });
  const api = authedApi(u.cookie);
  await api.invites({ token: invite.data!.token }).accept.post();
  return { api, userId: u.userId, username: u.username };
}

describe('ms teams notifications', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('configures, redacts, and merges ms teams notification settings', async () => {
    const { owner, projectKey } = await setup();

    // Default settings: msteams is disabled and has no webhook URL
    const initial = await owner.api.projects({ projectKey })['notification-settings'].get();
    expect(initial.data!.msteams).toEqual({
      enabled: false,
      hasWebhookUrl: false,
    });

    // Update settings with a webhook URL
    const updated = await owner.api.projects({ projectKey })['notification-settings'].put({
      msteams: {
        enabled: true,
        webhookUrl: 'https://example.webhook.office.com/test-hook',
      },
    });

    expect(updated.data!.msteams).toEqual({
      enabled: true,
      hasWebhookUrl: true,
    });
  });

  it('enqueues deduplicated ms teams delivery rows on subscribed events', async () => {
    const { owner, projectKey, projectId, columnId } = await setup();
    const member = await addMember(owner, projectKey);

    // Enable MS Teams provider on project
    await owner.api.projects({ projectKey })['notification-settings'].put({
      msteams: {
        enabled: true,
        webhookUrl: 'https://example.webhook.office.com/test-hook',
      },
    });

    // Member subscribes to commented events on MS Teams
    const emptyToggles = {
      assigned: false,
      mentioned: false,
      commented: false,
      state_changed: false,
    };
    await member.api.projects({ projectKey })['notification-preferences'].put({
      emailEvents: emptyToggles,
      telegramEvents: emptyToggles,
      msteamsEvents: { ...emptyToggles, commented: true },
    });

    // Create an issue
    const issue = (
      await owner.api.projects({ projectKey }).issues.post({
        columnId,
        title: 'Teams Integration Test',
      })
    ).data!;

    // Have member watch issue by adding a comment
    await member.api.issues({ issueId: issue.id }).comments.post({
      body: 'Initial comment',
    });

    // Clear any previous delivery rows
    await db.delete(notificationDelivery).where(eq(notificationDelivery.projectId, projectId));

    // Owner posts another comment -> member (watcher) is notified with 'commented'
    await owner.api.issues({ issueId: issue.id }).comments.post({
      body: 'Second comment',
    });

    // Check delivery queue
    const deliveries = await db
      .select()
      .from(notificationDelivery)
      .where(eq(notificationDelivery.projectId, projectId));

    const teamsDeliveries = deliveries.filter((d) => d.channel === 'msteams');
    expect(teamsDeliveries).toHaveLength(1);
    expect(teamsDeliveries[0].recipient).toBeNull();
    const payload = teamsDeliveries[0].payload as { subject: string; text: string };
    expect(payload.subject).toContain('Teams Integration Test');
    expect(payload.text).toContain('New comment by');
  });

  it('enqueues ms teams delivery when actor comments on an issue they watch', async () => {
    const { owner, projectKey, projectId, columnId } = await setup();

    // Enable MS Teams provider on project
    await owner.api.projects({ projectKey })['notification-settings'].put({
      msteams: {
        enabled: true,
        webhookUrl: 'https://example.webhook.office.com/test-hook',
      },
    });

    // Owner subscribes to commented events on MS Teams
    const emptyToggles = {
      assigned: false,
      mentioned: false,
      commented: false,
      state_changed: false,
    };
    await owner.api.projects({ projectKey })['notification-preferences'].put({
      emailEvents: emptyToggles,
      telegramEvents: emptyToggles,
      msteamsEvents: { ...emptyToggles, commented: true },
    });

    // Owner creates an issue (auto-watches it)
    const issue = (
      await owner.api.projects({ projectKey }).issues.post({
        columnId,
        title: 'Single User Watching Test',
      })
    ).data!;

    // Clear any previous delivery rows
    await db.delete(notificationDelivery).where(eq(notificationDelivery.projectId, projectId));

    // Owner posts comment on the issue
    await owner.api.issues({ issueId: issue.id }).comments.post({
      body: 'Testing comment webhook',
    });

    // Check delivery queue
    const deliveries = await db
      .select()
      .from(notificationDelivery)
      .where(eq(notificationDelivery.projectId, projectId));

    const teamsDeliveries = deliveries.filter((d) => d.channel === 'msteams');
    expect(teamsDeliveries).toHaveLength(1);
    expect(teamsDeliveries[0].recipient).toBeNull();
    const payload = teamsDeliveries[0].payload as { subject: string; text: string };
    expect(payload.subject).toContain('Single User Watching Test');
    expect(payload.text).toContain('New comment by');
  });

  it('delivers Adaptive Card payload to ms teams webhook via internal route', async () => {
    const { owner, projectKey, projectId } = await setup();

    await owner.api.projects({ projectKey })['notification-settings'].put({
      msteams: {
        enabled: true,
        webhookUrl: 'https://example.webhook.office.com/deliver-hook',
      },
    });

    let postedUrl = '';
    let postedBody: unknown = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      postedUrl = typeof input === 'string' ? input : input.toString();
      postedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const token = 'worker-test-token';
    const previousToken = process.env.WORKER_INTERNAL_TOKEN;
    process.env.WORKER_INTERNAL_TOKEN = token;

    try {
      const res = await app.handle(
        new Request('http://localhost/internal/notification-deliveries/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-worker-token': token },
          body: JSON.stringify({
            projectId,
            channel: 'msteams',
            recipient: null,
            payload: {
              subject: '📌 MST-1: Test Card',
              text: 'Status changed from Todo to Done by Tester',
              url: 'http://localhost/project/MST/issue/1',
            },
          }),
        }),
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true });

      expect(postedUrl).toBe('https://example.webhook.office.com/deliver-hook');
      expect(postedBody).toMatchObject({
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                {
                  type: 'TextBlock',
                  size: 'Medium',
                  weight: 'Bolder',
                  text: '📌 MST-1: Test Card',
                },
                {
                  type: 'TextBlock',
                  text: 'Status changed from Todo to Done by Tester',
                },
              ],
              actions: [
                {
                  type: 'Action.OpenUrl',
                  title: 'View Issue',
                  url: 'http://localhost/project/MST/issue/1',
                },
              ],
            },
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (previousToken == null) delete process.env.WORKER_INTERNAL_TOKEN;
      else process.env.WORKER_INTERNAL_TOKEN = previousToken;
    }
  });
});

import { describe, it, expect, beforeEach } from 'bun:test';
import { findUserById } from '@repo/auth';
import { app, authedApi } from '../helpers/app';
import { signUpTestUser } from '../helpers/auth';
import { resetDb } from '../helpers/db';

const PASSWORD = 'test-password-123';

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: (process.env.APP_URL ?? 'http://localhost:3001').split(',')[0]!.trim(),
  };
  if (init.cookie) headers.cookie = init.cookie;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  const text = await response.text();
  // A refusal comes back as plain text, so this must not insist on JSON.
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }
  return { status: response.status, body };
}

async function usernameOf(userId: string): Promise<string | null> {
  return (await findUserById(userId))?.username ?? null;
}

// A project with one agent answering to the given handle, so the account paths can be
// checked against a name an agent already holds.
async function projectWithAgent(handle: string): Promise<void> {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await asOwner.projects.post({ key: 'MKT', name: 'Marketing' });
  await asOwner.projects({ projectKey: 'MKT' })['ai-agents'].post({
    name: 'Design Bot',
    username: handle,
    kind: 'external',
  });
}

// Sign-up never asks for a username: @repo/auth derives one from the address, and
// the sign-in screen sends whatever was typed in the single identifier field.
describe('usernames', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('derives the username from the local part of the address', async () => {
    const created = await signUpTestUser({ email: 'jane.doe@example.com' });

    expect(await usernameOf(created.userId)).toBe('jane.doe');
  });

  it('gives the same local part on another domain a distinct username', async () => {
    const first = await signUpTestUser({ email: 'jane.doe@example.com' });
    const second = await signUpTestUser({ email: 'jane.doe@other.com' });

    expect(await usernameOf(first.userId)).toBe('jane.doe');
    expect(await usernameOf(second.userId)).toMatch(/^jane\.doe\d+$/);
  });

  it('signs in with the username and the password', async () => {
    const created = await signUpTestUser({ email: 'jane.doe@example.com', password: PASSWORD });

    const response = await call('/auth/sign-in', {
      method: 'POST',
      body: { identifier: 'jane.doe', password: PASSWORD },
    });

    expect(response.status).toBe(200);
    expect((response.body as { user: { id: string } }).user.id).toBe(created.userId);
  });

  it('refuses a username another account already has', async () => {
    await signUpTestUser({ email: 'jane.doe@example.com' });
    const other = await signUpTestUser({ email: 'someone@example.com' });

    const attempt = await call('/auth/username', {
      method: 'PATCH',
      cookie: other.cookie,
      body: { username: 'jane.doe' },
    });

    expect(attempt.status).toBe(409);
    expect(await usernameOf(other.userId)).toBe('someone');
  });

  it('changes the username of the signed-in account', async () => {
    const created = await signUpTestUser({ email: 'jane.doe@example.com' });

    const response = await call('/auth/username', {
      method: 'PATCH',
      cookie: created.cookie,
      body: { username: 'janed' },
    });

    expect(response.status).toBe(200);
    expect(await usernameOf(created.userId)).toBe('janed');
  });

  it('refuses a handle the format does not allow', async () => {
    const created = await signUpTestUser({ email: 'jane.doe@example.com' });

    const attempt = await call('/auth/username', {
      method: 'PATCH',
      cookie: created.cookie,
      body: { username: 'no spaces' },
    });

    expect(attempt.status).toBe(400);
  });

  // A mention is resolved against members and agents at once, so the two share one
  // namespace and every path that sets an account's name checks it against the agents.
  it('refuses changing a username onto one an agent uses', async () => {
    await projectWithAgent('design');
    const member = await signUpTestUser({ email: 'someone@example.com' });

    const attempt = await call('/auth/username', {
      method: 'PATCH',
      cookie: member.cookie,
      body: { username: 'design' },
    });

    expect(attempt.status).toBe(409);
    expect(await usernameOf(member.userId)).toBe('someone');
  });

  it('derives a username that skips a name an agent uses', async () => {
    await projectWithAgent('jane.doe');

    const created = await signUpTestUser({ email: 'jane.doe@example.com' });

    expect(await usernameOf(created.userId)).toMatch(/^jane\.doe\d+$/);
  });

  it('does not answer whether a username is taken', async () => {
    await signUpTestUser({ email: 'jane.doe@example.com' });

    // There is no availability endpoint on purpose: it would turn the handle list
    // into an account enumeration oracle for anyone who is not signed in.
    const response = await call('/auth/username/available?username=jane.doe');

    expect(response.status).toBe(404);
  });
});

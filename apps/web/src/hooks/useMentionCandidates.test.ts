import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMentionCandidates } from './useMentionCandidates';
import type { Assignee } from '@/lib/api';

describe('formatMentionCandidates', () => {
  it('formats members and agents with fallback username if missing', () => {
    const assignees: Assignee[] = [
      {
        userId: 'u1',
        name: 'Alice Johnson',
        email: 'alice@example.com',
        username: 'alice',
        image: 'https://example.com/alice.jpg',
        kind: 'member',
        agentKind: null,
        restrictedToUserId: null,
      },
      {
        userId: 'u2',
        name: 'Bob Smith',
        email: 'bob@example.com',
        username: null,
        image: null,
        kind: 'member',
        agentKind: null,
        restrictedToUserId: null,
      },
      {
        userId: 'a1',
        name: 'Code Reviewer',
        email: 'agent-cr@agents.local',
        username: 'reviewer',
        image: null,
        kind: 'agent',
        agentKind: 'internal',
        restrictedToUserId: null,
      },
    ];

    const result = formatMentionCandidates(assignees);
    assert.equal(result.length, 3);
    assert.equal(result[0].username, 'alice');
    assert.equal(result[0].image, 'https://example.com/alice.jpg');
    assert.equal(result[1].username, 'bob');
    assert.equal(result[2].kind, 'agent');
    assert.equal(result[2].agentKind, 'internal');
  });
});

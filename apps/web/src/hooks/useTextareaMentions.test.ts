import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchMentionQuery, replaceMentionText } from './useTextareaMentions';

describe('useTextareaMentions helpers', () => {
  it('detects mention query at start of line', () => {
    const match = matchMentionQuery('@ali', 4);
    assert.deepEqual(match, { query: 'ali', anchor: 0 });
  });

  it('detects mention query after whitespace', () => {
    const match = matchMentionQuery('Hello @bo', 9);
    assert.deepEqual(match, { query: 'bo', anchor: 6 });
  });

  it('does not match email addresses as mentions', () => {
    const match = matchMentionQuery('test@example', 12);
    assert.equal(match, null);
  });

  it('replaces query with mention handle and space', () => {
    const text = 'Hello @bo';
    const next = replaceMentionText(text, 6, 9, 'bob');
    assert.equal(next.value, 'Hello @bob ');
    assert.equal(next.newCaret, 11);
  });

  it('avoids double space when text already has trailing space', () => {
    const text = 'Hello @bo world';
    const next = replaceMentionText(text, 6, 9, 'bob');
    assert.equal(next.value, 'Hello @bob world');
    assert.equal(next.newCaret, 10);
  });
});

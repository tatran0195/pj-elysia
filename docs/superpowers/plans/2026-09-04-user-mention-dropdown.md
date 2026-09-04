# Unified User & Agent Mention Dropdowns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify and support `@` user and AI agent mention dropdowns across the Issue Markdown Editor, Comment Composer, and AI Agent Chat panel.

**Architecture:** A shared candidate data model (`MentionCandidate`), a reusable dropdown presentation component (`EditorMentionMenu`), a lightweight custom hook for textareas (`useTextareaMentions`), and an improved Floating UI configuration for the Tiptap markdown editor (`tiptap-mention.ts`).

**Tech Stack:** React 19, TypeScript, Tiptap 3 / ProseMirror, Floating UI, Vite, React Router 8, shadcn/ui, Bun.

## Global Constraints
- All code, comments, and strings in English.
- No new external dependencies without approval; leverage existing Tiptap, shadcn/ui, and Radix primitives.
- Keep comments minimal (explaining "why", not "what").
- Never run `git commit` or `git push` directly; propose Conventional Commit messages for the user.

---

### Task 1: Candidate Model & `useMentionCandidates` Refinement

**Files:**
- Modify: `apps/web/src/lib/tiptap-mention.ts:9-16`
- Modify: `apps/web/src/hooks/useMentionCandidates.ts:1-18`
- Create: `apps/web/src/hooks/useMentionCandidates.test.ts`

**Interfaces:**
- Produces: `MentionCandidate` interface:
  ```ts
  export interface MentionCandidate {
    userId: string;
    name: string;
    username: string;
    image: string | null;
    kind: 'member' | 'agent';
    agentKind?: 'external' | 'internal' | null;
  }
  ```
- Produces: `useMentionCandidates(projectAssignees?: Assignee[]): MentionCandidate[]`

- [ ] **Step 1: Write the failing unit test for `useMentionCandidates`**

```ts
// apps/web/src/hooks/useMentionCandidates.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/hooks/useMentionCandidates.test.ts` in `apps/web`
Expected: FAIL (formatMentionCandidates is not exported)

- [ ] **Step 3: Update `MentionCandidate` and implement `formatMentionCandidates`**

Update `apps/web/src/lib/tiptap-mention.ts`:
```ts
export interface MentionCandidate {
  userId: string;
  name: string;
  username: string;
  image: string | null;
  kind: 'member' | 'agent';
  agentKind?: 'external' | 'internal' | null;
}
```

Update `apps/web/src/hooks/useMentionCandidates.ts`:
```ts
import { useContext, useMemo } from 'react';
import { ShellCtx } from '@/context/shellContext';
import { type Assignee } from '@/lib/api';
import { type MentionCandidate } from '@/lib/tiptap-mention';

export function deriveHandle(name: string, email: string): string {
  const stem = (email.split('@')[0] || name)
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, 27);
  return stem || 'user';
}

export function formatMentionCandidates(assignees?: Assignee[]): MentionCandidate[] {
  return (assignees ?? []).map((a) => ({
    userId: a.userId,
    name: a.name,
    username: a.username ?? deriveHandle(a.name, a.email),
    image: a.image,
    kind: a.kind,
    agentKind: a.agentKind,
  }));
}

export function useMentionCandidates(overrideAssignees?: Assignee[]): MentionCandidate[] {
  const shellAssignees = useContext(ShellCtx)?.project?.assignees;
  const assignees = overrideAssignees ?? shellAssignees;
  return useMemo(() => formatMentionCandidates(assignees), [assignees]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/hooks/useMentionCandidates.test.ts` in `apps/web`
Expected: PASS

---

### Task 2: Shared `EditorMentionMenu` UI Component

**Files:**
- Modify: `apps/web/src/components/common/editor/EditorMentionMenu.tsx:1-75`

**Interfaces:**
- Consumes: `MentionCandidate` from `apps/web/src/lib/tiptap-mention.ts`
- Produces: `EditorMentionMenu` component with `forwardRef` supporting `MentionMenuRef`:
  ```ts
  export type MentionMenuRef = {
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
  };
  ```

- [ ] **Step 1: Update `EditorMentionMenu.tsx` with forwardRef, Avatar, and agent badges**

```tsx
// apps/web/src/components/common/editor/EditorMentionMenu.tsx
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Bot } from 'lucide-react';
import Avatar from '@/components/common/Avatar';
import { cn } from '@/lib/utils';
import { type MentionCandidate } from '@/lib/tiptap-mention';

export type MentionMenuRef = { onKeyDown: (props: { event: KeyboardEvent }) => boolean };

export interface EditorMentionMenuProps {
  items: MentionCandidate[];
  command: (item: MentionCandidate) => void;
  className?: string;
}

const EditorMentionMenu = forwardRef<MentionMenuRef, EditorMentionMenuProps>(
  function EditorMentionMenu({ items, command, className }, ref) {
    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => setActiveIndex(0), [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        switch (event.key) {
          case 'ArrowDown':
            setActiveIndex((index) => (index + 1) % items.length);
            return true;
          case 'ArrowUp':
            setActiveIndex((index) => (index - 1 + items.length) % items.length);
            return true;
          case 'Enter':
          case 'Tab': {
            const item = items[activeIndex];
            if (item) command(item);
            return true;
          }
          default:
            return false;
        }
      },
    }));

    if (items.length === 0) return null;

    return (
      <div
        role="listbox"
        className={cn(
          'max-h-64 w-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
          className,
        )}
      >
        {items.map((item, index) => {
          const isSelected = index === activeIndex;
          return (
            <button
              key={item.userId}
              type="button"
              role="option"
              aria-selected={isSelected}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(item)}
              onMouseEnter={() => setActiveIndex(index)}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                isSelected && 'bg-accent text-accent-foreground',
              )}
            >
              {item.kind === 'agent' ? (
                <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Bot className="size-3.5 text-muted-foreground" />
                </div>
              ) : (
                <Avatar
                  name={item.name}
                  image={item.image}
                  className="size-5 shrink-0 text-[10px]"
                />
              )}
              <span className="truncate font-medium">{item.name}</span>
              <span className="flex-1 truncate text-xs text-muted-foreground">@{item.username}</span>
              {item.kind === 'agent' && (
                <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground uppercase">
                  {item.agentKind ?? 'agent'}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  },
);

export default EditorMentionMenu;
```

- [ ] **Step 2: Run typecheck to verify props and ref compatibility**

Run: `bun run typecheck` in `apps/web`
Expected: PASS

---

### Task 3: Textarea Mentions Hook (`useTextareaMentions`)

**Files:**
- Create: `apps/web/src/hooks/useTextareaMentions.ts`
- Create: `apps/web/src/hooks/useTextareaMentions.test.ts`

**Interfaces:**
- Produces: `useTextareaMentions` hook:
  ```ts
  export function useTextareaMentions({
    candidates,
    textareaRef,
    value,
    onChange,
  }: {
    candidates: MentionCandidate[];
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    value: string;
    onChange: (nextValue: string) => void;
  }): {
    isOpen: boolean;
    query: string;
    anchor: number;
    filteredCandidates: MentionCandidate[];
    selectCandidate: (candidate: MentionCandidate) => void;
    onInputChange: (newValue: string, caret: number) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
    closeMenu: () => void;
  }
  ```

- [ ] **Step 1: Write failing unit test for `useTextareaMentions` logic**

```ts
// apps/web/src/hooks/useTextareaMentions.test.ts
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
    const text = 'Hello @bo world';
    const next = replaceMentionText(text, 6, 9, 'bob');
    assert.equal(next.value, 'Hello @bob world');
    assert.equal(next.newCaret, 11);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/hooks/useTextareaMentions.test.ts` in `apps/web`
Expected: FAIL (cannot find module)

- [ ] **Step 3: Implement `useTextareaMentions`**

Create `apps/web/src/hooks/useTextareaMentions.ts`:
```ts
import { useCallback, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { type MentionCandidate } from '@/lib/tiptap-mention';

export interface MentionMatch {
  query: string;
  anchor: number;
}

export function matchMentionQuery(textBeforeCaret: string, caret: number): MentionMatch | null {
  const match = textBeforeCaret.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const query = match[1];
  const anchor = caret - query.length - 1;
  return { query, anchor };
}

export function replaceMentionText(
  body: string,
  anchor: number,
  caret: number,
  username: string,
): { value: string; newCaret: number } {
  const handle = `@${username} `;
  const value = `${body.slice(0, anchor)}${handle}${body.slice(caret)}`;
  return { value, newCaret: anchor + handle.length };
}

export function useTextareaMentions({
  candidates,
  textareaRef,
  value,
  onChange,
}: {
  candidates: MentionCandidate[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (nextValue: string) => void;
}) {
  const [match, setMatch] = useState<MentionMatch | null>(null);

  const filteredCandidates = useMemo(() => {
    if (!match) return [];
    const q = match.query.toLowerCase();
    return candidates
      .filter((c) => c.name.toLowerCase().includes(q) || c.username.toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, match]);

  const selectCandidate = useCallback(
    (candidate: MentionCandidate) => {
      if (!match) return;
      const caret = textareaRef.current?.selectionStart ?? value.length;
      const { value: nextValue, newCaret } = replaceMentionText(
        value,
        match.anchor,
        caret,
        candidate.username,
      );
      onChange(nextValue);
      setMatch(null);
      queueMicrotask(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(newCaret, newCaret);
        }
      });
    },
    [match, onChange, textareaRef, value],
  );

  const onInputChange = useCallback((nextValue: string, caret: number) => {
    onChange(nextValue);
    const before = nextValue.slice(0, caret);
    const m = matchMentionQuery(before, caret);
    setMatch(m);
  }, [onChange]);

  const closeMenu = useCallback(() => setMatch(null), []);

  return {
    isOpen: match !== null && filteredCandidates.length > 0,
    query: match?.query ?? '',
    anchor: match?.anchor ?? 0,
    filteredCandidates,
    selectCandidate,
    onInputChange,
    closeMenu,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/hooks/useTextareaMentions.test.ts` in `apps/web`
Expected: PASS

---

### Task 4: Integrate Mentions in `CommentComposer` & Fix Clipping

**Files:**
- Modify: `apps/web/src/features/issue/components/detail/CommentComposer.tsx:1-249`
- Modify: `apps/web/src/features/issue/components/detail/CommentThread.tsx:47-50`

**Interfaces:**
- Consumes: `useTextareaMentions`, `useMentionCandidates`, `EditorMentionMenu`

- [ ] **Step 1: Refactor `CommentComposer` to use `useTextareaMentions` and `EditorMentionMenu`**

Update `CommentComposer.tsx` to use the shared hook and component:
- Forward keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`, `Tab`, `Escape`) to `menuRef`.
- Use `EditorMentionMenu` mounted directly under the textarea with high z-index and absolute positioning.

- [ ] **Step 2: Adjust `CommentThread.tsx` card wrapper so popover isn't clipped**

In `CommentThread.tsx`:
Replace `overflow-hidden` with `overflow-visible` on rows where a composer or reply is mounted, or use `rounded-lg border bg-muted/40` without `overflow-hidden` so the popover remains fully visible.

- [ ] **Step 3: Run existing tests in `apps/web`**

Run: `bun test` in `apps/web`
Expected: PASS

---

### Task 5: Integrate Mentions in `AgentChatPanel`

**Files:**
- Modify: `apps/web/src/components/common/agent-chat/AgentChatPanel.tsx:1-255`
- Modify: `apps/web/src/features/ai-chat/components/shared/AiChatThread.tsx:20-40`

**Interfaces:**
- Consumes: `useMentionCandidates`, `useTextareaMentions`, `EditorMentionMenu`

- [ ] **Step 1: Connect `useMentionCandidates` and `useTextareaMentions` in `AgentChatPanel`**

In `AgentChatPanel.tsx`:
- Call `useMentionCandidates()`.
- Use `useTextareaMentions({ candidates, textareaRef, value: input, onChange: setInput })`.
- Intercept `onKeyDown` in `InputGroupTextarea` so when the menu is open, `Enter`/`Tab`/`Arrow` navigate and pick mention candidate instead of submitting the message.
- Render `EditorMentionMenu` positioned above the input container:
  ```tsx
  {mention.isOpen && (
    <div className="absolute bottom-full left-0 z-30 mb-1">
      <EditorMentionMenu
        ref={menuRef}
        items={mention.filteredCandidates}
        command={mention.selectCandidate}
      />
    </div>
  )}
  ```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck` in `apps/web`
Expected: PASS

---

### Task 6: Refine `IssueMarkdownEditor` & `tiptap-mention.ts`

**Files:**
- Modify: `apps/web/src/lib/tiptap-mention.ts:128-182`
- Modify: `apps/web/src/features/issue/components/editor/IssueMarkdownEditor.tsx:99-103`
- Modify: `apps/web/src/features/issue/components/editor/IssueMarkdownEditor.test.ts`

- [ ] **Step 1: Add test verifying Mention extension registration and markdown serialization**

Add test case in `apps/web/src/features/issue/components/editor/IssueMarkdownEditor.test.ts`:
```ts
it('registers Mention extension and serializes @mention to markdown', () => {
  const editor = new Editor({
    extensions: [
      StarterKit.configure(issueEditorStarterKitOptions),
      Mention.configure({ items: () => [] }),
      Markdown.configure({ html: true }),
    ],
    content: '<p>Hello <span data-mention="alice">@alice</span></p>',
  });

  const md = editor.storage.markdown.getMarkdown();
  assert.equal(md.trim(), 'Hello @alice');
  editor.destroy();
});
```

- [ ] **Step 2: Run test to verify it passes/fails**

Run: `bun test src/features/issue/components/editor/IssueMarkdownEditor.test.ts` in `apps/web`
Expected: Verify current behavior.

- [ ] **Step 3: Update `tiptap-mention.ts` Floating UI configuration**

In `tiptap-mention.ts`:
- Set Floating UI strategy to `'fixed'` so positioning works cleanly across dialog modals and side panels without being thrown off by ancestor transforms or scroll offsets.
- Remove hardcoded selector trap or set fallback `container: '[data-slot="dialog-content"]'` with strategy `fixed`.
- Ensure `EditorMentionMenu` receives proper `className: 'z-[100]'`.

- [ ] **Step 4: Run tests**

Run: `bun test src/features/issue/components/editor/IssueMarkdownEditor.test.ts` in `apps/web`
Expected: PASS

---

### Task 7: Full Workspace Verification & Quality Gate

**Files:**
- All modified files

- [ ] **Step 1: Run all tests in apps/web**

Run: `bun test` in `apps/web`
Expected: All tests PASS.

- [ ] **Step 2: Run workspace typecheck**

Run: `bun run typecheck` from repo root
Expected: Exit code 0, no type errors.

- [ ] **Step 3: Run workspace lint & formatting check**

Run: `bun run lint` and `bun run format:check` from repo root
Expected: Exit code 0, no lint or format errors.

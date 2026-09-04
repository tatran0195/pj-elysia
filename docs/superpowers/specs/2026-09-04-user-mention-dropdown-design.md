# Unified User & Agent Mention Dropdowns Design

Support and unify `@` mention dropdowns across the application, allowing users to mention team members and AI agents seamlessly with a consistent UI/UX.

## Scope & Coverage

1. **Issue Description & Markdown Custom Fields** (`IssueMarkdownEditor` via `@tiptap/suggestion`)
2. **Comment Composer & Thread Replies** (`CommentComposer` in `IssueActivityFeed` and `CommentThread`)
3. **AI Agent Chat** (`AgentChatPanel` in floating chat panel and session tabs)

---

## 1. Candidate Data Model & Resolution

### Data Structure
A unified `MentionCandidate` interface shared across editors:

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

### Candidate Sourcing (`useMentionCandidates`)
- Reads project assignees from `ShellCtx` (or project details).
- For each member and agent, includes their `userId`, `name`, `username`, `image`, and `kind`.
- Handles edge cases where a member's username might be empty by falling back to their normalized email prefix or name handle.
- Filters candidates case-insensitively by matching either `name` or `username`.
- Returns up to 8 matching candidates, prioritized by relevance.

---

## 2. Shared UI Dropdown Component (`EditorMentionMenu`)

Refactor `EditorMentionMenu.tsx` into the single shared visual dropdown:

1. **Candidate Row**:
   - **Avatar / Icon**: `Avatar` component with profile image and fallback initials for members; `Bot` icon for AI agents.
   - **Display Name**: Truncated font-medium display name.
   - **Handle**: `@username` in muted text.
   - **Agent Badge**: Discrete badge for AI agents (`agentKind: internal | external`).
2. **Interaction**:
   - Keyboard selection with highlighted index (`bg-accent text-accent-foreground`).
   - Mouse hover updates active index.
   - Mouse down prevents default to avoid stealing input/textarea focus.
   - ForwardRef compatibility for Tiptap's `ReactRenderer` imperative keyboard calls (`ArrowUp`, `ArrowDown`, `Enter`, `Tab`, `Escape`).
3. **Container & Styling**:
   - Standard Popover styling (`bg-popover text-popover-foreground border rounded-md shadow-md p-1`).
   - `max-h-64 overflow-y-auto` scrollable list.

---

## 3. Plain Textarea Mention Hook (`useTextareaMentions`)

For plain `<textarea>` inputs (`CommentComposer`, `AgentChatPanel`), a dedicated hook manages mention state:

1. **Trigger Recognition**:
   - Matches regex `(?:^|\s)@([^\s@]*)$` against the text before the cursor.
   - Tracks the active query string and the `@` anchor index.
2. **Keyboard Navigation**:
   - Intercepts `ArrowDown`, `ArrowUp`, `Enter`, `Tab`, `Escape` when the mention dropdown is open.
   - Prevents form submission or unintended line breaks when `Enter` is pressed to select a candidate.
3. **Selection & Replacement**:
   - Replaces `@query` with `@username `.
   - Restores caret position immediately after the inserted handle.
4. **Overlay Positioning**:
   - Places the dropdown relative to the textarea using portal/fixed positioning or positioned wrapper to avoid being clipped by `overflow-hidden` ancestors (such as `CommentThread` list items).
   - In `AgentChatPanel`, mounts above the input box (bottom-anchored chat input).
   - In `CommentComposer`, mounts below or above depending on viewport space.

---

## 4. Rich Text / Tiptap Integration (`tiptap-mention.ts`)

For rich markdown editors (`IssueMarkdownEditor`):

1. **Mounting & Positioning**:
   - Configure Floating UI with `strategy: 'fixed'` to prevent dialog `overflow-hidden` or scroll containers from clipping the dropdown.
   - Fall back gracefully to `document.body` portal when outside modal dialogs (e.g., full-page issue view or side panel).
2. **Chip Node**:
   - Renders as an inline atom node: `<span class="mention" data-mention="username">@username</span>`.
   - Displays hover tooltip with member's full name.
   - Serializes to markdown as `@username` and parses back from markdown text via `markMentions`.

---

## 5. Verification Plan

1. **Unit & Component Tests**:
   - Verify `useTextareaMentions` regex matching, keyboard navigation, and string replacement.
   - Verify `useMentionCandidates` filters and formats project members and agents.
   - Verify Tiptap markdown serialization and round-trip parsing of `@username`.
2. **Typecheck & Lint**:
   - Run `bun run typecheck` across the workspace.
   - Run `bun run lint` across the workspace.
3. **Manual / Interactive Verification**:
   - Test `@` mention in new issue modal and issue detail description.
   - Test `@` mention in comment box and nested reply threads.
   - Test `@` mention in the floating AI chat panel.

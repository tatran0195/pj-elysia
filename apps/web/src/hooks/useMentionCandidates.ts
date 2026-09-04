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

// Who the editors offer after an "@": the active project's members and agents.
// Read from the payload the Shell loads, or from the given override assignees list.
export function useMentionCandidates(overrideAssignees?: Assignee[]): MentionCandidate[] {
  const shellAssignees = useContext(ShellCtx)?.project?.assignees;
  const assignees = overrideAssignees ?? shellAssignees;
  return useMemo(() => formatMentionCandidates(assignees), [assignees]);
}

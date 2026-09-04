import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { type MentionCandidate } from '@/lib/tiptap-mention';
import { type MentionMenuRef } from '@/components/common/editor/EditorMentionMenu';
import { calculateMentionPosition, type TextareaMentionPosition } from '@/utils/textareaCaret';

export { type TextareaMentionPosition };

export interface MentionMatch {
  query: string;
  anchor: number;
}

// Matches an @query that sits at the start of text or after whitespace, and does
// not look like an email address.
export function matchMentionQuery(textBeforeCaret: string, caret: number): MentionMatch | null {
  const match = textBeforeCaret.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const query = match[1];
  const anchor = caret - query.length - 1;
  return { query, anchor };
}

// Replaces the "@query" span with "@username " and returns the new caret position.
export function replaceMentionText(
  body: string,
  anchor: number,
  caret: number,
  username: string,
): { value: string; newCaret: number } {
  const trailing = body.slice(caret).startsWith(' ') ? '' : ' ';
  const handle = `@${username}${trailing}`;
  const value = `${body.slice(0, anchor)}${handle}${body.slice(caret)}`;
  return { value, newCaret: anchor + handle.length };
}

export function useTextareaMentions({
  candidates,
  textareaRef,
  containerRef,
  value,
  onChange,
}: {
  candidates: MentionCandidate[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  containerRef?: RefObject<HTMLElement | null>;
  value: string;
  onChange: (nextValue: string) => void;
}) {
  const [match, setMatch] = useState<MentionMatch | null>(null);
  const [position, setPosition] = useState<TextareaMentionPosition | null>(null);
  const menuRef = useRef<MentionMenuRef | null>(null);

  const filteredCandidates = useMemo(() => {
    if (!match) return [];
    const q = match.query.toLowerCase();
    return candidates
      .filter((c) => c.name.toLowerCase().includes(q) || c.username.toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, match]);

  const updatePosition = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta || !match) {
      setPosition(null);
      return;
    }
    const container =
      containerRef?.current ?? (ta.closest('.relative') as HTMLElement | null) ?? ta.parentElement;
    if (!container) return;
    const nextPos = calculateMentionPosition(ta, container, match.anchor);
    setPosition(nextPos);
  }, [containerRef, match, textareaRef]);

  useEffect(() => {
    if (match) updatePosition();
    else setPosition(null);
  }, [match, updatePosition]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !match) return;
    const onScroll = () => updatePosition();
    ta.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      ta.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [match, textareaRef, updatePosition]);

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
      setPosition(null);
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

  const onInputChange = useCallback(
    (nextValue: string, caret: number) => {
      onChange(nextValue);
      const before = nextValue.slice(0, caret);
      const m = matchMentionQuery(before, caret);
      setMatch(m);
    },
    [onChange],
  );

  const closeMenu = useCallback(() => {
    setMatch(null);
    setPosition(null);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!match || filteredCandidates.length === 0) return false;
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
        e.preventDefault();
        return menuRef.current?.onKeyDown({ event: e.nativeEvent }) ?? false;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        return true;
      }
      return false;
    },
    [match, filteredCandidates.length, closeMenu],
  );

  return {
    isOpen: match !== null && filteredCandidates.length > 0,
    query: match?.query ?? '',
    anchor: match?.anchor ?? 0,
    position,
    filteredCandidates,
    selectCandidate,
    onInputChange,
    closeMenu,
    onKeyDown,
    menuRef,
  };
}

import { useEffect, useRef, useState } from 'react';
import { type Assignee } from '@/lib/api';
import Avatar from '@/components/common/Avatar';
import EditorMentionMenu from '@/components/common/editor/EditorMentionMenu';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useCreateComment } from '../../services/comments.service';
import { useMentionCandidates } from '@/hooks/useMentionCandidates';
import { useTextareaMentions } from '@/hooks/useTextareaMentions';
import { useTranslations } from '@/i18n/runtime';

// The new-comment box: a plain markdown textarea with an @-mention menu. Typing "@"
// opens a menu of the project's members and agents; picking one writes their handle
// as @username into the body. That handle is what the backend resolves to notify a
// member or trigger an agent, and what the feed renders as a chip. Posts as the
// current session user on the button or Cmd/Ctrl+Enter.

// What every composer needs to post, gathered once by the activity feed: the issue,
// who can be mentioned, and the author the avatar stands for.
export interface ComposerContext {
  issueId: number;
  assignees: Assignee[];
  authorName: string;
  authorImage: string | null;
}

export default function CommentComposer({
  issueId,
  assignees,
  authorName,
  authorImage,
  replyToId,
  replyToName,
  onClose,
}: ComposerContext & {
  // Set on the reply box a thread opens: the comment it answers and its author.
  replyToId?: number;
  replyToName?: string | null;
  // Closes the reply box — on the cancel button, on Escape, and once the reply is
  // posted. The box a thread opens is the only one that can be closed.
  onClose?: () => void;
}) {
  const t = useTranslations('issue.comments');
  const createComment = useCreateComment();
  const [body, setBody] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const posting = createComment.isPending;
  const isReply = replyToId != null;
  const cmdKey = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';

  const containerRef = useRef<HTMLDivElement | null>(null);
  const candidates = useMentionCandidates(assignees);
  const mention = useTextareaMentions({
    candidates,
    textareaRef: taRef,
    containerRef,
    value: body,
    onChange: setBody,
  });

  // A reply box is opened by a deliberate click on Reply, so it takes the caret.
  useEffect(() => {
    if (isReply) taRef.current?.focus();
  }, [isReply]);

  async function post() {
    if (!body.trim()) return;
    await createComment.mutateAsync({ issueId, input: { body: body.trim(), replyToId } });
    setBody('');
    mention.closeMenu();
    onClose?.();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.onKeyDown(e)) return;
    if (e.key === 'Escape' && onClose) {
      e.preventDefault();
      onClose();
      return;
    }
    // Cmd/Ctrl+Enter submits, matching the rest of the planner.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void post();
  }

  let placeholder = t('placeholder');
  if (isReply)
    placeholder = replyToName ? t('replyTo', { name: replyToName }) : t('replyPlaceholder');

  let submitLabel = isReply ? t('reply') : t('comment');
  if (posting) submitLabel = t('posting');

  return (
    <div className={cn(!isReply && 'mb-5')}>
      <div className="flex gap-3">
        <Avatar
          name={authorName}
          image={authorImage}
          className={cn('mt-0.5 shrink-0 text-[11px]', isReply ? 'size-6' : 'size-7')}
          title={t('commentAs', { name: authorName })}
        />
        <div ref={containerRef} className="relative min-w-0 flex-1">
          <div className="overflow-hidden rounded-lg border bg-muted/20 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
            <Textarea
              ref={taRef}
              // `auto` once there is something to read, so a comment keeps the
              // script it was typed in. An empty box has nothing to read from, and
              // would fall back to left-to-right and strand the placeholder.
              dir={body ? 'auto' : undefined}
              value={body}
              onChange={(e) =>
                mention.onInputChange(
                  e.target.value,
                  e.target.selectionStart ?? e.target.value.length,
                )
              }
              placeholder={placeholder}
              className={cn(
                'resize-none rounded-none border-0 bg-transparent px-3 py-2.5 shadow-none focus-visible:ring-0',
                isReply ? 'min-h-[52px]' : 'min-h-[64px]',
              )}
              onKeyDown={onKeyDown}
            />
            <div className="flex items-center justify-between gap-2 border-t px-2.5 py-2">
              <span className="text-[11px] text-muted-foreground/70">
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-sans text-[10px] font-medium">
                  {cmdKey} ↵
                </kbd>
                <span className="ml-1.5">{t('toSend')}</span>
              </span>
              <div className="flex items-center gap-1.5">
                {onClose && (
                  <Button size="sm" variant="ghost" onClick={onClose}>
                    {t('cancel')}
                  </Button>
                )}
                <Button size="sm" disabled={!body.trim() || posting} onClick={() => void post()}>
                  {submitLabel}
                </Button>
              </div>
            </div>
          </div>

          {mention.isOpen && (
            <div
              style={{
                position: 'absolute',
                top: mention.position?.top,
                bottom: mention.position?.bottom,
                left: mention.position?.left ?? 0,
              }}
              className="z-30"
            >
              <EditorMentionMenu
                ref={mention.menuRef}
                items={mention.filteredCandidates}
                command={mention.selectCandidate}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

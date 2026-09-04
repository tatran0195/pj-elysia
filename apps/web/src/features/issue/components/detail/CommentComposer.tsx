import { useEffect, useRef, useState } from 'react';
import { type Editor } from '@tiptap/react';
import { type Assignee } from '@/lib/api';
import Avatar from '@/components/common/Avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import IssueMarkdownEditor from '../editor/IssueMarkdownEditor';
import { useCreateComment } from '../../services/comments.service';
import { useTranslations } from '@/i18n/runtime';

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
  replyToId?: number;
  replyToName?: string | null;
  onClose?: () => void;
}) {
  const t = useTranslations('issue.comments');
  const createComment = useCreateComment();
  const [body, setBody] = useState('');
  const editorRef = useRef<Editor | null>(null);

  const posting = createComment.isPending;
  const isReply = replyToId != null;
  const cmdKey = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';

  useEffect(() => {
    if (isReply) editorRef.current?.commands.focus('end');
  }, [isReply]);

  async function post() {
    const text = (editorRef.current?.storage.markdown.getMarkdown() ?? body).trim();
    if (!text) return;
    await createComment.mutateAsync({ issueId, input: { body: text, replyToId } });
    editorRef.current?.commands.setContent('');
    setBody('');
    onClose?.();
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
        <div className="relative min-w-0 flex-1">
          <div className="overflow-hidden rounded-lg border bg-muted/20 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
            <IssueMarkdownEditor
              defaultValue=""
              placeholder={placeholder}
              onChange={setBody}
              onReady={(ed) => {
                editorRef.current = ed;
                if (isReply) ed?.commands.focus('end');
              }}
              autofocus={isReply ? 'end' : false}
              assignees={assignees}
              onSubmit={() => void post()}
              onCancel={onClose}
              className={cn(
                'flex flex-col px-3 py-2.5 text-sm',
                isReply ? 'min-h-[52px]' : 'min-h-[64px]',
              )}
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
        </div>
      </div>
    </div>
  );
}

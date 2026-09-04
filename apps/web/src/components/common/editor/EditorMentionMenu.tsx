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

// The list shown after typing "@": who can be mentioned, by name and by the handle
// the mention is written with. Escape is handled by the suggestion plugin or textarea hook.
const EditorMentionMenu = forwardRef<MentionMenuRef, EditorMentionMenuProps>(
  function EditorMentionMenu({ items, command, className }, ref) {
    const [activeIndex, setActiveIndex] = useState(0);

    // Typing narrows the list, which can leave the highlight past its end.
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
              // The caret must stay in the typed "@query": the command replaces it.
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
              <span className="flex-1 truncate text-xs text-muted-foreground">
                @{item.username}
              </span>
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

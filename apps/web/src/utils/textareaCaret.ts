const PROPERTIES = [
  'box-sizing',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-style',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'line-height',
  'text-align',
  'text-indent',
  'text-transform',
  'direction',
  'tab-size',
] as const;

export interface CaretCoordinates {
  top: number;
  left: number;
  height: number;
}

export interface TextareaMentionPosition {
  top?: number;
  bottom?: number;
  left: number;
}

// Computes the pixel coordinates of a character in a textarea using a hidden mirror element.
export function getCaretCoordinates(
  element: HTMLTextAreaElement,
  position: number,
): CaretCoordinates {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { top: 0, left: 0, height: 20 };
  }

  const computed = window.getComputedStyle(element);
  const div = document.createElement('div');
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.top = '-9999px';
  div.style.left = '-9999px';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordBreak = 'break-word';
  div.style.overflowWrap = 'break-word';

  for (const prop of PROPERTIES) {
    const val = computed.getPropertyValue(prop);
    if (val) div.style.setProperty(prop, val);
  }

  div.style.width = `${element.clientWidth}px`;
  div.textContent = element.value.slice(0, position);

  const marker = document.createElement('span');
  marker.textContent = element.value.slice(position) || '.';
  div.appendChild(marker);

  document.body.appendChild(div);

  const borderTop = parseFloat(computed.borderTopWidth) || 0;
  const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
  const lineHeight = parseFloat(computed.lineHeight) || marker.offsetHeight || 20;

  const coordinates: CaretCoordinates = {
    top: marker.offsetTop + borderTop,
    left: marker.offsetLeft + borderLeft,
    height: lineHeight,
  };

  document.body.removeChild(div);
  return coordinates;
}

// Calculates absolute positioning for the mention menu inside its relative container,
// anchored directly below the "@" character or flipped above when space below is tight.
export function calculateMentionPosition(
  textarea: HTMLTextAreaElement,
  container: HTMLElement,
  charIndex: number,
): TextareaMentionPosition {
  const coords = getCaretCoordinates(textarea, charIndex);
  const textareaRect = textarea.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  const leftInContainer =
    textareaRect.left - containerRect.left + coords.left - textarea.scrollLeft;
  const topInContainer = textareaRect.top - containerRect.top + coords.top - textarea.scrollTop;

  const menuWidth = 256;
  const menuHeight = 220;
  const maxLeft =
    containerRect.width > 0 ? Math.max(0, containerRect.width - menuWidth) : leftInContainer;
  const left = Math.min(Math.max(0, leftInContainer), maxLeft);

  const caretBottomInViewport = textareaRect.top + coords.top - textarea.scrollTop + coords.height;
  const spaceBelow = window.innerHeight - caretBottomInViewport;

  if (spaceBelow < menuHeight && textareaRect.top + coords.top - textarea.scrollTop > menuHeight) {
    const bottom =
      containerRect.height > 0 ? Math.max(0, containerRect.height - topInContainer + 4) : 0;
    return { bottom, left };
  }

  const top = topInContainer + coords.height + 4;
  return { top, left };
}

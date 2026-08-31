/**
 * 리치 텍스트 편집기의 되돌리기 기록.
 *
 * contenteditable 의 기본 undo 는 우리가 DOM 을 직접 건드리면(라인 잘라내기, 표 넣기 등)
 * 어긋나 버린다. 그래서 기록을 직접 들고 간다 — Ctrl+X 로 지운 줄도 Ctrl+Z 로 되살아난다.
 */

export interface EditSnapshot {
  html: string;
  /** 편집 영역 처음부터 캐럿까지의 글자 수. */
  caret: number;
}

const LIMIT = 200;

export class EditHistory {
  private past: EditSnapshot[] = [];
  private future: EditSnapshot[] = [];

  /** 바뀌기 **직전** 상태를 쌓는다. 앞선 기록과 같으면 무시한다. */
  push(snapshot: EditSnapshot) {
    const top = this.past[this.past.length - 1];
    if (top && top.html === snapshot.html) return;
    this.past.push(snapshot);
    if (this.past.length > LIMIT) this.past.shift();
    // 새 편집이 생기면 앞으로 되돌릴 것은 사라진다.
    this.future = [];
  }

  /** 되돌린다. 돌려줄 것이 없으면 `null`. */
  undo(current: EditSnapshot): EditSnapshot | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(current);
    return previous;
  }

  /** 되돌린 것을 다시 적용한다. */
  redo(current: EditSnapshot): EditSnapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }

  /** 다른 파일을 열었을 때처럼 기록을 통째로 버린다. */
  reset() {
    this.past = [];
    this.future = [];
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }
}

/** 편집 영역 처음부터 캐럿까지의 글자 수. 줄 경계는 글자로 세지 않는다. */
export function caretOffset(root: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return 0;

  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

/** `caretOffset` 이 센 위치로 캐럿을 되돌린다. 범위를 넘으면 맨 끝에 둔다. */
export function setCaretOffset(root: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let target: Text | null = null;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (remaining <= node.data.length) {
      target = node;
      break;
    }
    remaining -= node.data.length;
  }

  const range = document.createRange();
  if (target) {
    range.setStart(target, Math.min(Math.max(remaining, 0), target.data.length));
  } else {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);

  selection.removeAllRanges();
  selection.addRange(range);
}

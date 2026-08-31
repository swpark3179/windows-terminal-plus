import { describe, expect, it } from 'vitest';
import { EditHistory, caretOffset, setCaretOffset } from './editorHistory';

const snap = (html: string, caret = 0) => ({ html, caret });

describe('EditHistory', () => {
  it('되돌리면 직전 상태가 나온다', () => {
    const h = new EditHistory();
    h.push(snap('a'));
    expect(h.undo(snap('b'))).toEqual(snap('a'));
  });

  it('되돌린 것은 다시 실행할 수 있다', () => {
    const h = new EditHistory();
    h.push(snap('a'));

    const back = h.undo(snap('b'))!;
    expect(back.html).toBe('a');
    expect(h.redo(back)).toEqual(snap('b'));
  });

  it('여러 단계를 순서대로 되돌린다', () => {
    const h = new EditHistory();
    h.push(snap('1'));
    h.push(snap('2'));

    expect(h.undo(snap('3'))?.html).toBe('2');
    expect(h.undo(snap('2'))?.html).toBe('1');
    expect(h.undo(snap('1'))).toBeNull();
  });

  it('돌려줄 것이 없으면 null 을 준다', () => {
    const h = new EditHistory();
    expect(h.undo(snap('a'))).toBeNull();
    expect(h.redo(snap('a'))).toBeNull();
    expect(h.canUndo).toBe(false);
  });

  it('같은 내용은 연달아 쌓지 않는다', () => {
    const h = new EditHistory();
    h.push(snap('a'));
    h.push(snap('a'));

    expect(h.undo(snap('b'))?.html).toBe('a');
    expect(h.undo(snap('a'))).toBeNull();
  });

  it('되돌린 뒤 새로 편집하면 다시 실행할 것은 사라진다', () => {
    const h = new EditHistory();
    h.push(snap('1'));
    h.undo(snap('2'));
    expect(h.canRedo).toBe(true);

    h.push(snap('새 편집'));
    expect(h.canRedo).toBe(false);
  });

  it('reset 은 기록을 통째로 버린다', () => {
    const h = new EditHistory();
    h.push(snap('a'));
    h.reset();
    expect(h.canUndo).toBe(false);
  });
});

describe('캐럿 위치', () => {
  function editor(html: string) {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  it('줄 경계는 글자로 세지 않는다', () => {
    const el = editor('<div>abc</div><div>de</div>');
    const second = el.children[1].firstChild as Text;

    const range = document.createRange();
    range.setStart(second, 1);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(caretOffset(el)).toBe(4); // abc + d
    el.remove();
  });

  it('센 위치로 캐럿을 되돌린다', () => {
    const el = editor('<div>abc</div><div>de</div>');
    setCaretOffset(el, 4);
    expect(caretOffset(el)).toBe(4);
    el.remove();
  });

  it('범위를 넘으면 맨 끝에 둔다', () => {
    const el = editor('<div>ab</div>');
    setCaretOffset(el, 999);
    expect(caretOffset(el)).toBeLessThanOrEqual(2);
    el.remove();
  });
});

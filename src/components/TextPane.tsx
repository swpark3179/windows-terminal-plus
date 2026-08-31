import { useEffect, useRef } from 'react';
import { setPaneContent } from '../ipc/bridge';
import { EditHistory, caretOffset, setCaretOffset, type EditSnapshot } from '../lib/editorHistory';
import { useStore } from '../state/store';
import type { Pane } from '../state/types';

const BORDER = '1px solid #dcd8cc';
const SWATCHES = ['#1f1e1d', '#c96442', '#3f7a37', '#a37a1e', '#3f5fa8'];

/** 연속으로 친 글자는 한 번에 되돌린다. */
const TYPING_BURST_MS = 500;

const TABLE_HTML =
  '<table style="border-collapse:collapse;width:100%;margin:.6em 0"><tbody>' +
  [0, 1]
    .map(
      () =>
        '<tr>' +
        [0, 1, 2].map(() => `<td style="border:${BORDER};padding:6px 9px">&nbsp;</td>`).join('') +
        '</tr>',
    )
    .join('') +
  '</tbody></table><div><br></div>';

function exec(command: string, value?: string) {
  try {
    document.execCommand(command, false, value);
  } catch {
    // 오래된 API 라 실패할 수 있다 — 조용히 넘어간다.
  }
}

/**
 * 서식 있는 텍스트 에디터. 디자인의 툴바(크기·B/I/U·색·정렬·표·링크)를 그대로 옮겼다.
 * 저장할 때는 Rust 가 평문으로 되돌려 쓰므로 소스 파일에 마크업이 새지 않는다.
 *
 * 되돌리기는 직접 관리한다 — 라인 잘라내기처럼 DOM 을 직접 건드리는 조작까지
 * Ctrl+Z 로 되살리려면 브라우저 기본 undo 로는 부족하다.
 */
export function TextPane({ pane, sessionId }: { pane: Pane; sessionId: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const writtenRef = useRef<string | null>(null);
  const historyRef = useRef(new EditHistory());
  /** 마지막으로 확정된 상태 — 입력 버스트가 시작될 때 기록으로 밀어 넣는다. */
  const lastRef = useRef<EditSnapshot>({ html: '', caret: 0 });
  const burstRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePane = useStore((s) => s.savePane);

  // 밖에서 내용이 바뀐 경우에만 DOM 을 갈아 끼운다 (타이핑 중 커서가 튀지 않도록).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const next = pane.content ?? '';
    if (writtenRef.current === next) return;
    writtenRef.current = next;
    el.innerHTML = next;
    lastRef.current = { html: next, caret: 0 };
  }, [pane.content]);

  // 다른 파일을 열면 기록도 새로 시작한다.
  useEffect(() => {
    historyRef.current.reset();
  }, [pane.id]);

  const snapshot = (): EditSnapshot => {
    const el = bodyRef.current;
    if (!el) return { html: '', caret: 0 };
    return { html: el.innerHTML, caret: caretOffset(el) };
  };

  /** 현재 DOM 을 Rust 로 보낸다. */
  const commit = () => {
    const el = bodyRef.current;
    if (!el) return;
    const html = el.innerHTML;
    writtenRef.current = html;
    lastRef.current = { html, caret: caretOffset(el) };
    void setPaneContent(sessionId, pane.id, html).catch(() => {});
  };

  /** 툴바·라인 잘라내기처럼 우리가 직접 일으키는 변경 앞에서 부른다. */
  const recordBefore = () => {
    historyRef.current.push(snapshot());
    if (burstRef.current) {
      clearTimeout(burstRef.current);
      burstRef.current = null;
    }
  };

  const runCommand = (command: string, value?: string) => {
    recordBefore();
    exec(command, value);
    commit();
  };

  const onInput = () => {
    // 입력 버스트가 시작될 때 한 번만, 그 직전 상태를 기록한다.
    if (!burstRef.current) historyRef.current.push(lastRef.current);
    else clearTimeout(burstRef.current);
    burstRef.current = setTimeout(() => {
      burstRef.current = null;
    }, TYPING_BURST_MS);
    commit();
  };

  const apply = (next: EditSnapshot) => {
    const el = bodyRef.current;
    if (!el) return;
    el.innerHTML = next.html;
    setCaretOffset(el, next.caret);
    writtenRef.current = next.html;
    lastRef.current = next;
    if (burstRef.current) {
      clearTimeout(burstRef.current);
      burstRef.current = null;
    }
    void setPaneContent(sessionId, pane.id, next.html).catch(() => {});
  };

  const undo = () => {
    const previous = historyRef.current.undo(snapshot());
    if (previous) apply(previous);
  };

  const redo = () => {
    const next = historyRef.current.redo(snapshot());
    if (next) apply(next);
  };

  /** Ctrl+X 로 커서가 있는 줄을 통째로 잘라낸다 (디자인의 `cutLine`). */
  const cutLine = () => {
    const el = bodyRef.current;
    const selection = window.getSelection();
    if (!el || !selection || !selection.anchorNode) return;

    let node: Node | null = selection.anchorNode;
    while (node && node.parentNode !== el) node = node.parentNode;
    if (!node) return;

    // 잘라내기 직전 상태를 남겨야 Ctrl+Z 로 그 줄이 되살아난다.
    recordBefore();

    void navigator.clipboard?.writeText(node.textContent ?? '').catch(() => {});
    const next = node.nextSibling;
    (node as ChildNode).remove();
    if (next && next.nodeType === Node.ELEMENT_NODE) {
      const range = document.createRange();
      range.setStart(next, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    commit();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey) return;
    const key = e.key.toLowerCase();

    if (key === 'x' && window.getSelection()?.isCollapsed) {
      e.preventDefault();
      cutLine();
    } else if (key === 'z' && !e.shiftKey) {
      // 기본 undo 가 겹쳐 돌지 않도록 막고 우리 기록만 쓴다.
      e.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      redo();
    } else if (key === 's') {
      e.preventDefault();
      void savePane(pane.id);
    }
  };

  return (
    <div className="text-pane">
      <div className="text-toolbar">
        <select
          defaultValue="3"
          onChange={(e) => runCommand('fontSize', e.target.value)}
          title="글자 크기"
        >
          <option value="2">작게</option>
          <option value="3">보통</option>
          <option value="5">크게</option>
          <option value="6">아주 크게</option>
        </select>

        <button
          className="tool-btn tool-btn--bold"
          title="굵게"
          onClick={() => runCommand('bold')}
        >
          B
        </button>
        <button
          className="tool-btn tool-btn--italic"
          title="기울임"
          onClick={() => runCommand('italic')}
        >
          I
        </button>
        <button
          className="tool-btn tool-btn--underline"
          title="밑줄"
          onClick={() => runCommand('underline')}
        >
          U
        </button>

        <div className="tool-sep" />
        {SWATCHES.map((c) => (
          <button
            key={c}
            className="swatch"
            title="글자 색"
            style={{ background: c }}
            onClick={() => runCommand('foreColor', c)}
          />
        ))}

        <div className="tool-sep" />
        <button className="tool-btn" title="왼쪽 정렬" onClick={() => runCommand('justifyLeft')}>
          ⇤
        </button>
        <button className="tool-btn" title="가운데 정렬" onClick={() => runCommand('justifyCenter')}>
          ≡
        </button>
        <button className="tool-btn" title="오른쪽 정렬" onClick={() => runCommand('justifyRight')}>
          ⇥
        </button>

        <div className="tool-sep" />
        <button className="tool-btn" onClick={() => runCommand('insertHTML', TABLE_HTML)}>
          ⊞ 표
        </button>
        <button
          className="tool-btn"
          onClick={() => {
            const url = window.prompt('링크 URL', 'https://');
            if (url) runCommand('createLink', url);
          }}
        >
          ⛓ 링크
        </button>

        <div className="tool-sep" />
        <button className="tool-btn" title="되돌리기 · Ctrl+Z" onClick={undo}>
          ↶
        </button>
        <button className="tool-btn" title="다시 실행 · Ctrl+Y" onClick={redo}>
          ↷
        </button>

        <div className="spacer" />
        <div className="text-toolbar__hint">Ctrl+X 라인 잘라내기 · Ctrl+Z 되돌리기 · Ctrl+S 저장</div>
      </div>

      <div
        className="text-body"
        ref={bodyRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        style={{ fontSize: pane.zoom }}
        onInput={onInput}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

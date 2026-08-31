import { useEffect, useRef } from 'react';
import { setPaneContent } from '../ipc/bridge';
import { mdToHtml } from '../lib/markdown';
import { highlightCode, renderMermaid, wireCopyButtons } from '../lib/mdEnhance';
import { useStore } from '../state/store';
import type { Pane } from '../state/types';

/** 마크다운 패널. 뷰어는 렌더된 HTML, 에디터는 원문 그대로. */
export function MarkdownPane({ pane, sessionId }: { pane: Pane; sessionId: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const writtenRef = useRef<string | null>(null);
  const savePane = useStore((s) => s.savePane);
  const flash = useStore((s) => s.flash);

  const editing = pane.mode === 'edit';
  const content = pane.content ?? '';

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const key = `${editing ? 'e' : 'v'}:${content}`;
    if (writtenRef.current === key) return;
    writtenRef.current = key;

    if (editing) {
      el.textContent = content;
      return;
    }

    el.innerHTML = mdToHtml(content);
    // 무거운 라이브러리는 필요한 블록이 있을 때만 딸려 온다.
    void highlightCode(el).catch(() => {});
    void renderMermaid(el).catch(() => {});
  }, [content, editing]);

  // 코드 블록 복사 버튼 (이벤트 위임).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || editing) return;
    return wireCopyButtons(el, flash);
  }, [editing, flash]);

  const push = () => {
    const el = bodyRef.current;
    if (!el) return;
    const text = el.textContent ?? '';
    writtenRef.current = `e:${text}`;
    void setPaneContent(sessionId, pane.id, text).catch(() => {});
  };

  if (!editing) {
    return <div className="md-view" ref={bodyRef} style={{ fontSize: pane.zoom }} />;
  }

  return (
    <div
      className="md-edit"
      ref={bodyRef}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      style={{ fontSize: pane.zoom }}
      onInput={push}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void savePane(pane.id);
        }
      }}
    />
  );
}

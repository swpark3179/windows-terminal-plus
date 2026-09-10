import { useCallback, useEffect, useRef, useState } from 'react';
import { openExternalUrl, setPaneContent } from '../ipc/bridge';
import { terminalFocused } from '../lib/keys';
import { mdToHtml } from '../lib/markdown';
import { highlightCode, renderMermaid, wireCopyButtons } from '../lib/mdEnhance';
import { resolveDocPath } from '../lib/mdLinks';
import { activeHeading, readOutline, type Heading } from '../lib/mdOutline';
import { clearHits, focusHit, markHits, stepHit } from '../lib/mdSearch';
import { MD_FONTS, docStats, fontStack } from '../lib/mdView';
import { useStore } from '../state/store';
import type { MdFont, Pane } from '../state/types';

/**
 * 창별로 읽던 자리. 앱이 사는 동안만 들고 있는다 — 스냅샷에 넣을 만한 값이 아니고,
 * 세션을 오가거나 뷰어/에디터를 오갈 때 맨 위로 튕기지 않는 것이 목적이다.
 */
const scrollMemory = new Map<string, number>();

/**
 * 얼마나 읽었는가 (0~1). **1% 단위로 끊는다** — 2px 막대에서 그보다 잘게 움직여 봐야 보이지
 * 않는데, 값이 달라질 때마다 목차까지 딸린 창이 통째로 다시 그려진다.
 */
function readProgress(box: HTMLElement): number {
  const max = box.scrollHeight - box.clientHeight;
  if (max <= 0) return 1;
  return Math.round(Math.min(1, box.scrollTop / max) * 100) / 100;
}

/**
 * 마크다운 패널.
 *
 * 에디터는 원문 그대로, 뷰어는 렌더된 HTML 위에 읽기 도구를 얹는다 —
 * 목차 · 문서 안에서 찾기 · 밝은/어두운 테마 · 본문 글꼴과 폭 · 읽은 만큼의 진행 막대.
 * (참고 저장소 `swpark3179/markdown-viewer` 가 앱 전체로 하던 일을 창 하나 안에 담았다.)
 */
export function MarkdownPane({ pane, sessionId }: { pane: Pane; sessionId: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const writtenRef = useRef<string | null>(null);
  /** 제목들의 문서 안 세로 위치. 스크롤할 때마다 다시 재지 않으려고 붙잡아 둔다. */
  const offsetsRef = useRef<number[]>([]);
  const hitsRef = useRef<HTMLElement[]>([]);

  const savePane = useStore((s) => s.savePane);
  const flash = useStore((s) => s.flash);
  const prefs = useStore((s) => s.mdPrefs);
  const setMdPrefs = useStore((s) => s.setMdPrefs);
  const openFileInFreePane = useStore((s) => s.openFileInFreePane);

  const editing = pane.mode === 'edit';
  const content = pane.content ?? '';

  const [outline, setOutline] = useState<Heading[]>([]);
  const [reading, setReading] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(0);
  const [hitAt, setHitAt] = useState(-1);
  /** 본문을 새로 그릴 때마다 올라간다 — 목차·찾기·자리 되돌리기가 이것을 기다린다. */
  const [drawn, setDrawn] = useState(0);

  // ── 본문 그리기 ─────────────────────────────────
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // 테마가 키에 들어 있는 이유: mermaid 는 초기화 때 색이 정해져 다시 그려야 바뀐다.
    const key = `${editing ? 'e' : `v.${prefs.theme}`}:${content}`;
    if (writtenRef.current === key) return;
    writtenRef.current = key;

    if (editing) {
      el.textContent = content;
      return;
    }

    el.innerHTML = mdToHtml(content);
    setOutline(readOutline(el));
    setDrawn((n) => n + 1);
    // 무거운 라이브러리는 필요한 블록이 있을 때만 딸려 온다.
    void highlightCode(el).catch(() => {});
    void renderMermaid(el, prefs.theme).catch(() => {});
  }, [content, editing, prefs.theme]);

  // 코드 블록 복사 버튼 (이벤트 위임).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || editing) return;
    return wireCopyButtons(el, flash);
  }, [editing, flash]);

  /** 제목 위치를 다시 잰다. 그림·다이어그램이 늦게 들어와 높이가 바뀌면 다시 불린다. */
  const measure = useCallback(() => {
    const box = scrollRef.current;
    const el = bodyRef.current;
    if (!box || !el) return;
    const top = box.getBoundingClientRect().top;
    offsetsRef.current = Array.from(el.querySelectorAll<HTMLElement>('[data-md-heading]')).map(
      (h) => h.getBoundingClientRect().top - top + box.scrollTop,
    );
    setProgress(readProgress(box));
    setReading(activeHeading(offsetsRef.current, box.scrollTop));
  }, []);

  // 그린 뒤 읽던 자리로 되돌리고, 그 자리 기준으로 제목 위치를 잰다.
  useEffect(() => {
    if (editing) return;
    const box = scrollRef.current;
    if (!box) return;
    const frame = requestAnimationFrame(() => {
      box.scrollTop = scrollMemory.get(pane.id) ?? 0;
      measure();
    });
    return () => cancelAnimationFrame(frame);
  }, [drawn, editing, pane.id, measure]);

  // 다이어그램·그림이 뒤늦게 자리를 차지하면 제목 위치가 밀린다.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || editing) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [editing, measure]);

  // ── 문서 안에서 찾기 ────────────────────────────
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || editing) return;
    clearHits(el);
    const found = query.trim() ? markHits(el, query) : [];
    hitsRef.current = found;
    setHits(found.length);
    const first = found.length > 0 ? 0 : -1;
    setHitAt(first);
    if (first >= 0) focusHit(found, first);
    return () => clearHits(el);
  }, [query, editing, drawn]);

  const stepFind = useCallback((delta: 1 | -1) => {
    const found = hitsRef.current;
    const next = stepHit(found.length, hitAt, delta);
    setHitAt(next);
    if (next >= 0) focusHit(found, next);
  }, [hitAt]);

  const closeFind = useCallback(() => {
    setFinding(false);
    setQuery('');
  }, []);

  // Ctrl+F 는 이 창이 골라져 있을 때만 가져간다. 터미널이 쥐고 있으면 셸의 것이다.
  useEffect(() => {
    if (editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key.toLowerCase() !== 'f' || e.shiftKey) return;
      if (terminalFocused() || useStore.getState().sel !== pane.id) return;
      e.preventDefault();
      setFinding(true);
      requestAnimationFrame(() => findRef.current?.select());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, pane.id]);

  // ── 스크롤 · 이동 ───────────────────────────────
  const onScroll = () => {
    const box = scrollRef.current;
    if (!box) return;
    scrollMemory.set(pane.id, box.scrollTop);
    setProgress(readProgress(box));
    setReading(activeHeading(offsetsRef.current, box.scrollTop));
  };

  const scrollTo = (target: HTMLElement | null) => {
    const box = scrollRef.current;
    if (!box || !target) return;
    const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, top - 8);
  };

  const jumpTo = (index: number) =>
    scrollTo(bodyRef.current?.querySelector<HTMLElement>(`[data-md-heading="${index}"]`) ?? null);

  /** 본문 링크 — 바깥 주소는 브라우저로, `#` 은 이 문서 안으로, 옆 파일은 빈 블럭으로. */
  const onDocClick = (e: React.MouseEvent) => {
    const el = bodyRef.current;
    if (!(e.target instanceof Element)) return;
    const link = e.target.closest<HTMLAnchorElement>('a[data-md-link]');
    if (!link || !el) return;
    e.preventDefault();

    const href = link.getAttribute('href') ?? '';
    const kind = link.dataset.mdLink;

    if (kind === 'ext') {
      void openExternalUrl(href).catch(() => flash('주소를 열 수 없습니다'));
      return;
    }
    if (kind === 'anchor') {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // 인코딩이 깨진 앵커는 적힌 그대로 찾는다.
      }
      const found = Array.from(el.querySelectorAll<HTMLElement>('[data-md-heading]')).find(
        (h) => h.id === id,
      );
      if (found) scrollTo(found);
      else flash(`문서에 '${id}' 제목이 없습니다`);
      return;
    }

    const resolved = resolveDocPath(pane.path, href);
    if (!resolved) {
      flash('이 문서의 위치를 몰라 상대 경로를 풀 수 없습니다');
      return;
    }
    openFileInFreePane(resolved);
  };

  const push = () => {
    const el = bodyRef.current;
    if (!el) return;
    const text = el.textContent ?? '';
    writtenRef.current = `e:${text}`;
    void setPaneContent(sessionId, pane.id, text).catch(() => {});
  };

  if (editing) {
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

  return (
    <div className={`md-pane${prefs.theme === 'dark' ? ' md-pane--dark' : ''}`}>
      <div className="md-bar">
        <button
          className={`md-bar__btn${prefs.toc ? ' is-on' : ''}`}
          title="목차"
          disabled={outline.length === 0}
          onClick={() => setMdPrefs({ toc: !prefs.toc })}
        >
          ☰ 목차
        </button>
        <button
          className={`md-bar__btn${finding ? ' is-on' : ''}`}
          title="문서 안에서 찾기 · Ctrl+F"
          onClick={() => {
            if (finding) closeFind();
            else {
              setFinding(true);
              requestAnimationFrame(() => findRef.current?.focus());
            }
          }}
        >
          ⌕ 찾기
        </button>

        <div className="md-bar__sep" />

        <select
          className="md-bar__font"
          title="본문 글꼴"
          value={prefs.font}
          onChange={(e) => setMdPrefs({ font: e.target.value as MdFont })}
        >
          {MD_FONTS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <button
          className={`md-bar__btn${prefs.narrow ? ' is-on' : ''}`}
          title={prefs.narrow ? '창 너비 가득 채우기' : '읽기 좋은 폭으로 좁히기'}
          onClick={() => setMdPrefs({ narrow: !prefs.narrow })}
        >
          {prefs.narrow ? '⇤⇥' : '⇥⇤'}
        </button>
        <button
          className="md-bar__btn"
          title={prefs.theme === 'dark' ? '밝은 배경으로' : '어두운 배경으로'}
          onClick={() => setMdPrefs({ theme: prefs.theme === 'dark' ? 'light' : 'dark' })}
        >
          {prefs.theme === 'dark' ? '☀' : '☾'}
        </button>

        <div className="md-bar__stats" title="문서 크기">
          {docStats(content)}
        </div>
      </div>

      {finding && (
        <div className="md-find">
          <input
            ref={findRef}
            className="md-find__input"
            value={query}
            spellCheck={false}
            placeholder="문서 안에서 찾기"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepFind(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFind();
              }
            }}
          />
          <div className="md-find__count">
            {query.trim() ? (hits > 0 ? `${hitAt + 1} / ${hits}` : '없음') : ''}
          </div>
          <button className="md-find__btn" title="이전 · Shift+Enter" disabled={hits === 0} onClick={() => stepFind(-1)}>
            ↑
          </button>
          <button className="md-find__btn" title="다음 · Enter" disabled={hits === 0} onClick={() => stepFind(1)}>
            ↓
          </button>
          <button className="md-find__btn" title="닫기 · Esc" onClick={closeFind}>
            ✕
          </button>
        </div>
      )}

      <div className="md-main">
        {prefs.toc && outline.length > 0 && (
          <nav className="md-toc">
            <div className="md-toc__head">목차 · {outline.length}</div>
            <div className="md-toc__list">
              {outline.map((h, i) => (
                <button
                  key={h.index}
                  className={`md-toc__item${i === reading ? ' is-on' : ''}`}
                  style={{ paddingLeft: 8 + (h.level - 1) * 11 }}
                  title={h.text}
                  onClick={() => jumpTo(h.index)}
                >
                  {h.text || '제목 없음'}
                </button>
              ))}
            </div>
          </nav>
        )}

        <div className="md-view" ref={scrollRef} onScroll={onScroll}>
          <div
            className={`md-doc${prefs.narrow ? ' md-doc--narrow' : ''}`}
            ref={bodyRef}
            onClick={onDocClick}
            style={{ fontSize: pane.zoom, fontFamily: fontStack(prefs.font) }}
          />
        </div>
      </div>

      <div className="md-progress" title={`${Math.round(progress * 100)}% 읽음`}>
        <div className="md-progress__fill" style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

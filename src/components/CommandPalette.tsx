import { useEffect, useMemo, useRef } from 'react';
import { activeSession, useStore } from '../state/store';

interface Action {
  icon: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

/** Ctrl+Shift+P — 디자인의 액션 목록 + 세션 이동. */
export function CommandPalette() {
  const open = useStore((s) => s.palette);
  const query = useStore((s) => s.paletteQuery);
  const sel = useStore((s) => s.paletteSel);
  const snapshot = useStore((s) => s.snapshot);
  const store = useStore();
  const inputRef = useRef<HTMLInputElement>(null);

  const session = activeSession(snapshot);

  const actions = useMemo<Action[]>(() => {
    if (!session || !snapshot) return [];
    const firstEmpty = session.panes.find((p) => p.kind === 'empty');
    const noRoom = () => store.flash('빈 블럭이 없습니다 — 창을 분할하세요');

    const base: Action[] = [
      { icon: '⬍', label: '선택한 창 위·아래 분할', run: () => void store.splitSelected('topBottom') },
      { icon: '⬌', label: '선택한 창 좌·우 분할', run: () => void store.splitSelected('leftRight') },
      { icon: '⧉', label: '줄 병합 시작 (드래그)', run: () => store.startMerge() },
      { icon: '⇄', label: '위치 교환 시작', run: () => store.startSwap() },
      { icon: '⊟', label: '창 크기 균등하게', run: () => void store.resetTrackWeights() },
      {
        icon: session.fullPaneId ? '⤡' : '⤢',
        label: session.fullPaneId ? '창 모드로 돌아가기' : '고른 창 전체화면',
        shortcut: 'Ctrl+Shift+F',
        run: () => void store.toggleFull(),
      },
      {
        icon: '▮',
        label: '빈 블럭에 터미널 열기',
        run: () => (firstEmpty ? void store.openTerminal(firstEmpty.id) : noRoom()),
      },
      {
        icon: '◫',
        label: '빈 블럭에 파일 열기…',
        run: () => (firstEmpty ? store.openPicker(firstEmpty.id) : noRoom()),
      },
      { icon: '⚙', label: '세션 설정', shortcut: 'Ctrl+,', run: () => store.openSettings() },
      { icon: '⊞', label: '레이아웃 편집 모드', shortcut: 'Ctrl+E', run: () => store.toggleEdit() },
      { icon: '◧', label: '사이드바 접기 / 펼치기', shortcut: 'Ctrl+B', run: () => store.toggleSidebar() },
      { icon: '＋', label: '새 세션', run: () => void store.newSession() },
      { icon: '↺', label: '스냅샷 초기화 후 다시 시작', run: () => void store.resetSnapshot() },
    ];

    return base.concat(
      snapshot.sessions.map((s) => ({
        icon: '●',
        label: `세션 이동 · ${s.name}`,
        shortcut: s.id,
        run: () => void store.activateSession(s.id),
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, snapshot]);

  const q = query.trim().toLowerCase();
  const filtered = actions.filter((a) => !q || a.label.toLowerCase().includes(q));

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      store.setPaletteSel(Math.min(filtered.length - 1, sel + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      store.setPaletteSel(Math.max(0, sel - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const action = filtered[sel];
      store.closePalette();
      action?.run();
    } else if (e.key === 'Escape') {
      store.closePalette();
    }
  };

  return (
    <div className="scrim scrim--top" onMouseDown={() => store.closePalette()}>
      <div className="card palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          onChange={(e) => store.setPaletteQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="명령 실행 · 세션 이동"
          spellCheck={false}
        />
        <div className="palette__list">
          {filtered.map((a, i) => (
            <button
              key={a.label}
              className={`palette__item${i === sel ? ' palette__item--sel' : ''}`}
              onMouseEnter={() => store.setPaletteSel(i)}
              onClick={() => {
                store.closePalette();
                a.run();
              }}
            >
              <span className="palette__icon">{a.icon}</span>
              <span className="palette__label">{a.label}</span>
              <span className="palette__shortcut">{a.shortcut ?? ''}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="palette__empty">일치하는 명령이 없습니다</div>}
        </div>
      </div>
    </div>
  );
}

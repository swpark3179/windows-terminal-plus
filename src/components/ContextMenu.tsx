import { useEffect, useRef } from 'react';
import { terminalClipboard } from '../lib/terminalRegistry';
import { activeSession, useStore } from '../state/store';

interface Item {
  key: string;
  icon: string;
  label: string;
  shortcut?: string;
  danger?: boolean;
  run: () => void;
}

/** 세션 행과 창에서 뜨는 우클릭 메뉴. 항목 구성은 디자인 그대로. */
export function ContextMenu() {
  const ctx = useStore((s) => s.ctx);
  const snapshot = useStore((s) => s.snapshot);
  const close = useStore((s) => s.closeContext);
  const openSettings = useStore((s) => s.openSettings);
  const toggleEdit = useStore((s) => s.toggleEdit);
  const duplicateSession = useStore((s) => s.duplicateSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const splitPane = useStore((s) => s.splitPane);
  const startMerge = useStore((s) => s.startMerge);
  const startSwap = useStore((s) => s.startSwap);
  const openTerminal = useStore((s) => s.openTerminal);
  const openPicker = useStore((s) => s.openPicker);
  const requestClosePane = useStore((s) => s.requestClosePane);
  const zoomReset = useStore((s) => s.zoomReset);
  const toggleFull = useStore((s) => s.toggleFull);
  const savePane = useStore((s) => s.savePane);
  const boxRef = useRef<HTMLDivElement>(null);

  // 메뉴 밖을 누르면 닫는다.
  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [ctx, close]);

  if (!ctx || !snapshot) return null;
  const session = activeSession(snapshot);
  if (!session) return null;

  let title = '';
  const items: Item[] = [];

  if (ctx.kind === 'session') {
    const target = snapshot.sessions.find((s) => s.id === ctx.id);
    title = target?.id ?? '';
    items.push(
      { key: 'set', icon: '⚙', label: '설정…', shortcut: 'Ctrl+,', run: openSettings },
      { key: 'lay', icon: '⊞', label: '레이아웃 편집', shortcut: 'Ctrl+E', run: toggleEdit },
      { key: 'dup', icon: '⧉', label: '세션 복제', run: () => void duplicateSession(ctx.id) },
      {
        key: 'del',
        icon: '✕',
        label: '세션 삭제',
        danger: true,
        run: () => void deleteSession(ctx.id),
      },
    );
  } else {
    const pane = session.panes.find((p) => p.id === ctx.id);
    if (!pane) return null;
    title = pane.kind === 'empty' ? '빈 블럭' : pane.title;

    items.push(
      {
        key: 'sh',
        icon: '⬍',
        label: '위·아래로 분할',
        run: () => void splitPane(ctx.id, 'topBottom'),
      },
      {
        key: 'sv',
        icon: '⬌',
        label: '좌·우로 분할',
        run: () => void splitPane(ctx.id, 'leftRight'),
      },
      {
        key: 'merge',
        icon: '⧉',
        label: '이 창부터 줄 병합 드래그',
        run: () => startMerge(ctx.id),
      },
      { key: 'swap', icon: '⇄', label: '이 창부터 위치 교환', run: () => startSwap(ctx.id) },
    );

    if (pane.kind === 'term') {
      items.push(
        {
          key: 'copy',
          icon: '⧉',
          label: '복사',
          shortcut: 'Ctrl+Shift+C',
          run: () => void terminalClipboard(ctx.id)?.copy(),
        },
        {
          key: 'paste',
          icon: '⎘',
          label: '붙여넣기',
          shortcut: 'Ctrl+Shift+V',
          run: () => terminalClipboard(ctx.id)?.paste(),
        },
      );
    }

    if (pane.kind === 'empty') {
      items.push(
        { key: 'term', icon: '▮', label: '터미널 열기', run: () => void openTerminal(ctx.id) },
        { key: 'file', icon: '◫', label: '파일 열기…', run: () => openPicker(ctx.id) },
      );
    } else {
      if (pane.path) {
        items.push({
          key: 'save',
          icon: '⤓',
          label: '저장',
          shortcut: 'Ctrl+S',
          run: () => void savePane(ctx.id),
        });
      }
      items.push(
        {
          key: 'full',
          icon: session.fullPaneId === ctx.id ? '⤡' : '⤢',
          label: session.fullPaneId === ctx.id ? '창 모드로' : '이 창만 전체화면',
          shortcut: 'Ctrl+Shift+F',
          run: () => void toggleFull(ctx.id),
        },
        {
          key: 'reset',
          icon: '⊙',
          label: '확대 100%',
          shortcut: 'Ctrl+0',
          run: () => void zoomReset(ctx.id),
        },
        {
          key: 'close',
          icon: '✕',
          label: '창 닫기 · 빈 블럭으로',
          danger: true,
          run: () => requestClosePane(ctx.id),
        },
      );
    }
  }

  return (
    <div className="menu" ref={boxRef} style={{ left: ctx.x, top: ctx.y }}>
      <div className="menu__title">{title}</div>
      {items.map((m) => (
        <button
          key={m.key}
          className={`menu__item${m.danger ? ' menu__item--danger' : ''}`}
          onClick={() => {
            close();
            m.run();
          }}
        >
          <span className="menu__icon">{m.icon}</span>
          <span className="menu__label">{m.label}</span>
          <span className="menu__shortcut">{m.shortcut ?? ''}</span>
        </button>
      ))}
    </div>
  );
}

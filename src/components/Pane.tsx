import { useStore } from '../state/store';
import { KIND_STYLE, ZOOM_BASE, type Pane, type Session } from '../state/types';
import { ImagePane } from './ImagePane';
import { MarkdownPane } from './MarkdownPane';
import { TerminalPane } from './TerminalPane';
import { TextPane } from './TextPane';

/** 빈 블럭 — 터미널이나 파일을 여는 자리. */
function EmptyBody({ pane }: { pane: Pane }) {
  const openTerminal = useStore((s) => s.openTerminal);
  const openPicker = useStore((s) => s.openPicker);

  return (
    <div className="empty-body">
      <div className="empty-body__label">
        r{pane.r} · c{pane.c} 빈 블럭
      </div>
      <div className="empty-body__actions">
        <button
          className="empty-btn"
          onClick={(e) => {
            e.stopPropagation();
            void openTerminal(pane.id);
          }}
        >
          ▮ 터미널 열기
        </button>
        <button
          className="empty-btn"
          onClick={(e) => {
            e.stopPropagation();
            openPicker(pane.id);
          }}
        >
          ◫ 파일 열기
        </button>
      </div>
      <div className="empty-body__hint">파일을 이 블럭으로 드래그해도 열립니다</div>
    </div>
  );
}

export function PaneView({ pane, session }: { pane: Pane; session: Session }) {
  const editMode = useStore((s) => s.editMode);
  const sel = useStore((s) => s.sel);
  const mergeSet = useStore((s) => s.mergeSet);
  const dragMerge = useStore((s) => s.dragMerge);
  const paneMouseDown = useStore((s) => s.paneMouseDown);
  const paneMouseEnter = useStore((s) => s.paneMouseEnter);
  const openContext = useStore((s) => s.openContext);
  const requestClosePane = useStore((s) => s.requestClosePane);
  const zoomBy = useStore((s) => s.zoomBy);
  const zoomReset = useStore((s) => s.zoomReset);
  const setMdMode = useStore((s) => s.setMdMode);

  const inMerge = !!mergeSet?.includes(pane.id);
  const marked = inMerge || (editMode && sel === pane.id);
  const dimmed = dragMerge && !!mergeSet && !inMerge;
  const isEmpty = pane.kind === 'empty';
  const dark = pane.kind === 'term';

  const onCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContext({
      kind: 'pane',
      id: pane.id,
      x: Math.min(e.clientX, window.innerWidth - 224),
      y: Math.min(e.clientY, window.innerHeight - 260),
    });
  };

  const kind = pane.kind === 'empty' ? null : KIND_STYLE[pane.kind];

  return (
    <div
      data-pane={pane.id}
      className={[
        'pane',
        isEmpty ? 'pane--empty' : '',
        marked ? 'pane--marked' : '',
        dimmed ? 'pane--dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ gridArea: `${pane.r} / ${pane.c} / span ${pane.rs} / span ${pane.cs}` }}
      onMouseDown={() => paneMouseDown(pane.id)}
      onMouseEnter={() => paneMouseEnter(pane.id)}
      onContextMenu={onCtx}
    >
      {!isEmpty && kind && (
        <div className={`pane__head${dark ? ' pane__head--dark' : ''}`} onContextMenu={onCtx}>
          <div
            className="pane__kind"
            style={{ color: kind.fg, borderColor: kind.ring, background: kind.bg }}
          >
            {kind.label}
          </div>
          <div className="pane__title" title={pane.path ?? pane.title}>
            {pane.title}
          </div>
          {pane.dirty && (
            <div className="pane__dirty" title="저장되지 않은 변경 · Ctrl+S">
              ●
            </div>
          )}
          {pane.kind === 'term' && !pane.alive && <div className="pane__dead">종료됨</div>}

          {pane.kind === 'md' && (
            <div className="md-toggle">
              <button
                className={pane.mode !== 'edit' ? 'is-on' : ''}
                onClick={(e) => {
                  e.stopPropagation();
                  void setMdMode(pane.id, 'view');
                }}
              >
                뷰어
              </button>
              <button
                className={pane.mode === 'edit' ? 'is-on' : ''}
                onClick={(e) => {
                  e.stopPropagation();
                  void setMdMode(pane.id, 'edit');
                }}
              >
                에디터
              </button>
            </div>
          )}

          {pane.kind !== 'image' && (
          <div className="zoom">
            <button
              className="zoom__btn"
              title="축소 · Ctrl+−"
              onClick={(e) => {
                e.stopPropagation();
                void zoomBy(pane.id, -1);
              }}
            >
              −
            </button>
            <button
              className="zoom__pct"
              title="100% 로 되돌리기"
              onClick={(e) => {
                e.stopPropagation();
                void zoomReset(pane.id);
              }}
            >
              {Math.round((pane.zoom / ZOOM_BASE) * 100)}%
            </button>
            <button
              className="zoom__btn"
              title="확대 · Ctrl++"
              onClick={(e) => {
                e.stopPropagation();
                void zoomBy(pane.id, 1);
              }}
            >
              ＋
            </button>
          </div>
          )}

          <button className="pane__icon" title="창 메뉴" onClick={onCtx}>
            ⋮
          </button>
          <button
            className="pane__icon pane__icon--close"
            title="닫기 · 빈 블럭으로"
            onClick={(e) => {
              e.stopPropagation();
              requestClosePane(pane.id);
            }}
          >
            ✕
          </button>
        </div>
      )}

      {isEmpty && <EmptyBody pane={pane} />}
      {pane.kind === 'term' && <TerminalPane pane={pane} sessionId={session.id} />}
      {pane.kind === 'text' && <TextPane pane={pane} sessionId={session.id} />}
      {pane.kind === 'md' && <MarkdownPane pane={pane} sessionId={session.id} />}
      {pane.kind === 'image' && <ImagePane pane={pane} sessionId={session.id} />}
    </div>
  );
}

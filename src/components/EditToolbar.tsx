import { activeSession, useStore } from '../state/store';

/** 편집 모드 툴바 — 선택한 창을 분할하거나, 병합/교환 조작을 켠다. */
export function EditToolbar() {
  const snapshot = useStore((s) => s.snapshot);
  const sel = useStore((s) => s.sel);
  const op = useStore((s) => s.op);
  const dragMerge = useStore((s) => s.dragMerge);
  const splitSelected = useStore((s) => s.splitSelected);
  const startMerge = useStore((s) => s.startMerge);
  const startSwap = useStore((s) => s.startSwap);
  const resetTrackWeights = useStore((s) => s.resetTrackWeights);
  const toggleEdit = useStore((s) => s.toggleEdit);

  const session = activeSession(snapshot);
  const pane = session?.panes.find((p) => p.id === sel) ?? null;

  const selLabel = pane
    ? pane.kind === 'empty'
      ? `빈 블럭 r${pane.r}·c${pane.c}`
      : pane.title
    : '없음 — 창 클릭';

  const hint =
    op === 'merge'
      ? dragMerge
        ? '드래그 중 · 놓으면 병합'
        : '병합할 첫 창을 누른 채 같은 줄로 드래그'
      : op === 'swap'
        ? '교환할 다른 창을 클릭'
        : '창을 클릭해 선택 → 분할 · 경계를 끌면 크기 조절';

  return (
    <div className="edit-bar">
      <div className="edit-bar__label">선택한 창</div>
      <div className="edit-bar__sel">{selLabel}</div>
      <div className="edit-bar__vline" />

      <button
        className="edit-btn"
        disabled={!pane}
        onClick={() => void splitSelected('topBottom')}
      >
        ⬍ 위·아래 분할
      </button>
      <button
        className="edit-btn"
        disabled={!pane}
        onClick={() => void splitSelected('leftRight')}
      >
        ⬌ 좌·우 분할
      </button>

      <div className="edit-bar__vline" />

      <button
        className={`edit-btn${op === 'merge' ? ' edit-btn--on' : ''}`}
        onClick={() => startMerge()}
      >
        ⧉ 줄 병합 · 드래그
      </button>
      <button
        className={`edit-btn${op === 'swap' ? ' edit-btn--on' : ''}`}
        onClick={() => startSwap()}
      >
        ⇄ 위치 교환
      </button>
      <button
        className="edit-btn"
        title="모든 창을 같은 크기로 되돌립니다"
        onClick={() => void resetTrackWeights()}
      >
        ⊟ 크기 균등
      </button>

      <div className="spacer" />
      <div className="edit-bar__hint">{hint}</div>
      <button className="edit-bar__done" onClick={toggleEdit}>
        완료
      </button>
    </div>
  );
}

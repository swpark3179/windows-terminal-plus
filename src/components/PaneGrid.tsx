import { useRef } from 'react';
import { activeSession, useStore } from '../state/store';
import type { Pane, TrackAxis } from '../state/types';
import { PaneView } from './Pane';
import { ResizeHandles } from './ResizeHandles';

/** 병합 드래그가 덮고 있는 사각형. 판정과 무관하게 화면에 보여 줄 범위만 계산한다. */
function unionRect(panes: Pane[], ids: string[]) {
  const members = ids.map((id) => panes.find((p) => p.id === id)).filter((p): p is Pane => !!p);
  if (members.length === 0) return null;
  const r = Math.min(...members.map((p) => p.r));
  const c = Math.min(...members.map((p) => p.c));
  const r2 = Math.max(...members.map((p) => p.r + p.rs));
  const c2 = Math.max(...members.map((p) => p.c + p.cs));
  return { r, c, rs: r2 - r, cs: c2 - c };
}

const tracks = (weights: number[], count: number) =>
  (weights.length === count ? weights : Array<number>(count).fill(1))
    .map((w) => `${w}fr`)
    .join(' ');

export function PaneGrid() {
  const snapshot = useStore((s) => s.snapshot);
  const editMode = useStore((s) => s.editMode);
  const mergeSet = useStore((s) => s.mergeSet);
  const mergeVerdict = useStore((s) => s.mergeVerdict);
  const dragMerge = useStore((s) => s.dragMerge);
  const dragPos = useStore((s) => s.dragPos);
  const setDragPos = useStore((s) => s.setDragPos);
  const fileDrop = useStore((s) => s.fileDrop);
  const resizeDraft = useStore((s) => s.resizeDraft);
  const gridRef = useRef<HTMLDivElement>(null);

  const session = activeSession(snapshot);
  if (!session) return null;

  const overlay =
    dragMerge && mergeSet && mergeSet.length >= 2 ? unionRect(session.panes, mergeSet) : null;
  const rejected = mergeVerdict?.status === 'rejected';
  const count = mergeSet?.length ?? 0;

  // 드래그 중 배지 문구 — 유효/무효를 놓기 전에 알려 준다.
  const badge = rejected
    ? mergeVerdict.reason === 'tooManyPrograms'
      ? '병합 불가 · 열린 창 2개'
      : '병합 불가 · 이어지지 않음'
    : `${count}개 창 병합`;

  // 경계를 끄는 동안에는 스냅샷 대신 임시 몫으로 그린다 (왕복을 기다리지 않는다).
  const draftFor = (axis: TrackAxis) =>
    resizeDraft?.axis === axis ? resizeDraft.weights : null;

  // 창 경계 조절은 레이아웃 편집 모드에서만, 병합 드래그 중에는 숨긴다.
  const showHandles = editMode && !dragMerge;

  return (
    <div
      className={`stage${dragMerge ? ' stage--dragging' : ''}${
        resizeDraft ? ' stage--resizing' : ''
      }`}
      onMouseMove={(e) => {
        if (dragMerge) setDragPos(e.clientX, e.clientY);
      }}
    >
      <div
        className="grid"
        ref={gridRef}
        style={{
          gridTemplateColumns: tracks(draftFor('col') ?? session.grid.colWeights, session.grid.cols),
          gridTemplateRows: tracks(draftFor('row') ?? session.grid.rowWeights, session.grid.rows),
        }}
      >
        {session.panes.map((pane) => (
          <PaneView key={pane.id} pane={pane} session={session} />
        ))}

        {showHandles && <ResizeHandles session={session} gridRef={gridRef} />}

        {overlay && (
          <div
            className={`merge-overlay${rejected ? ' merge-overlay--bad' : ''}`}
            style={{
              gridArea: `${overlay.r} / ${overlay.c} / span ${overlay.rs} / span ${overlay.cs}`,
            }}
          >
            <div className="merge-overlay__caption">
              {rejected ? mergeVerdict.message : `${count}개 창을 하나로`}
            </div>
          </div>
        )}
      </div>

      {dragMerge && dragPos && count >= 2 && (
        <div
          className={`merge-badge${rejected ? ' merge-badge--bad' : ''}`}
          style={{ left: dragPos.x, top: dragPos.y }}
        >
          {badge}
        </div>
      )}

      {fileDrop && (
        <div className="drop-overlay">
          <div className="drop-overlay__title">여기에 놓아 파일 열기</div>
          <div className="drop-overlay__sub">.md → 마크다운 뷰어 · 그 외 → 텍스트 에디터</div>
        </div>
      )}
    </div>
  );
}

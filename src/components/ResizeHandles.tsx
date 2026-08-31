import { useEffect, useRef, useState } from 'react';
import { setTrackWeights } from '../ipc/bridge';
import { dragWeights, horizontalSeams, verticalSeams, type Seam } from '../lib/resize';
import { useStore } from '../state/store';
import type { Session, TrackAxis } from '../state/types';

/** 칸 사이 여백 — CSS 의 `.grid { gap: 8px }` 과 같아야 계산이 맞는다. */
const GAP = 8;

interface DragState {
  axis: TrackAxis;
  line: number;
  startPx: number;
  /** 드래그를 시작할 때의 몫. 매 이동마다 여기서 다시 계산한다. */
  base: number[];
  /** 트랙들이 실제로 차지하는 픽셀 (여백 제외). */
  trackPx: number;
}

/**
 * 레이아웃 편집 모드에서 창과 창 사이에 놓이는 크기 조절 손잡이.
 *
 * 손잡이는 그리드 아이템으로 배치돼 이음매 위 여백에 정확히 얹힌다.
 * 끄는 동안에는 화면만 먼저 바꾸고(`resizeDraft`), 손을 뗄 때 한 번 Rust 로 보낸다.
 */
export function ResizeHandles({ session, gridRef }: { session: Session; gridRef: React.RefObject<HTMLDivElement | null> }) {
  const setResizeDraft = useStore((s) => s.setResizeDraft);
  const apply = useStore((s) => s.apply);
  const flash = useStore((s) => s.flash);
  const [drag, setDrag] = useState<DragState | null>(null);

  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const vertical = verticalSeams(session.panes, session.grid);
  const horizontal = horizontalSeams(session.panes, session.grid);

  // 끄는 동안은 창 위에서도 좌표를 받아야 해서 창 전체에 건다.
  useEffect(() => {
    if (!drag) return;

    const onMove = (e: MouseEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const delta = (current.axis === 'col' ? e.clientX : e.clientY) - current.startPx;
      setResizeDraft({
        axis: current.axis,
        weights: dragWeights(current.base, current.line, delta, current.trackPx),
      });
    };

    const onUp = () => {
      const current = dragRef.current;
      const draft = useStore.getState().resizeDraft;
      setDrag(null);
      setResizeDraft(null);
      if (!current || !draft) return;
      setTrackWeights(session.id, draft.axis, draft.weights)
        .then(apply)
        .catch((e: unknown) => flash(typeof e === 'string' ? e : '크기를 바꿀 수 없습니다'));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, session.id, setResizeDraft, apply, flash]);

  const begin = (axis: TrackAxis, line: number) => (e: React.MouseEvent) => {
    // 창 선택이나 병합 드래그가 같이 시작되지 않도록 여기서 끊는다.
    e.preventDefault();
    e.stopPropagation();

    const box = gridRef.current?.getBoundingClientRect();
    if (!box) return;

    const grid = session.grid;
    const tracks = axis === 'col' ? grid.cols : grid.rows;
    const total = axis === 'col' ? box.width : box.height;
    const trackPx = total - GAP * (tracks - 1);
    if (trackPx <= 0) return;

    setDrag({
      axis,
      line,
      startPx: axis === 'col' ? e.clientX : e.clientY,
      base: axis === 'col' ? [...grid.colWeights] : [...grid.rowWeights],
      trackPx,
    });
  };

  const handle = (axis: TrackAxis, seam: Seam) => {
    const active = drag?.axis === axis && drag.line === seam.line;
    const style: React.CSSProperties =
      axis === 'col'
        ? {
            gridColumn: seam.line + 1,
            gridRow: `${seam.start} / span ${seam.span}`,
          }
        : {
            gridRow: seam.line + 1,
            gridColumn: `${seam.start} / span ${seam.span}`,
          };

    return (
      <div
        key={`${axis}-${seam.line}-${seam.start}`}
        className={[
          'resize-handle',
          axis === 'col' ? 'resize-handle--col' : 'resize-handle--row',
          active ? 'resize-handle--active' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={style}
        title={axis === 'col' ? '좌우 크기 조절' : '위아래 크기 조절'}
        onMouseDown={begin(axis, seam.line)}
        onMouseEnter={(e) => e.stopPropagation()}
      >
        <span className="resize-handle__grip" />
      </div>
    );
  };

  return (
    <>
      {vertical.map((seam) => handle('col', seam))}
      {horizontal.map((seam) => handle('row', seam))}
    </>
  );
}

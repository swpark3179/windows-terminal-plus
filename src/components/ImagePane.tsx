import { useCallback, useEffect, useRef, useState } from 'react';
import { readImage, setPaneImageZoom } from '../ipc/bridge';
import { fitScale as computeFit, stepZoom, toHex, toImagePixel } from '../lib/imageView';
import { useStore } from '../state/store';
import type { Pane } from '../state/types';

interface Sample {
  hex: string;
  r: number;
  g: number;
  b: number;
  a: number;
  x: number;
  y: number;
}

/**
 * 이미지 뷰어 — 확대/축소, 끌어서 이동, 스포이드로 픽셀 색 읽기.
 *
 * 색을 읽으려면 원본 크기 캔버스가 필요해서 이미지를 한 번 캔버스에 그려 두고,
 * 화면 좌표를 원본 좌표로 되돌려 `getImageData` 로 집는다.
 */
export function ImagePane({ pane, sessionId }: { pane: Pane; sessionId: string }) {
  const flash = useStore((s) => s.flash);

  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [picking, setPicking] = useState(false);
  const [hover, setHover] = useState<Sample | null>(null);
  const [pinned, setPinned] = useState<Sample | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /** `null` 이면 창에 맞춤. */
  const zoom = pane.imageZoom ?? null;
  const scale = zoom === null ? fitScale : zoom / 100;
  const shownPercent = Math.round(scale * 100);

  // 파일에서 읽어 온다. 스냅샷에는 경로만 있으므로 창이 열릴 때마다 다시 읽는다.
  useEffect(() => {
    if (!pane.path) return;
    let alive = true;
    setSrc(null);
    setError(null);
    readImage(pane.path)
      .then((doc) => {
        if (alive) setSrc(doc.dataUrl);
      })
      .catch((e: unknown) => {
        if (alive) setError(typeof e === 'string' ? e : '이미지를 열 수 없습니다');
      });
    return () => {
      alive = false;
    };
  }, [pane.path]);

  /** 창 크기에 맞는 배율을 다시 계산한다 (원본이 작으면 확대하지 않는다). */
  const recomputeFit = useCallback(() => {
    const box = viewportRef.current;
    if (!box || !natural) return;
    setFitScale(
      computeFit(
        { width: box.clientWidth, height: box.clientHeight },
        { width: natural.w, height: natural.h },
      ),
    );
  }, [natural]);

  useEffect(() => {
    recomputeFit();
    const box = viewportRef.current;
    if (!box) return;
    const observer = new ResizeObserver(recomputeFit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [recomputeFit]);

  const applyZoom = (next: number | null) => {
    void setPaneImageZoom(sessionId, pane.id, next).catch(() => {});
    // 스냅샷 왕복을 기다리지 않고 화면부터 바꾼다.
    useStore.setState((state) => {
      if (!state.snapshot) return state;
      return {
        snapshot: {
          ...state.snapshot,
          sessions: state.snapshot.sessions.map((session) => ({
            ...session,
            panes: session.panes.map((p) => (p.id === pane.id ? { ...p, imageZoom: next } : p)),
          })),
        },
      };
    });
  };

  const zoomBy = (direction: 1 | -1) => applyZoom(stepZoom(shownPercent, direction));

  const onImageLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });

    // 색을 읽기 위한 원본 크기 사본.
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      canvasRef.current = canvas;
    } catch {
      canvasRef.current = null;
    }
  };

  /** 화면 좌표 → 원본 픽셀 색. */
  const sampleAt = (clientX: number, clientY: number): Sample | null => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return null;

    const rect = img.getBoundingClientRect();
    const point = toImagePixel(
      { x: clientX, y: clientY },
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: canvas.width, height: canvas.height },
    );
    if (!point) return null;

    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const [r, g, b, a] = ctx.getImageData(point.x, point.y, 1, 1).data;
      return { hex: toHex(r, g, b), r, g, b, a, x: point.x, y: point.y };
    } catch {
      return null;
    }
  };

  // 끌어서 이동 (스포이드 모드가 아닐 때).
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    if (picking) return;
    const box = viewportRef.current;
    if (!box) return;
    panRef.current = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (picking) {
      setHover(sampleAt(e.clientX, e.clientY));
      return;
    }
    const box = viewportRef.current;
    const start = panRef.current;
    if (!box || !start) return;
    box.scrollLeft = start.left - (e.clientX - start.x);
    box.scrollTop = start.top - (e.clientY - start.y);
  };

  const endPan = () => {
    panRef.current = null;
  };

  const onClick = (e: React.MouseEvent) => {
    if (!picking) return;
    const found = sampleAt(e.clientX, e.clientY);
    if (!found) return;
    setPinned(found);
    void navigator.clipboard?.writeText(found.hex).catch(() => {});
    flash(`${found.hex} 복사됨`);
  };

  // Ctrl+휠 확대는 이 창이 직접 처리한다 (전역 글자 크기 조절과 겹치지 않게).
  useEffect(() => {
    const box = viewportRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      zoomBy(e.deltaY < 0 ? 1 : -1);
    };
    box.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => box.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  });

  const readout = hover ?? pinned;

  return (
    <div className="image-pane">
      <div className="image-toolbar">
        <button className="tool-btn" title="축소" onClick={() => zoomBy(-1)}>
          −
        </button>
        <button
          className="tool-btn image-toolbar__pct"
          title="원본 크기 (100%)"
          onClick={() => applyZoom(100)}
        >
          {shownPercent}%
        </button>
        <button className="tool-btn" title="확대" onClick={() => zoomBy(1)}>
          ＋
        </button>
        <button
          className={`tool-btn${zoom === null ? ' tool-btn--on' : ''}`}
          title="창에 맞추기"
          onClick={() => applyZoom(null)}
        >
          ⤢ 맞춤
        </button>

        <div className="tool-sep" />

        <button
          className={`tool-btn${picking ? ' tool-btn--on' : ''}`}
          title="스포이드 · 클릭하면 색이 복사됩니다"
          onClick={() => {
            setPicking((on) => !on);
            setHover(null);
          }}
        >
          ⌖ 스포이드
        </button>

        {readout && (
          <div className="eyedrop" title="클릭하면 클립보드로 복사됩니다">
            <span
              className="eyedrop__chip"
              style={{ background: `rgb(${readout.r},${readout.g},${readout.b})` }}
            />
            <span className="eyedrop__hex">{readout.hex}</span>
            <span className="eyedrop__meta">
              rgb({readout.r}, {readout.g}, {readout.b}){readout.a < 255 ? ` · a${readout.a}` : ''}
            </span>
            <span className="eyedrop__meta">
              {readout.x}, {readout.y}
            </span>
          </div>
        )}

        <div className="spacer" />
        {natural && (
          <div className="image-toolbar__size">
            {natural.w} × {natural.h}
          </div>
        )}
      </div>

      <div
        className={`image-viewport${picking ? ' image-viewport--picking' : ''}`}
        ref={viewportRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endPan}
        onMouseLeave={() => {
          endPan();
          setHover(null);
        }}
        onClick={onClick}
      >
        {error && <div className="image-error">{error}</div>}
        {!error && !src && <div className="image-error">읽는 중…</div>}
        {src && (
          <img
            ref={imgRef}
            className="image-canvas"
            src={src}
            alt={pane.title}
            draggable={false}
            onLoad={onImageLoad}
            style={
              natural
                ? { width: natural.w * scale, height: natural.h * scale }
                : { maxWidth: '100%' }
            }
          />
        )}
      </div>
    </div>
  );
}

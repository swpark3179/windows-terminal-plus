/**
 * 터미널 스크롤 막대의 기하.
 *
 * 좌표계가 둘이다 — **버퍼 줄**(`top` = 지금 보이는 첫 줄, `0 … maxTop`)과 **트랙 픽셀**
 * (`offsetPx` = 트랙 위쪽에서 손잡이 위쪽까지). 여기서는 그 둘 사이를 옮기는 일만 한다.
 * DOM 도 xterm 도 모른다.
 *
 * 브라우저 기본 스크롤바를 그대로 못 쓰는 이유가 여기 있다. 손잡이 길이는 보이는 줄의 비율이라
 * 스크롤백 8,192줄이 다 차면 30줄짜리 창에서 0.4% 다. 게다가 `::-webkit-scrollbar` 를 선언하는
 * 순간 크로미움은 "직접 그리는" 스크롤바로 바꾸고 최소 길이를 우리에게 맡기므로, 그냥 두면
 * 손잡이가 점이 된다. 그래서 `MIN_THUMB_PX` 아래로는 줄이지 않는다.
 *
 * 대가는 정밀도다. 손잡이를 늘린 만큼 움직일 거리(`travelPx`)가 줄어, 8k 버퍼 · 300px 트랙에서는
 * 1px 이 서른 줄쯤 된다. 대신 **닿는 범위는 그대로다** — 사상이 `offsetPx ∈ [0, travelPx]` 를
 * `top ∈ [0, maxTop]` 에 통째로 맞추므로 양 끝은 언제나 정확히 버퍼의 처음과 끝이다.
 * 한 줄씩 옮기는 일은 휠과 `Shift+PageUp/PageDown` 이 맡는다.
 */

/** 손잡이가 아무리 작아져도 이 픽셀 아래로는 줄이지 않는다 — 마우스로 잡을 수 있는 길이. */
export const MIN_THUMB_PX = 36;

/** 막대를 그리는 데 필요한 값 전부. xterm 의 `buffer.active` 와 `rows` 에서 온다. */
export interface BarMetrics {
  /** 맨 아래까지 내렸을 때의 첫 줄 = `buffer.active.baseY`. 0 이면 스크롤할 것이 없다. */
  maxTop: number;
  /** 지금 보이는 첫 줄 = `buffer.active.viewportY`. */
  top: number;
  /** 화면에 보이는 줄 수 = `term.rows`. */
  rows: number;
  /** 트랙 길이(px). */
  trackPx: number;
  /** 손잡이 최소 길이(px). 없으면 `MIN_THUMB_PX`. */
  minThumbPx?: number;
}

export interface Thumb {
  /** 스크롤할 것이 있는가. false 면 손잡이를 그리지 않는다. */
  visible: boolean;
  /** 손잡이 길이(px). */
  sizePx: number;
  /** 트랙 위쪽에서 손잡이 위쪽까지(px). */
  offsetPx: number;
  /** 손잡이가 움직일 수 있는 거리 = `trackPx - sizePx`. */
  travelPx: number;
}

/** 드래그 한 걸음의 결과 — 손잡이를 놓을 자리와 그 자리가 뜻하는 줄. */
export interface DragStep {
  offsetPx: number;
  top: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 지금 그려야 할 손잡이. */
export function thumbOf(m: BarMetrics): Thumb {
  const maxTop = Math.max(0, Math.floor(m.maxTop));
  const track = Math.max(0, Math.floor(m.trackPx));
  if (maxTop === 0 || track === 0) {
    return { visible: false, sizePx: track, offsetPx: 0, travelPx: 0 };
  }
  const rows = Math.max(1, Math.floor(m.rows));
  // 트랙이 최소 길이보다도 짧으면 손잡이가 트랙을 가득 채운다 — 넘치게 두지 않는다.
  const floor = Math.min(m.minThumbPx ?? MIN_THUMB_PX, track);
  const sizePx = clamp(Math.round((track * rows) / (rows + maxTop)), floor, track);
  const travelPx = Math.max(0, track - sizePx);
  const offsetPx =
    travelPx === 0
      ? 0
      : clamp(Math.round((travelPx * clamp(Math.floor(m.top), 0, maxTop)) / maxTop), 0, travelPx);
  return { visible: true, sizePx, offsetPx, travelPx };
}

/** 손잡이 위치(px) → 그 자리에 해당하는 첫 줄. */
export function topFromOffset(offsetPx: number, m: BarMetrics): number {
  const maxTop = Math.max(0, Math.floor(m.maxTop));
  const { travelPx } = thumbOf(m);
  // 옮길 데가 없으면 끌어도 지금 자리를 지킨다 — 0 으로 튀면 화면이 맨 위로 날아간다.
  if (travelPx === 0) return clamp(Math.floor(m.top), 0, maxTop);
  return clamp(Math.round((maxTop * clamp(offsetPx, 0, travelPx)) / travelPx), 0, maxTop);
}

/**
 * 트랙 안 포인터 위치(`pointerPx`)와 손잡이 안에서 잡은 지점(`grabPx`)으로 한 걸음.
 *
 * `m.top` 을 읽지 않는다 — 그래서 claude 가 출력을 쏟아 `viewportY` 가 밑에서 흔들려도
 * 드래그가 그 영향을 받지 않는다. 손잡이 자리는 오로지 포인터가 정한다.
 */
export function dragStep(pointerPx: number, grabPx: number, m: BarMetrics): DragStep {
  const { travelPx } = thumbOf(m);
  const offsetPx = clamp(pointerPx - grabPx, 0, travelPx);
  return { offsetPx, top: topFromOffset(offsetPx, m) };
}

/** 트랙 빈 곳을 눌렀을 때 어느 쪽으로 한 화면 갈지. 손잡이 위를 눌렀으면 0. */
export function pageDirection(pointerPx: number, m: BarMetrics): -1 | 0 | 1 {
  const t = thumbOf(m);
  if (!t.visible) return 0;
  if (pointerPx < t.offsetPx) return -1;
  if (pointerPx >= t.offsetPx + t.sizePx) return 1;
  return 0;
}

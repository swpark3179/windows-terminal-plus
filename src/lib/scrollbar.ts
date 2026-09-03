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

/** 손잡이를 기준으로 트랙의 어느 쪽을 눌렀는지. 손잡이 위면 0. */
export function sideOf(pointerPx: number, t: Thumb): -1 | 0 | 1 {
  if (!t.visible) return 0;
  if (pointerPx < t.offsetPx) return -1;
  if (pointerPx >= t.offsetPx + t.sizePx) return 1;
  return 0;
}

/** 트랙 빈 곳을 눌렀을 때 어느 쪽으로 한 화면 갈지. 손잡이 위를 눌렀으면 0. */
export function pageDirection(pointerPx: number, m: BarMetrics): -1 | 0 | 1 {
  return sideOf(pointerPx, thumbOf(m));
}

/* ── 가상 뷰포트 — 대체 화면 ─────────────────────────────
 *
 * 대체 화면에는 스크롤백이 없어서 "지금 몇 번째 줄"이라는 것이 없다 — 화면을 넘기는 것은 프로그램
 * 자신이고, 그가 어디를 보고 있는지 터미널은 모른다. 그래서 **우리가 보낸 휠 칸을 세어** 자리를
 * 추정한다. 값이 둘이다.
 *
 * - `pos` — 바닥에서 위로 올라간 휠 칸 수. 0 이 바닥이다. **정수로 자르지 않는다**(아래 참고).
 * - `span` — 트랙 전체가 뜻하는 칸 수, 곧 축척. 겪은 것보다 넓게 잡고(`growSpan`) 줄지 않는다.
 *
 * 사상은 `offsetPx = travel × (1 - pos/span)` 하나뿐이다. **드래그도 이 식으로 그린다.**
 * 이득(`virtualGain`)을 제스처 동안 고정해 두면 `pos = pos0 + 끈거리 × 이득` 이라 식을 펴면
 * `offsetPx = 시작자리 - 끈거리` 가 되어 손잡이가 포인터에 정확히 붙는다. 손을 떼도 같은 식으로
 * 그리므로 **자리가 튀지 않는다** — 이것이 예전 상대 모드가 바닥으로 되돌아가던 자리다.
 * `pos` 를 정수로 자르지 않는 이유가 이 항등식이다(보낼 때만 반올림한다).
 *
 * 이득을 제스처 안에서 고정하는 또 하나의 이유는 **가역성**이다. 보내는 칸 수가 끈 거리의 순수
 * 함수라 되돌려 끌면 보낸 것도 정확히 되돌아온다. 축척이 손 안에서 자라면 이 성질이 깨진다.
 *
 * 위쪽 끝은 알 수 없다. 그래서 `span` 은 `pos` 위로 늘 여유를 남긴다 — 손잡이가 꼭대기에 닿지
 * 않는 것이 곧 "위에 더 있을 수 있다"는 뜻이고, 그 여유 구간에서는 손잡이가 포인터보다 느리게
 * 움직인다(고무줄). 맨 위를 감지하려는 시도는 하지 않는다: 판단 근거가 "휠을 보냈는데 화면이
 * 안 변한다" 뿐인데 `claude` 는 답하는 내내 스피너를 다시 그려 발화하지 않고, 반대로 오발화하면
 * 위에 내용이 남았는데 드래그가 막히는 — 지금 증상보다 더 나쁜 — 고장이 된다.
 *
 * 바닥은 다르다. `pos` 를 바닥 기준으로 세므로 바닥이 유일하게 필요한 기준점이고, 한 화면치를
 * 더 내려 보내면 **증명된다**(프로그램이 알아서 잘라 낸다). 그 일은 `TerminalScrollbar` 가 한다.
 */

/** 처음 이득 — 트랙을 다 훑으면 `travel/6` 칸. 예전 상대 모드의 손맛(6px = 한 칸)이 이것이다. */
export const REL_PX_PER_STEP = 6;

/** `pos` 가 `span` 의 이 비율을 넘으면 축척을 넓힌다 — 손잡이 위로 남겨 두는 여유. */
export const SPAN_HEAD_FRACTION = 0.75;

/**
 * 축척 상한. 이 위로는 담지 못한다 — 넘어가면 손잡이가 꼭대기에 머문다(그래도 계속 끌 수는 있다).
 *
 * 정한 근거는 **보내는 데 걸리는 시간**이다. 보고 경로에서는 한 칸이 이벤트 하나, 곧 `writePty`
 * 한 번이라 프레임당 상한을 두는데(`lib/termWheel` 의 `WHEEL_CAP_PER_FRAME`), 트랙을 끝에서
 * 끝까지 끄는 최악의 경우가 1초쯤에 끝나는 자리가 여기다. 더 넓게 잡으면 손을 뗀 뒤에도 화면이
 * 한참 더 흐른다.
 */
export const SPAN_MAX = 1024;

/** 가상 뷰포트가 보는 값. `BarMetrics` 에서 버퍼 줄에 관한 것만 뺀 것이다. */
export type VirtualMetrics = Pick<BarMetrics, 'rows' | 'trackPx' | 'minThumbPx'>;

/**
 * 대체 화면 손잡이의 길이와 움직일 거리. 길이는 **고정**이다.
 *
 * 비례로 하지 않는 이유는 축척이 추정치이기 때문이다. `span` 이 자랄 때마다 길이가 변하면
 * 끄는 중에 손잡이가 손 안에서 커졌다 작아졌다 한다.
 */
function virtualBox(m: VirtualMetrics): { sizePx: number; travelPx: number } {
  const track = Math.max(0, Math.floor(m.trackPx));
  const sizePx = Math.min(m.minThumbPx ?? MIN_THUMB_PX, track);
  return { sizePx, travelPx: Math.max(0, track - sizePx) };
}

/** 축척의 하한 — 트랙을 다 훑으면 최소 한 화면, 그리고 최소 `travel/6` 칸은 간다. */
export function spanFloor(m: VirtualMetrics): number {
  const { travelPx } = virtualBox(m);
  return Math.max(
    1,
    Math.floor(Math.max(0, m.rows)),
    Math.round(travelPx / REL_PX_PER_STEP),
  );
}

export function clampSpan(span: number, m: VirtualMetrics): number {
  const floor = spanFloor(m);
  // 축척은 정수로 둔다. 사상은 어떤 고정 축척에서도 성립하므로 반올림이 성질을 깨지 않는다.
  const want = Number.isFinite(span) ? Math.round(span) : floor;
  return clamp(want, floor, Math.max(floor, SPAN_MAX));
}

/** `pos` 를 여유 있게 담을 만큼 축척을 넓힌다. 줄지는 않는다. */
export function growSpan(span: number, pos: number, m: VirtualMetrics): number {
  return clampSpan(Math.max(span, Math.max(0, pos) / SPAN_HEAD_FRACTION), m);
}

/** 지금 그려야 할 대체 화면 손잡이. */
export function virtualThumb(pos: number, span: number, m: VirtualMetrics): Thumb {
  const { sizePx, travelPx } = virtualBox(m);
  if (sizePx === 0) return { visible: false, sizePx: 0, offsetPx: 0, travelPx: 0 };
  const s = Math.max(1, span);
  const p = clamp(Math.max(0, pos), 0, s);
  const offsetPx = travelPx === 0 ? 0 : clamp(Math.round(travelPx * (1 - p / s)), 0, travelPx);
  return { visible: true, sizePx, offsetPx, travelPx };
}

/** 끄는 거리 1px 이 뜻하는 칸 수. **제스처 시작 때 한 번 재고 그 안에서는 바꾸지 않는다.** */
export function virtualGain(span: number, m: VirtualMetrics): number {
  const { travelPx } = virtualBox(m);
  return travelPx === 0 ? 0 : Math.max(1, span) / travelPx;
}

/** 시작 자리에서 `movedPx`(위가 양수) 만큼 끌었을 때의 `pos`. 정수로 자르지 않는다. */
export function virtualTarget(pos0: number, movedPx: number, gain: number): number {
  return Math.max(0, pos0 + movedPx * gain);
}

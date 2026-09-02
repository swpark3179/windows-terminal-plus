import type { Terminal } from '@xterm/xterm';

/**
 * 대체 화면용 휠 대역.
 *
 * `vim`·`less`·`claude` 처럼 대체 화면을 쓰는 프로그램 밑에는 xterm 스크롤백이 없다. 그래서
 * `scrollLines()` 로는 아무것도 못 움직인다 — 거기서 화면을 넘기는 것은 **프로그램 자신**이다.
 * 휠은 이미 그 길을 알고 있다. xterm 이 `.xterm` 에 걸어 둔 휠 처리기가, 마우스 보고를 켠
 * 프로그램에는 SGR 보고를, 안 켠 프로그램에는 커서 키를 보낸다(`browser/Terminal.ts` 의
 * `bindMouse`: `if (!this.buffer.hasScrollback) { … ESC + (applicationCursorKeys ? 'O' : '[') +
 * (ev.deltaY < 0 ? 'A' : 'B') … }`).
 *
 * 그래서 프로토콜을 다시 짜지 않고 **그 처리기를 대신 눌러 준다.** 덕분에 막대가 할 수 있는 일은
 * 정확히 "휠을 굴린 것" 뿐이라, 어떤 프로그램 밑에서도 새로 생기는 위험이 없다.
 */

/** `WheelEvent.DOM_DELTA_LINE` — `deltaY` 가 곧 줄 수다(픽셀 누적 계산을 안 탄다). */
export const DELTA_LINE = 1;
/** `WheelEvent.DOM_DELTA_PAGE` — xterm 이 `deltaY × rows` 로 셈해 준다. */
export const DELTA_PAGE = 2;

/** `getBoundingClientRect()` 에서 실제로 쓰는 값만. 테스트 목이 일부만 채워도 견딘다. */
export interface WheelRect {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

function num(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 합성 휠 한 번의 초기값.
 *
 * `deltaY` 는 xterm 규약대로 **음수가 위**다. `shiftKey` 는 절대 켜지 않는다 — xterm 의
 * `getLinesScrolled` 가 `shiftKey` 면 0 줄로 친다. 좌표는 화면 한가운데를 가리킨다. 마우스 보고를
 * 켠 프로그램은 좌표로 칸을 찾으므로 비워 두면 보고가 화면 밖을 가리킨다.
 */
export function wheelInit(delta: number, mode: number, rect?: WheelRect): WheelEventInit {
  return {
    deltaY: delta,
    deltaMode: mode,
    clientX: num(rect?.left) + num(rect?.width) / 2,
    clientY: num(rect?.top) + num(rect?.height) / 2,
    // 거품은 올리지 않는다. xterm 의 처리기는 `.xterm` 에 직접 붙어 있어 그것만으로 충분하고,
    // 우리가 만든 이벤트가 앱의 전역 휠 처리기(Ctrl+휠 확대)까지 흘러갈 이유가 없다.
    bubbles: false,
    cancelable: true,
  };
}

/** xterm 의 휠 처리기를 대신 눌러 준다. `delta` 가 음수면 위로 간다. */
export function sendWheel(term: Terminal, delta: number, mode: number = DELTA_LINE): void {
  const el = term.element;
  if (!el || !delta) return;
  const init = wheelInit(delta, mode, el.getBoundingClientRect());
  // jsdom 처럼 WheelEvent 가 없는 환경에서는 평범한 이벤트에 값을 얹어 보낸다.
  const ev =
    typeof WheelEvent === 'function'
      ? new WheelEvent('wheel', init)
      : Object.assign(new Event('wheel', init), init);
  el.dispatchEvent(ev);
}

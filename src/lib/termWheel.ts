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

/**
 * 우리가 만든 휠. 터미널 본문에 걸어 둔 감시자가 **자기 이벤트를 다시 세지 않게** 표시해 둔다.
 * `WeakSet` 이라 이벤트가 사라지면 표시도 같이 사라진다.
 */
const synthetic = new WeakSet<Event>();

/** 이 휠이 우리가 만든 것인가. */
export function isSyntheticWheel(ev: Event): boolean {
  return synthetic.has(ev);
}

/** 지금 프로그램이 켜 둔 마우스 보고. `modes` 가 없는 목(mock)에서도 견딘다. */
export function trackingMode(term: Terminal): string {
  return (
    (term as { modes?: { mouseTrackingMode?: string } }).modes?.mouseTrackingMode ?? 'none'
  );
}

/**
 * 마우스 보고가 **휠까지** 요구하는가.
 *
 * 이 답이 갈리는 지점이 중요하다. 요구하지 않으면(화살표 경로) xterm 이 한 이벤트를 화살표
 * `n` 개로 펴 주므로 크기를 실어 한 번만 보내면 되고 `writePty` 도 한 번이다. 요구하면
 * SGR 보고에는 **크기가 실리지 않아** 한 이벤트가 딱 한 칸이라, 칸 수만큼 나눠 보내야 한다.
 * `x10` 은 휠을 요구하지 않으므로 화살표 경로다.
 */
export function wheelRequested(term: Terminal): boolean {
  const mode = trackingMode(term);
  return mode !== 'none' && mode !== 'x10';
}

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
  synthetic.add(ev);
  el.dispatchEvent(ev);
}

/** 한 프레임에 보낼 칸 수 상한. 보고 경로에서는 칸마다 `writePty` 가 한 번이다. */
export const WHEEL_CAP_PER_FRAME = 16;

/**
 * 휠 칸을 보내는 손잡이. 프레임마다 상한까지만 내보내고 나머지는 다음 프레임으로 넘긴다.
 *
 * **큐가 아니라 남은 양이다.** 되돌려 끌면 남은 것과 서로 지워지므로, 손을 멈춘 뒤에도 밀린
 * 스크롤이 재생되는 일이 없다. `term.dispose()` 뒤에 떠 있는 드레인이 없도록 `cancel()` 로
 * 수명을 명시적으로 끊는다.
 */
export interface WheelSender {
  /** 이만큼 더 보낸다 — 위가 양수다. */
  by(notches: number): void;
  cancel(): void;
}

export function createWheelSender(
  term: Terminal,
  cap: number = WHEEL_CAP_PER_FRAME,
): WheelSender {
  let pending = 0;
  let frame = 0;

  const pump = () => {
    frame = 0;
    if (!pending) return;
    if (!wheelRequested(term)) {
      // 화살표 경로 — 크기를 실어 한 번만. xterm 이 화살표 n 개로 펴 준다.
      sendWheel(term, -pending);
      pending = 0;
      return;
    }
    const dir = pending > 0 ? 1 : -1;
    const n = Math.min(Math.max(1, cap), Math.abs(pending));
    for (let i = 0; i < n; i += 1) sendWheel(term, -dir);
    pending -= dir * n;
    if (pending) frame = requestAnimationFrame(pump);
  };

  return {
    by(notches: number) {
      const n = Math.trunc(notches) || 0;
      if (!n) return;
      pending += n;
      // 새 조작이 밀린 것을 덮어쓴다 — 곧바로 내보내고 남은 것만 다음 프레임으로.
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      pump();
    },
    cancel() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = 0;
    },
  };
}

/** 한 줄의 높이(px). 픽셀 휠을 줄 수로 나눌 때 쓴다 — xterm 이 하는 계산과 같다. */
function rowHeightPx(term: Terminal): number {
  const size = Number(term.options.fontSize) || 15;
  const line = Number(term.options.lineHeight) || 1;
  return Math.max(1, size * line);
}

/**
 * 터미널 **본문**에서 온 진짜 휠을 칸 수로 (위가 양수).
 *
 * 사용자가 화면 위에서 휠을 굴리면 프로그램은 움직이는데 우리 추정치는 모른다. 그만큼을
 * 접어 넣기 위한 환산이다. 보고 경로는 한 이벤트가 정확히 한 칸이라 오차가 없고, 화살표
 * 경로는 xterm 과 같은 방법으로 근사한다 — 어긋나도 바닥 재동기가 낫게 한다.
 */
export function wheelNotches(term: Terminal, ev: WheelEvent): number {
  if (!ev.deltaY || ev.shiftKey) return 0;
  const dir = ev.deltaY < 0 ? 1 : -1;
  if (wheelRequested(term)) return dir;
  const magnitude = Math.abs(ev.deltaY);
  const lines =
    ev.deltaMode === DELTA_PAGE
      ? magnitude * Math.max(1, term.rows)
      : ev.deltaMode === DELTA_LINE
        ? magnitude
        : magnitude / rowHeightPx(term);
  return dir * Math.max(1, Math.round(lines));
}

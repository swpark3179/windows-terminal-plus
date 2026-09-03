/**
 * 테스트용 가짜 xterm.
 *
 * jsdom 에는 캔버스도 WebGL 도 없다. 클립보드 배선과 스크롤 막대를 확인하려면 선택 영역·
 * 버퍼 상태·`paste()` 를 들여다볼 수 있어야 해서 스텁을 따로 둔다 —
 * `vi.mock` 팩토리는 호이스팅되므로 파일 안에 클래스를 둘 수 없다.
 */

/** xterm 의 `IEvent` 모양(구독하면 `IDisposable` 이 나온다)만 흉내 낸 작은 발신기. */
function emitter<T>() {
  const fns = new Set<(v: T) => void>();
  return {
    on: (fn: (v: T) => void) => {
      fns.add(fn);
      return { dispose: () => void fns.delete(fn) };
    },
    fire: (v: T) => fns.forEach((fn) => fn(v)),
  };
}

export class StubTerminal {
  static last: StubTerminal | null = null;

  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  unicode = { activeVersion: '6' };
  /**
   * 마우스 보고 상태. **무조건** 있어야 한다 — 막대가 매 프레임 읽는 값이라 없으면 이 파일의
   * 다른 스위트(클립보드 등)까지 같이 죽는다. 테스트가 직접 바꿔 보고 경로를 재현한다.
   */
  modes = { mouseTrackingMode: 'none' as 'none' | 'x10' | 'vt200' | 'drag' | 'any' };
  /** 합성 휠이 향하는 곳 — 실제 xterm 도 `.xterm` 에 휠 처리기를 걸어 둔다. */
  element: HTMLDivElement = document.createElement('div');

  private _render = emitter<{ start: number; end: number }>();
  private _scroll = emitter<number>();
  private _resize = emitter<{ cols: number; rows: number }>();
  private _bufferChange = emitter<unknown>();

  buffer = {
    active: { type: 'normal' as 'normal' | 'alternate', baseY: 0, viewportY: 0 },
    onBufferChange: (fn: (v: unknown) => void) => this._bufferChange.on(fn),
  };

  /** 테스트가 세우는 선택 영역. */
  selection = '';
  /** `clearSelection()` 이 불린 횟수. */
  cleared = 0;
  /** `paste()` 로 들어온 글자들. */
  pasted: string[] = [];
  /** `scrollToBottom()` 이 불린 횟수. */
  scrolledToBottom = 0;
  /** `scrollToLine()` 이 받은 줄들. */
  scrolledToLine: number[] = [];
  /** `scrollLines()` 가 받은 값들. */
  scrolledLines: number[] = [];
  /** `scrollPages()` 가 받은 값들. */
  scrolledPages: number[] = [];
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;

  constructor() {
    StubTerminal.last = this;
  }

  loadAddon() {}
  open() {}
  write() {}
  dispose() {}

  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
    this.keyHandler = fn;
  }

  getSelection() {
    return this.selection;
  }

  clearSelection() {
    this.cleared += 1;
    this.selection = '';
  }

  paste(data: string) {
    this.pasted.push(data);
  }

  scrollToBottom() {
    this.scrolledToBottom += 1;
  }

  scrollToLine(line: number) {
    this.scrolledToLine.push(line);
  }

  scrollLines(amount: number) {
    this.scrolledLines.push(amount);
  }

  scrollPages(pages: number) {
    this.scrolledPages.push(pages);
  }

  onData() {
    return { dispose() {} };
  }

  onBinary() {
    return { dispose() {} };
  }

  onRender(fn: (v: { start: number; end: number }) => void) {
    return this._render.on(fn);
  }

  onScroll(fn: (v: number) => void) {
    return this._scroll.on(fn);
  }

  onResize(fn: (v: { cols: number; rows: number }) => void) {
    return this._resize.on(fn);
  }

  // ── 테스트가 터미널 쪽 변화를 흉내 낼 손잡이들 ──────────────

  /** 스크롤백이 자라거나 보는 자리가 바뀐 상황. 실제 xterm 처럼 `onRender` 로 알린다. */
  emitScroll(viewportY: number, baseY = this.buffer.active.baseY) {
    this.buffer.active.viewportY = viewportY;
    this.buffer.active.baseY = baseY;
    this._render.fire({ start: 0, end: this.rows - 1 });
  }

  /**
   * 렌더만 알린다. `emitScroll` 은 `viewportY`·`baseY` 를 함께 바꾸는데 대체 화면에서 그 값들은
   * 뜻이 없어, 거기서는 이쪽을 써야 거짓을 검사하지 않는다.
   */
  emitRender() {
    this._render.fire({ start: 0, end: this.rows - 1 });
  }

  /** vim·less 처럼 대체 화면으로 들어가고 나오는 상황. */
  setBufferType(type: 'normal' | 'alternate') {
    this.buffer.active.type = type;
    this._bufferChange.fire(this.buffer.active);
    this._render.fire({ start: 0, end: this.rows - 1 });
  }

  /** 배율·창 크기가 바뀌어 줄 수가 달라진 상황. */
  emitResize(rows: number) {
    this.rows = rows;
    this._resize.fire({ cols: this.cols, rows });
  }
}

/** 가장 최근에 만들어진 터미널. */
export function lastTerminal(): StubTerminal {
  if (!StubTerminal.last) throw new Error('터미널이 아직 만들어지지 않았습니다');
  return StubTerminal.last;
}

export function resetTerminalStub() {
  StubTerminal.last = null;
}

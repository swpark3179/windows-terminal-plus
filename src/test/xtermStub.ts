/**
 * 테스트용 가짜 xterm.
 *
 * jsdom 에는 캔버스도 WebGL 도 없다. 클립보드 배선을 확인하려면 선택 영역과
 * `paste()` 를 들여다볼 수 있어야 해서 스텁을 따로 둔다 —
 * `vi.mock` 팩토리는 호이스팅되므로 파일 안에 클래스를 둘 수 없다.
 */

export class StubTerminal {
  static last: StubTerminal | null = null;

  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  unicode = { activeVersion: '6' };
  buffer = { active: { type: 'normal' as 'normal' | 'alternate' } };

  /** 테스트가 세우는 선택 영역. */
  selection = '';
  /** `clearSelection()` 이 불린 횟수. */
  cleared = 0;
  /** `paste()` 로 들어온 글자들. */
  pasted: string[] = [];
  /** `scrollToBottom()` 이 불린 횟수. */
  scrolledToBottom = 0;
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

  onData() {
    return { dispose() {} };
  }

  onBinary() {
    return { dispose() {} };
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

/**
 * 터미널 클립보드 배선 테스트.
 *
 * 글자를 다듬는 규칙 자체는 `lib/clipboard.test.ts` 가 지킨다. 여기서 확인하려는 것은
 * **어떤 키가 무엇을 부르는가** — 특히 선택이 없을 때 Ctrl+C 가 여전히 셸로 가는지다.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => {
  const { fakeInvoke } = await import('../test/backend');
  return {
    invoke: (cmd: string, args?: unknown) => fakeInvoke(cmd, args),
    Channel: class {
      onmessage: ((data: ArrayBuffer) => void) | null = null;
    },
  };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

vi.mock('@xterm/xterm', async () => {
  const { StubTerminal } = await import('../test/xtermStub');
  return { Terminal: StubTerminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {}, Base64: class {} }));

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

import { TerminalPane } from './TerminalPane';
import { backend } from '../test/backend';
import { lastTerminal, resetTerminalStub } from '../test/xtermStub';
import { MAX_PASTE_CHARS } from '../lib/clipboard';
import { MIN_THUMB_PX } from '../lib/scrollbar';
import { WHEEL_CAP_PER_FRAME } from '../lib/termWheel';
import { terminalClipboard } from '../lib/terminalRegistry';
import type { Pane } from '../state/types';

const readMock = vi.mocked(readText);
const writeMock = vi.mocked(writeText);

const PANE: Pane = {
  id: 'p-term',
  kind: 'term',
  title: 'pwsh · 새 터미널',
  r: 1,
  c: 1,
  rs: 1,
  cs: 1,
  zoom: 14,
  alive: true,
  dirty: false,
};

function key(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'a',
    keyCode: 65,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    preventDefault() {},
    stopPropagation() {},
    ...over,
  } as KeyboardEvent;
}

function mount() {
  const view = render(<TerminalPane pane={PANE} sessionId="ses_test" />);
  const term = lastTerminal();
  return { view, term, press: (e: Partial<KeyboardEvent>) => term.keyHandler!(key(e)) };
}

beforeEach(() => {
  resetTerminalStub();
  readMock.mockReset();
  readMock.mockResolvedValue('');
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('복사', () => {
  it('Ctrl+Shift+C 는 선택을 클립보드로 보내고 선택을 지운다', async () => {
    const { term, press } = mount();
    term.selection = 'git status';

    expect(press({ key: 'C', ctrlKey: true, shiftKey: true })).toBe(false);
    await waitFor(() => expect(writeMock).toHaveBeenCalledWith('git status'));
    expect(term.cleared).toBe(1);
  });

  it('선택이 있으면 Ctrl+C 도 복사한다', async () => {
    const { term, press } = mount();
    term.selection = 'pnpm test';

    expect(press({ key: 'c', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(writeMock).toHaveBeenCalledWith('pnpm test'));
    // 복사는 지금 읽던 자리를 지켜야 한다 — 바닥으로 튕기면 방금 고른 걸 다시 봐야 한다.
    expect(term.scrolledToBottom).toBe(0);
  });

  it('선택이 없으면 Ctrl+C 는 셸로 간다 — SIGINT 가 살아 있어야 한다', () => {
    const { press } = mount();
    expect(press({ key: 'c', ctrlKey: true })).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('빈 칸만 드래그한 선택은 복사로 치지 않는다', () => {
    const { term, press } = mount();
    term.selection = '   \n  ';
    expect(press({ key: 'c', ctrlKey: true })).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe('붙여넣기', () => {
  it('Ctrl+V 는 클립보드를 읽어 개행을 CR 로 바꿔 넣는다', async () => {
    readMock.mockResolvedValue('echo one\r\necho two\n');
    const { term, press } = mount();

    expect(press({ key: 'v', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(term.pasted).toEqual(['echo one\recho two\r']));
  });

  it('스크롤을 올려 둔 채 붙여넣어도 바닥으로 돌아온다 — claude·codex 의 입력창이 화면 밖에 있으면 안 된다', () => {
    readMock.mockResolvedValue('hi');
    const { term, press } = mount();

    press({ key: 'v', ctrlKey: true });
    expect(term.scrolledToBottom).toBe(1);
  });

  it('같은 키의 keyup 으로는 다시 붙지 않는다', async () => {
    readMock.mockResolvedValue('hi');
    const { term, press } = mount();

    press({ key: 'v', ctrlKey: true });
    expect(press({ type: 'keyup', key: 'v', ctrlKey: true })).toBe(true);
    await waitFor(() => expect(term.pasted).toEqual(['hi']));
  });

  it('대체 화면에서도 Ctrl+V 는 붙여넣기다 — claude 는 거기서 돈다', async () => {
    // 예전에는 vim 의 비주얼 블록을 살리려고 대체 화면에서 Ctrl+V 를 프로그램에 넘겼다. 그런데
    // 요즘 claude 는 UI 를 대체 화면에 그려서, 정작 붙여넣기가 필요한 자리에서만 안 됐다.
    // (vim 의 비주얼 블록은 vim 이 스스로 안내하는 Ctrl+Q 로 쓴다.)
    readMock.mockResolvedValue('hi');
    const { term, press } = mount();
    term.buffer.active.type = 'alternate';

    expect(press({ key: 'v', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(term.pasted).toEqual(['hi']));
    // Ctrl+Shift+V 도 그대로다.
    expect(press({ key: 'V', ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it('한글 조합 중에도 Ctrl+V 는 붙여넣는다 — 다른 키는 그대로 넘긴다', async () => {
    readMock.mockResolvedValue('hi');
    const { term, press } = mount();

    // 조합 중인 글자는 IME 의 것이다 — 가로채면 그 글자가 죽는다.
    expect(press({ key: 'Process', keyCode: 229, isComposing: true })).toBe(true);
    // 클립보드 조합은 조합에 섞이지 않으므로 조합 중에도 가져간다.
    expect(press({ key: 'v', code: 'KeyV', ctrlKey: true, isComposing: true })).toBe(false);
    await waitFor(() => expect(term.pasted).toEqual(['hi']));
  });

  it('너무 큰 클립보드는 붙여넣지 않는다 — 셸이 굳는다', async () => {
    readMock.mockResolvedValueOnce('x'.repeat(MAX_PASTE_CHARS + 1));
    readMock.mockResolvedValueOnce('작은 것');
    const { term, press } = mount();

    // 붙여넣기는 체인으로 순서를 지키므로, 뒤이은 정상 붙여넣기가 도착했다는 것은
    // 앞의 큰 것이 이미 처리(=거부)됐다는 뜻이다. 빈 배열을 그냥 보는 것과 달리
    // 아직 아무 일도 안 일어나서 통과하는 일이 없다.
    press({ key: 'v', ctrlKey: true });
    press({ key: 'v', ctrlKey: true });
    await waitFor(() => expect(term.pasted).toEqual(['작은 것']));
  });

  it('가운데 클릭도 붙여넣는다', async () => {
    readMock.mockResolvedValue('middle');
    const { view, term } = mount();

    fireEvent.mouseDown(view.container.querySelector('.term-body')!, { button: 1 });
    expect(term.scrolledToBottom).toBe(1);
    await waitFor(() => expect(term.pasted).toEqual(['middle']));
  });
});

describe('줄바꿈', () => {
  it('Shift+Enter 와 Ctrl+Enter 는 LF 를 셸로 보낸다 — Ctrl+J 와 같은 바이트라 claude·codex 둘 다 알아듣는다', async () => {
    const { press } = mount();

    expect(press({ key: 'Enter', shiftKey: true })).toBe(false);
    await waitFor(() => expect(backend.lastArgs('pty_write')).toEqual({ paneId: 'p-term', data: '\n' }));

    expect(press({ key: 'Enter', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(backend.lastArgs('pty_write')).toEqual({ paneId: 'p-term', data: '\n' }));
  });

  it('스크롤을 올려 둔 채 눌러도 바닥으로 돌아온다 — 넣은 줄이 화면 밖에 있으면 안 된다', () => {
    const { term, press } = mount();
    expect(press({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(term.scrolledToBottom).toBe(1);
  });

  it('그냥 Enter 는 건드리지 않는다 — 평소처럼 셸로 간다', () => {
    const { press } = mount();
    expect(press({ key: 'Enter' })).toBe(true);
  });

  it('대체 화면(vim)에서도 그대로 LF 를 보낸다 — 원래 Ctrl+J 도 무해하게 통과하던 자리다', async () => {
    const { term, press } = mount();
    term.buffer.active.type = 'alternate';

    expect(press({ key: 'Enter', shiftKey: true })).toBe(false);
    await waitFor(() => expect(backend.lastArgs('pty_write')).toEqual({ paneId: 'p-term', data: '\n' }));
  });
});

describe('등록부', () => {
  it('우클릭 메뉴가 쓰는 손잡이를 걸어 두고 언마운트하면 거둔다', async () => {
    readMock.mockResolvedValue('from menu');
    const { view, term } = mount();

    terminalClipboard(PANE.id)!.paste();
    await waitFor(() => expect(term.pasted).toEqual(['from menu']));

    view.unmount();
    expect(terminalClipboard(PANE.id)).toBeUndefined();
  });
});

/**
 * 스크롤 막대 배선.
 *
 * 기하 자체는 `lib/scrollbar.test.ts` 가 지킨다. 여기서 볼 것은 **터미널의 어떤 변화가 막대의
 * 어떤 변화로 이어지는가** — 특히 출력이 쏟아지는 중에도 드래그가 커서를 놓치지 않는가다.
 */
describe('스크롤 막대', () => {
  const TRACK_TOP = 40;
  const TRACK_H = 200;

  /** jsdom 에는 배치가 없다. 트랙은 고정 크기로, 손잡이는 지금 쓰인 style 대로 잰 것처럼 답한다. */
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('term-scrollbar')) {
        return { top: TRACK_TOP, height: TRACK_H } as DOMRect;
      }
      if (this.classList.contains('term-scrollbar__thumb')) {
        return {
          top: TRACK_TOP + (parseFloat(this.style.top) || 0),
          height: parseFloat(this.style.height) || 0,
        } as DOMRect;
      }
      return { top: 0, height: 0 } as DOMRect;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  /** 막대는 rAF 로 모아 그린다. 그린 뒤를 보려면 프레임을 실제로 흘려보내야 한다. */
  const nextFrame = () =>
    act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

  const track = (view: ReturnType<typeof render>) =>
    view.container.querySelector('.term-scrollbar')!;
  const thumb = (view: ReturnType<typeof render>) =>
    view.container.querySelector<HTMLElement>('.term-scrollbar__thumb');

  /** 스크롤백이 `baseY` 줄 쌓인 터미널을 띄운다. */
  async function mountScrolled(baseY: number, pane: Pane = PANE) {
    const view = render(<TerminalPane pane={pane} sessionId="ses_test" />);
    const term = lastTerminal();
    term.emitScroll(0, baseY);
    await waitFor(() => expect(track(view)).toBeTruthy());
    return { view, term };
  }

  it('스크롤할 것이 없으면 손잡이를 그리지 않는다', async () => {
    const { view } = await mountScrolled(0);
    await waitFor(() => expect(track(view)).toHaveClass('term-scrollbar--off'));
    expect(thumb(view)).toBeNull();
  });

  it('8k 스크롤백에서도 손잡이가 잡을 수 있는 크기다 — 비율대로면 1px 이다', async () => {
    const { view } = await mountScrolled(8192);
    await waitFor(() => expect(thumb(view)).toBeTruthy());
    expect(parseFloat(thumb(view)!.style.height)).toBeGreaterThanOrEqual(MIN_THUMB_PX);
  });

  it('확대해서 보이는 줄이 줄어도 최소 크기를 지킨다', async () => {
    const { view, term } = await mountScrolled(8192);
    await waitFor(() => expect(thumb(view)).toBeTruthy());

    term.emitResize(6);
    await waitFor(() =>
      expect(parseFloat(thumb(view)!.style.height)).toBeGreaterThanOrEqual(MIN_THUMB_PX),
    );
  });

  it('손잡이를 맨 아래까지 끌면 버퍼 끝, 맨 위로 끌면 버퍼 처음에 닿는다', async () => {
    const { view, term } = await mountScrolled(8192);
    await waitFor(() => expect(thumb(view)).toBeTruthy());

    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: TRACK_TOP });
    fireEvent.mouseMove(window, { clientY: TRACK_TOP + 9999 });
    expect(term.scrolledToLine.at(-1)).toBe(8192);

    fireEvent.mouseMove(window, { clientY: TRACK_TOP - 9999 });
    expect(term.scrolledToLine.at(-1)).toBe(0);
    fireEvent.mouseUp(window);
  });

  it('끄는 동안 출력이 쏟아져도 손잡이가 커서 자리를 지킨다 — claude 밑에서 드래그가 빠지던 증상', async () => {
    const { view, term } = await mountScrolled(8192);
    await waitFor(() => expect(thumb(view)).toBeTruthy());

    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: TRACK_TOP });
    fireEvent.mouseMove(window, { clientY: TRACK_TOP + 100 });
    const held = thumb(view)!.style.top;
    expect(held).not.toBe('0px');

    // xterm 은 버퍼가 가득 찬 뒤에도 줄이 밀릴 때마다 보는 자리를 하나씩 당긴다.
    // 그때마다 손잡이가 따라 기어오르면 잡고 있던 것이 손에서 빠진다.
    for (let i = 0; i < 20; i++) {
      term.emitScroll(4000 - i, 8192);
      await nextFrame();
    }
    expect(thumb(view)!.style.top).toBe(held);

    // 놓으면 다시 버퍼가 말하는 자리로 돌아간다.
    fireEvent.mouseUp(window);
    await nextFrame();
    expect(thumb(view)!.style.top).not.toBe(held);
  });

  it('막대를 눌러도 터미널이 포커스를 잃지 않는다', async () => {
    const { view } = await mountScrolled(8192);
    await waitFor(() => expect(thumb(view)).toBeTruthy());
    // mouseDown 의 기본 동작이 포커스 이동이다. 막았으면 false 가 돌아온다.
    expect(fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: TRACK_TOP })).toBe(false);
    fireEvent.mouseUp(window);
  });

  it('트랙 빈 곳을 누르면 한 화면씩 넘긴다', async () => {
    const { view, term } = await mountScrolled(8192);
    await waitFor(() => expect(thumb(view)).toBeTruthy());

    fireEvent.mouseDown(track(view), { button: 0, clientY: TRACK_TOP + TRACK_H - 1 });
    expect(term.scrolledPages.at(-1)).toBe(1);
  });

  it('막대 위에서 휠을 굴리면 스크롤한다 — 막대는 xterm 밖이라 xterm 이 못 본다', async () => {
    const { view, term } = await mountScrolled(8192);
    await waitFor(() => expect(thumb(view)).toBeTruthy());

    fireEvent.wheel(track(view), { deltaY: 120 });
    expect(term.scrolledLines.at(-1)).toBeGreaterThan(0);

    // Ctrl+휠 은 창 확대다 — 막대가 가로채면 안 된다.
    const before = term.scrolledLines.length;
    fireEvent.wheel(track(view), { deltaY: 120, ctrlKey: true });
    expect(term.scrolledLines.length).toBe(before);
  });

  /** `term.element` 로 나간 합성 휠을 모은다 — 대체 화면에서 막대가 보내는 것이 이것이다. */
  function wheelLog(term: { element: HTMLElement }) {
    const seen: { deltaY: number; deltaMode: number }[] = [];
    term.element.addEventListener('wheel', (e) => {
      const w = e as WheelEvent;
      seen.push({ deltaY: w.deltaY, deltaMode: w.deltaMode });
    });
    return seen;
  }

  /**
   * 대체 화면으로 들어간 창. 손잡이는 바닥에 선다.
   *
   * `mode` 로 마우스 보고를 고른다. 이 값이 갈리는 지점이 중요하다 — 꺼져 있으면(화살표 경로)
   * 한 이벤트에 크기를 실어 한 번만 보내고, 켜져 있으면 SGR 보고에 크기가 실리지 않아 칸마다
   * 한 번씩 보낸다. `claude`·`codex` 는 켜는 쪽이다.
   */
  async function mountAlternate(pane: Pane = PANE, mode: 'none' | 'vt200' = 'none') {
    const { view, term } = await mountScrolled(8192, pane);
    term.modes.mouseTrackingMode = mode;
    term.setBufferType('alternate');
    await waitFor(() => expect(track(view)).toHaveClass('term-scrollbar--relative'));
    return { view, term, wheels: wheelLog(term) };
  }

  /** 보낸 휠의 총합. 위가 음수라 왕복하면 0 이 되어야 한다. */
  const sum = (ws: { deltaY: number }[]) => ws.reduce((a, w) => a + w.deltaY, 0);

  /** 가상 모드 손잡이가 **바닥에서** 쉬는 자리. 위로 올라가면 여기서 떠난다. */
  const REST = TRACK_H - MIN_THUMB_PX;

  it('대체 화면에서도 손잡이가 보인다 — claude 가 거기서 돈다', async () => {
    const { view, term } = await mountScrolled(8192);
    await waitFor(() => expect(thumb(view)).toBeTruthy());

    term.setBufferType('alternate');
    await waitFor(() => expect(track(view)).toHaveClass('term-scrollbar--relative'));
    expect(thumb(view)).toBeTruthy();
    expect(thumb(view)!.style.top).toBe(`${REST}px`);

    // 일반 버퍼로 나오면 다시 자리를 뜻하는 막대다.
    term.setBufferType('normal');
    await waitFor(() => expect(track(view)).not.toHaveClass('term-scrollbar--relative'));
    expect(thumb(view)).toBeTruthy();
  });

  it('대체 화면에서 끌면 끈 거리만큼 휠을 보낸다 — 스크롤백이 없어 그것만이 길이다', async () => {
    const { view, wheels } = await mountAlternate();
    const start = TRACK_TOP + REST;

    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: start });
    // 60px 위로 = 휠 10칸 위로(처음 이득이 6px = 한 칸이다). deltaY 는 xterm 규약대로 음수가 위다.
    fireEvent.mouseMove(window, { clientY: start - 60 });
    expect(wheels).toEqual([{ deltaY: -10, deltaMode: 1 }]);
    // 이어서 6px 더 끌면 남은 한 칸만 더 간다 — 총량과의 차이만 보내므로 겹치지 않는다.
    fireEvent.mouseMove(window, { clientY: start - 66 });
    expect(wheels.at(-1)).toEqual({ deltaY: -1, deltaMode: 1 });
    // 손잡이는 포인터에 붙는다.
    expect(thumb(view)!.style.top).toBe(`${REST - 66}px`);

    // 되돌려 끌면 보낸 것도 그대로 되돌아간다 — 이득이 제스처 안에서 고정이라 왕복 합이 0 이다.
    fireEvent.mouseMove(window, { clientY: start });
    expect(wheels.at(-1)).toEqual({ deltaY: 11, deltaMode: 1 });
    expect(sum(wheels)).toBe(0);

    fireEvent.mouseUp(window);
    await nextFrame();
    expect(thumb(view)!.style.top).toBe(`${REST}px`);
  });

  it('놓아도 손잡이가 제자리에 있는다 — 바닥으로 튀지 않는다', async () => {
    const { view, term } = await mountAlternate();
    const start = TRACK_TOP + REST;

    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: start });
    fireEvent.mouseMove(window, { clientY: start - 66 });
    const held = thumb(view)!.style.top;
    expect(held).toBe(`${REST - 66}px`);

    fireEvent.mouseUp(window);
    await nextFrame();
    expect(thumb(view)!.style.top).toBe(held);

    // 프로그램이 화면을 다시 그려도 지킨다 — claude 는 답하는 내내 다시 그린다.
    act(() => term.emitRender());
    await nextFrame();
    expect(thumb(view)!.style.top).toBe(held);
  });

  it('다시 끌면 놓아 둔 자리에서 이어진다', async () => {
    const { view, wheels } = await mountAlternate();
    const first = TRACK_TOP + REST;

    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: first });
    fireEvent.mouseMove(window, { clientY: first - 60 });
    fireEvent.mouseUp(window);
    await nextFrame();
    expect(thumb(view)!.style.top).toBe(`${REST - 60}px`);

    const second = TRACK_TOP + REST - 60;
    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: second });
    fireEvent.mouseMove(window, { clientY: second - 60 });
    // 앞서 올린 10칸 위로 10칸 더. 자리도 이어진다.
    expect(sum(wheels)).toBe(-20);
    expect(thumb(view)!.style.top).toBe(`${REST - 120}px`);
  });

  it('바닥까지 끌어내리면 한 화면치를 더 보내 진짜 바닥임을 확정한다', async () => {
    const { view, term, wheels } = await mountAlternate(PANE, 'vt200');
    const start = TRACK_TOP + REST;

    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: start });
    fireEvent.mouseMove(window, { clientY: start - 60 });
    fireEvent.mouseUp(window);
    await nextFrame();
    expect(sum(wheels)).toBe(-10);

    const from = TRACK_TOP + parseFloat(thumb(view)!.style.top);
    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: from });
    fireEvent.mouseMove(window, { clientY: from + 999 });
    fireEvent.mouseUp(window);
    await nextFrame();
    await nextFrame();

    // 올린 것을 되돌리고, 그 위에 한 화면을 더 내려 보냈다 — 우리가 적게 세고 있었어도 바닥에 닿는다.
    expect(sum(wheels)).toBe(term.rows);
    expect(thumb(view)!.style.top).toBe(`${REST}px`);
  });

  it('화살표 경로에서는 바닥에서 더 보내지 않는다 — 그 휠은 ↓ 키가 된다', async () => {
    const { view, wheels } = await mountAlternate();
    const start = TRACK_TOP + REST;

    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: start });
    fireEvent.mouseMove(window, { clientY: start - 60 });
    fireEvent.mouseUp(window);
    await nextFrame();

    const from = TRACK_TOP + parseFloat(thumb(view)!.style.top);
    fireEvent.mouseDown(thumb(view)!, { button: 0, clientY: from });
    fireEvent.mouseMove(window, { clientY: from + 999 });
    fireEvent.mouseUp(window);
    await nextFrame();
    await nextFrame();

    // claude 의 입력창에서는 히스토리 탐색, fzf 에서는 선택 이동이 된다 — 한 칸도 더 보내지 않는다.
    expect(sum(wheels)).toBe(0);
    expect(thumb(view)!.style.top).toBe(`${REST}px`);
  });

  it('대체 화면에서 트랙 빈 곳을 누르면 한 화면씩 — 화살표 경로는 한 번에', async () => {
    const { view, term, wheels } = await mountAlternate();

    fireEvent.mouseDown(track(view), { button: 0, clientY: TRACK_TOP + 10 });
    expect(wheels).toEqual([{ deltaY: -term.rows, deltaMode: 1 }]);
    expect(parseFloat(thumb(view)!.style.top)).toBeLessThan(REST);
  });

  it('보고 경로에서는 한 화면을 칸마다 나눠 보낸다 — SGR 보고에는 크기가 실리지 않는다', async () => {
    const { view, term, wheels } = await mountAlternate(PANE, 'vt200');

    fireEvent.mouseDown(track(view), { button: 0, clientY: TRACK_TOP + 10 });
    // 프레임당 상한까지만 내보내고 나머지는 다음 프레임으로 — 칸마다 `writePty` 가 한 번이다.
    expect(wheels).toHaveLength(WHEEL_CAP_PER_FRAME);
    await nextFrame();
    expect(wheels).toHaveLength(term.rows);
    expect(wheels.every((w) => w.deltaY === -1 && w.deltaMode === 1)).toBe(true);
  });

  it('대체 화면에서는 막대 위 휠도 프로그램으로 간다 — Ctrl+휠 은 확대라 그대로 흘린다', async () => {
    const { view, term, wheels } = await mountAlternate();

    fireEvent.wheel(track(view), { deltaY: 120 });
    expect(wheels).toEqual([{ deltaY: 3, deltaMode: 1 }]);
    // 대체 화면에는 스크롤백이 없다 — xterm 을 굴려 봐야 아무 일도 안 일어난다.
    expect(term.scrolledLines).toEqual([]);

    fireEvent.wheel(track(view), { deltaY: 120, ctrlKey: true });
    expect(wheels).toHaveLength(1);

    // 위로 굴리면 손잡이도 따라 올라간다. 3칸만큼이다 — 우리가 보낸 휠을 본문 감시자가
    // 다시 세면 6칸이 되어 자리가 어긋난다.
    fireEvent.wheel(track(view), { deltaY: -120 });
    await nextFrame();
    expect(thumb(view)!.style.top).toBe('146px');
  });

  it('본문에서 굴린 진짜 휠도 손잡이에 접힌다 — 안 그러면 막대가 거짓말을 한다', async () => {
    const { view, term } = await mountAlternate();
    expect(thumb(view)!.style.top).toBe(`${REST}px`);

    fireEvent.wheel(term.element, { deltaY: -5, deltaMode: 1 });
    await nextFrame();
    expect(parseFloat(thumb(view)!.style.top)).toBeLessThan(REST);
  });

  it('대체 화면을 드나들면 추정치가 초기화된다 — 다른 프로그램의 자리다', async () => {
    const { view, term } = await mountAlternate();

    fireEvent.wheel(track(view), { deltaY: -120 });
    await nextFrame();
    expect(thumb(view)!.style.top).not.toBe(`${REST}px`);

    term.setBufferType('normal');
    await waitFor(() => expect(track(view)).not.toHaveClass('term-scrollbar--relative'));
    term.setBufferType('alternate');
    await waitFor(() => expect(track(view)).toHaveClass('term-scrollbar--relative'));
    await nextFrame();
    expect(thumb(view)!.style.top).toBe(`${REST}px`);
  });

  it('마우스 보고가 켜지고 꺼지면 추정치를 다시 배운다 — 한 칸이 뜻하는 줄이 달라진다', async () => {
    const { view, term } = await mountAlternate();

    fireEvent.wheel(track(view), { deltaY: -120 });
    await nextFrame();
    expect(thumb(view)!.style.top).not.toBe(`${REST}px`);

    term.modes.mouseTrackingMode = 'vt200';
    act(() => term.emitRender());
    await nextFrame();
    expect(thumb(view)!.style.top).toBe(`${REST}px`);
  });

  it('claude 가 도는 창은 막대를 늘 또렷하게 둔다', async () => {
    const { view } = await mountScrolled(8192, { ...PANE, ai: 'claude' });
    expect(track(view)).toHaveClass('term-scrollbar--pinned');

    const plain = await mountScrolled(8192);
    expect(track(plain.view)).not.toHaveClass('term-scrollbar--pinned');
  });
});

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

  it('대체 화면(vim·less)에서는 Ctrl+V 를 그 프로그램에 넘긴다', () => {
    const { term, press } = mount();
    term.buffer.active.type = 'alternate';

    expect(press({ key: 'v', ctrlKey: true })).toBe(true);
    expect(readMock).not.toHaveBeenCalled();
    // Ctrl+Shift+V 는 대체 화면에서도 붙여넣기다.
    expect(press({ key: 'V', ctrlKey: true, shiftKey: true })).toBe(false);
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

  it('대체 화면에서는 막대를 감추고, 빠져나오면 되돌아온다', async () => {
    const { view, term } = await mountScrolled(8192);
    await waitFor(() => expect(thumb(view)).toBeTruthy());

    term.setBufferType('alternate');
    await waitFor(() => expect(thumb(view)).toBeNull());

    term.setBufferType('normal');
    await waitFor(() => expect(thumb(view)).toBeTruthy());
  });

  it('claude 가 도는 창은 막대를 늘 또렷하게 둔다', async () => {
    const { view } = await mountScrolled(8192, { ...PANE, ai: 'claude' });
    expect(track(view)).toHaveClass('term-scrollbar--pinned');

    const plain = await mountScrolled(8192);
    expect(track(plain.view)).not.toHaveClass('term-scrollbar--pinned');
  });
});

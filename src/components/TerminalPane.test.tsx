/**
 * 터미널 클립보드 배선 테스트.
 *
 * 글자를 다듬는 규칙 자체는 `lib/clipboard.test.ts` 가 지킨다. 여기서 확인하려는 것은
 * **어떤 키가 무엇을 부르는가** — 특히 선택이 없을 때 Ctrl+C 가 여전히 셸로 가는지다.
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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

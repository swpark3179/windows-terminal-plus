/**
 * UI 배선 스모크 테스트 — 특히 요구사항의 핵심인 병합 드래그.
 *
 * 병합 규칙 자체는 `rterm-core` 의 Rust 테스트가 지킨다. 여기서는
 * "드래그하면 판정을 물어보고, 시각적 표현이 뜨고, 거부되면 토스트만 뜬다" 를 확인한다.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 은 파일 최상단에서 호이스팅된다. 팩토리 안에서만 가짜 백엔드를 끌어온다.
vi.mock('@tauri-apps/api/core', async () => {
  const { fakeInvoke } = await import('./test/backend');
  return {
    invoke: (cmd: string, args?: unknown) => fakeInvoke(cmd, args),
    Channel: class {
      onmessage: ((data: ArrayBuffer) => void) | null = null;
    },
  };
});

vi.mock('@tauri-apps/api/window', async () => {
  const { windowStub } = await import('./test/backend');
  return { getCurrentWindow: () => windowStub };
});

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: () => Promise.resolve(null) }));

// jsdom 에는 캔버스/WebGL 이 없으므로 xterm 은 통째로 스텁으로 바꾼다.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    unicode = { activeVersion: '6' };
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));

import { App } from './App';
import { useStore } from './state/store';
import {
  EMPTY_PANE,
  TERM_PANE,
  TEXT_PANE,
  backend,
  makeDirtySnapshot,
  requestWindowClose,
  resetBackend,
} from './test/backend';

/** 스토어를 초기 상태로 되돌린다 (모듈 단위 싱글턴이라 테스트마다 필요). */
function resetStore() {
  useStore.setState({
    snapshot: null,
    ready: false,
    restored: false,
    editMode: false,
    op: null,
    sel: null,
    mergeSet: null,
    mergeVerdict: null,
    dragMerge: false,
    dragPos: null,
    ctx: null,
    palette: false,
    picker: null,
    settings: false,
    toast: null,
    fileDrop: false,
    confirm: null,
    resizeDraft: null,
    query: '',
  });
}

const paneEl = (id: string) => document.querySelector(`[data-pane="${id}"]`) as HTMLElement;

/** 부팅이 끝나 껍데기가 그려질 때까지 기다린다 (타이틀바 문구는 화면에 하나뿐). */
const waitForBoot = () => screen.findByText('통합 AI 터미널 · Rust');

/** 편집 모드 + 줄 병합 조작을 켠 상태로 앱을 띄운다. */
async function renderInMergeMode() {
  render(<App />);
  await waitForBoot();

  act(() => {
    useStore.setState({ editMode: true, op: 'merge' });
  });
  await screen.findByText('⧉ 줄 병합 · 드래그');
}

/** 터미널 창에서 빈 블럭까지 끌어간다. */
async function dragAcross() {
  fireEvent.mouseDown(paneEl(TERM_PANE));
  fireEvent.mouseMove(paneEl(TERM_PANE), { clientX: 100, clientY: 100 });
  fireEvent.mouseEnter(paneEl(EMPTY_PANE));
  await waitFor(() => expect(backend.calls).toContain('layout_merge_check'));
}

beforeEach(() => {
  resetBackend();
  resetStore();
});

afterEach(cleanup);

describe('앱 껍데기', () => {
  it('부팅하면 디자인의 주요 영역이 나타난다', async () => {
    render(<App />);
    await waitForBoot();

    // 세션 이름은 사이드바와 세션 헤더 양쪽에 나온다.
    expect(document.querySelector('.session-head__name')?.textContent).toBe('rterm · main');
    expect(document.querySelector('.session-row__name')?.textContent).toBe('rterm · main');
    expect(screen.getByText('세션')).toBeInTheDocument();
    expect(screen.getByText('명령 팔레트 Ctrl+Shift+P')).toBeInTheDocument();
    expect(screen.getByText('⊞ 레이아웃 편집')).toBeInTheDocument();
    // 상태바
    expect(screen.getByText(/창 1 · 빈 블럭 1 · grid 2×1/)).toBeInTheDocument();
  });

  it('빈 블럭은 터미널·파일 열기 버튼을 보여 준다', async () => {
    render(<App />);
    await waitForBoot();

    expect(screen.getByText('▮ 터미널 열기')).toBeInTheDocument();
    expect(screen.getByText('◫ 파일 열기')).toBeInTheDocument();
    expect(screen.getByText('파일을 이 블럭으로 드래그해도 열립니다')).toBeInTheDocument();
  });
});

describe('병합 드래그', () => {
  it('드래그하면 Rust 판정을 물어보고 시각적 표현이 함께 나타난다', async () => {
    // 이 시나리오는 통과하는 조합.
    backend.verdict = {
      status: 'ok',
      keepId: TERM_PANE,
      r: 1,
      c: 1,
      rs: 1,
      cs: 2,
      axis: 'row',
      count: 2,
    };
    backend.mergeError = null;

    await renderInMergeMode();
    await dragAcross();

    // ① 두 창 모두 강조 ② 합집합 오버레이 ③ 커서 배지 ④ 비대상 감쇠 없음(전부 대상)
    expect(paneEl(TERM_PANE).className).toContain('pane--marked');
    expect(paneEl(EMPTY_PANE).className).toContain('pane--marked');
    expect(document.querySelector('.merge-overlay')).toBeTruthy();
    expect(document.querySelector('.merge-overlay--bad')).toBeNull();
    expect(screen.getByText('2개 창 병합')).toBeInTheDocument();
    expect(screen.getByText('2개 창을 하나로')).toBeInTheDocument();
  });

  it('놓으면 병합되어 남은 창이 확장된다', async () => {
    backend.verdict = {
      status: 'ok',
      keepId: TERM_PANE,
      r: 1,
      c: 1,
      rs: 1,
      cs: 2,
      axis: 'row',
      count: 2,
    };
    backend.mergeError = null;

    await renderInMergeMode();
    await dragAcross();

    fireEvent.mouseUp(window);

    await waitFor(() => expect(screen.getByText('가로줄 2개 창 병합')).toBeInTheDocument());
    // 빈 블럭은 사라지고 터미널만 남는다.
    expect(paneEl(EMPTY_PANE)).toBeNull();
    expect(paneEl(TERM_PANE)).toBeTruthy();
    expect(document.querySelector('.merge-overlay')).toBeNull();
  });

  it('프로그램이 열린 창이 둘이면 놓기 전에 불가 표시가 뜬다', async () => {
    // 기본 시나리오 = tooManyPrograms 거부.
    await renderInMergeMode();
    await dragAcross();

    await waitFor(() => expect(document.querySelector('.merge-overlay--bad')).toBeTruthy());
    expect(screen.getByText('병합 불가 · 열린 창 2개')).toBeInTheDocument();
    expect(
      screen.getByText('프로그램이 열린 창은 하나만 병합할 수 있습니다'),
    ).toBeInTheDocument();
  });

  it('차단되면 토스트로 사유만 알리고 레이아웃은 그대로 둔다', async () => {
    await renderInMergeMode();
    await dragAcross();

    fireEvent.mouseUp(window);

    await waitFor(() => {
      const toast = document.querySelector('.toast');
      expect(toast?.textContent).toBe('프로그램이 열린 창은 하나만 병합할 수 있습니다');
    });

    // 두 창 모두 그대로 남아 있어야 한다.
    expect(paneEl(TERM_PANE)).toBeTruthy();
    expect(paneEl(EMPTY_PANE)).toBeTruthy();
    const grid = useStore.getState().snapshot?.sessions[0].grid;
    expect([grid?.cols, grid?.rows]).toEqual([2, 1]);
  });

  it('한 창에서 끝난 드래그는 조용히 취소된다', async () => {
    await renderInMergeMode();

    fireEvent.mouseDown(paneEl(TERM_PANE));
    fireEvent.mouseUp(window);

    await waitFor(() => expect(useStore.getState().dragMerge).toBe(false));
    expect(document.querySelector('.toast')).toBeNull();
    expect(backend.calls).not.toContain('layout_merge');
  });
});

describe('분할', () => {
  it('편집 툴바의 분할 버튼은 선택한 창에 대해 동작한다', async () => {
    render(<App />);
    await waitForBoot();

    act(() => {
      useStore.setState({ editMode: true, sel: TERM_PANE });
    });

    fireEvent.click(await screen.findByText('⬌ 좌·우 분할'));

    await waitFor(() => expect(backend.calls).toContain('layout_split'));
  });

  it('선택한 창이 없으면 분할 버튼이 비활성이다', async () => {
    render(<App />);
    await waitForBoot();

    act(() => {
      useStore.setState({ editMode: true, sel: null });
    });

    const button = (await screen.findByText('⬌ 좌·우 분할')) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('없음 — 창 클릭')).toBeInTheDocument();
  });
});

describe('저장하지 않은 변경', () => {
  /** 두 번째 칸이 편집 중인 notes.txt 인 상태로 띄운다. */
  async function renderWithDirtyFile() {
    backend.snapshot = makeDirtySnapshot();
    render(<App />);
    await waitForBoot();
    return within(paneEl(TEXT_PANE)).getByTitle('닫기 · 빈 블럭으로');
  }

  it('닫으려 하면 저장·버리기·취소를 묻는다', async () => {
    const closeButton = await renderWithDirtyFile();
    fireEvent.click(closeButton);

    expect(await screen.findByText('저장하지 않은 변경이 있습니다')).toBeInTheDocument();
    expect(screen.getByText('notes.txt 의 변경 내용을 저장할까요?')).toBeInTheDocument();
    expect(screen.getByText('저장 후 닫기')).toBeInTheDocument();
    expect(screen.getByText('저장하지 않고 닫기')).toBeInTheDocument();
    expect(screen.getByText('취소')).toBeInTheDocument();

    // 물어보는 동안에는 아직 아무것도 하지 않는다.
    expect(backend.calls).not.toContain('pane_close');
    expect(backend.calls).not.toContain('pane_save');
  });

  it('취소하면 창이 그대로 남는다', async () => {
    const closeButton = await renderWithDirtyFile();
    fireEvent.click(closeButton);
    fireEvent.click(await screen.findByText('취소'));

    await waitFor(() => expect(screen.queryByText('저장하지 않은 변경이 있습니다')).toBeNull());
    expect(backend.calls).not.toContain('pane_close');
    expect(paneEl(TEXT_PANE)).toBeTruthy();
  });

  it('Esc 도 취소로 동작한다', async () => {
    const closeButton = await renderWithDirtyFile();
    fireEvent.click(closeButton);
    await screen.findByText('저장하지 않은 변경이 있습니다');

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByText('저장하지 않은 변경이 있습니다')).toBeNull());
    expect(backend.calls).not.toContain('pane_close');
  });

  it('저장하지 않고 닫으면 저장 없이 닫힌다', async () => {
    const closeButton = await renderWithDirtyFile();
    fireEvent.click(closeButton);
    fireEvent.click(await screen.findByText('저장하지 않고 닫기'));

    await waitFor(() => expect(backend.calls).toContain('pane_close'));
    expect(backend.calls).not.toContain('pane_save');
  });

  it('저장 후 닫으면 저장이 먼저 일어난다', async () => {
    const closeButton = await renderWithDirtyFile();
    fireEvent.click(closeButton);
    fireEvent.click(await screen.findByText('저장 후 닫기'));

    await waitFor(() => expect(backend.calls).toContain('pane_close'));
    expect(backend.calls.indexOf('pane_save')).toBeGreaterThan(-1);
    expect(backend.calls.indexOf('pane_save')).toBeLessThan(backend.calls.indexOf('pane_close'));
  });

  it('변경이 없는 창은 묻지 않고 바로 닫는다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(within(paneEl(TERM_PANE)).getByTitle('닫기 · 빈 블럭으로'));

    await waitFor(() => expect(backend.calls).toContain('pane_close'));
    expect(screen.queryByText('저장하지 않은 변경이 있습니다')).toBeNull();
  });
});

describe('앱 종료 가로채기', () => {
  it('편집 중인 파일이 있으면 종료를 막고 물어본다', async () => {
    backend.snapshot = makeDirtySnapshot();
    render(<App />);
    await waitForBoot();

    act(() => requestWindowClose());

    expect(backend.closePrevented).toBe(true);
    expect(await screen.findByText('저장하지 않은 변경이 있습니다')).toBeInTheDocument();
    expect(screen.getByText('notes.txt 의 변경 내용을 저장하고 종료할까요?')).toBeInTheDocument();
    expect(screen.getByText('저장 후 종료')).toBeInTheDocument();
    expect(screen.getByText('저장하지 않고 종료')).toBeInTheDocument();
    expect(backend.destroyed).toBe(false);
  });

  it('취소하면 종료되지 않는다', async () => {
    backend.snapshot = makeDirtySnapshot();
    render(<App />);
    await waitForBoot();

    act(() => requestWindowClose());
    fireEvent.click(await screen.findByText('취소'));

    await waitFor(() => expect(screen.queryByText('저장하지 않은 변경이 있습니다')).toBeNull());
    expect(backend.destroyed).toBe(false);
  });

  it('저장 후 종료하면 저장하고 나서 창을 없앤다', async () => {
    backend.snapshot = makeDirtySnapshot();
    render(<App />);
    await waitForBoot();

    act(() => requestWindowClose());
    fireEvent.click(await screen.findByText('저장 후 종료'));

    await waitFor(() => expect(backend.destroyed).toBe(true));
    expect(backend.calls).toContain('pane_save');
  });

  it('저장하지 않고 종료하면 곧바로 창을 없앤다', async () => {
    backend.snapshot = makeDirtySnapshot();
    render(<App />);
    await waitForBoot();

    act(() => requestWindowClose());
    fireEvent.click(await screen.findByText('저장하지 않고 종료'));

    await waitFor(() => expect(backend.destroyed).toBe(true));
    expect(backend.calls).not.toContain('pane_save');
  });

  it('편집 중인 파일이 없으면 그대로 닫히게 둔다', async () => {
    render(<App />);
    await waitForBoot();

    act(() => requestWindowClose());

    expect(backend.closePrevented).toBe(false);
    expect(screen.queryByText('저장하지 않은 변경이 있습니다')).toBeNull();
  });
});

describe('창 경계 크기 조절', () => {
  /** jsdom 은 레이아웃을 계산하지 않으므로 그리드 폭을 직접 알려 준다. */
  function stubGridWidth(width: number) {
    const grid = document.querySelector('.grid') as HTMLElement;
    grid.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: width, bottom: 600, width, height: 600, x: 0, y: 0 }) as DOMRect;
    return grid;
  }

  const handles = () => document.querySelectorAll('.resize-handle');
  const weightCalls = () => backend.calls.filter((c) => c === 'layout_set_weights');

  it('편집 모드에서만 손잡이가 나온다', async () => {
    render(<App />);
    await waitForBoot();

    expect(handles()).toHaveLength(0);

    act(() => {
      useStore.setState({ editMode: true });
    });

    // 2열 1행 배치 → 세로 경계 하나.
    expect(handles()).toHaveLength(1);
    expect(document.querySelector('.resize-handle--col')).toBeTruthy();
    expect(document.querySelector('.resize-handle--row')).toBeNull();
  });

  it('병합 드래그 중에는 손잡이를 감춘다', async () => {
    render(<App />);
    await waitForBoot();
    act(() => {
      useStore.setState({ editMode: true, op: 'merge', dragMerge: true, mergeSet: [TERM_PANE] });
    });

    expect(handles()).toHaveLength(0);
  });

  it('끄는 동안 화면이 먼저 따라오고, 놓을 때 한 번 저장한다', async () => {
    render(<App />);
    await waitForBoot();
    act(() => {
      useStore.setState({ editMode: true });
    });

    // 여백 8px 을 빼면 트랙이 쓰는 폭이 정확히 1000px.
    const grid = stubGridWidth(1008);
    const handle = document.querySelector('.resize-handle--col')!;

    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 600 });

    // 손을 떼기 전에는 화면만 바뀐다.
    const draft = useStore.getState().resizeDraft;
    expect(draft?.axis).toBe('col');
    expect(draft?.weights[0]).toBeCloseTo(1.2);
    expect(draft?.weights[1]).toBeCloseTo(0.8);
    expect(grid.style.gridTemplateColumns).toContain('1.2fr');
    expect(weightCalls()).toHaveLength(0);

    fireEvent.mouseUp(window);

    await waitFor(() => expect(weightCalls()).toHaveLength(1));
    const sent = backend.lastArgs('layout_set_weights');
    expect(sent?.axis).toBe('col');
    expect((sent?.weights as number[])[0]).toBeCloseTo(1.2);
    expect(useStore.getState().resizeDraft).toBeNull();
  });

  it('경계를 끝까지 밀어도 반대쪽 창이 사라지지 않는다', async () => {
    render(<App />);
    await waitForBoot();
    act(() => {
      useStore.setState({ editMode: true });
    });
    stubGridWidth(1008);

    fireEvent.mouseDown(document.querySelector('.resize-handle--col')!, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 99999 });

    const weights = useStore.getState().resizeDraft!.weights;
    expect(weights[1]).toBeGreaterThan(0);
    expect(weights[0] + weights[1]).toBeCloseTo(2);
  });

  it('손잡이를 눌러도 창이 선택되거나 병합이 시작되지 않는다', async () => {
    render(<App />);
    await waitForBoot();
    act(() => {
      useStore.setState({ editMode: true, op: 'merge', sel: null });
    });
    stubGridWidth(1008);

    fireEvent.mouseDown(document.querySelector('.resize-handle--col')!, { clientX: 500 });

    expect(useStore.getState().dragMerge).toBe(false);
    expect(useStore.getState().sel).toBeNull();
  });
});

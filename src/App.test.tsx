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
// (스크롤 막대가 쓰는 버퍼·이벤트까지 필요하므로 터미널 테스트와 같은 스텁을 나눠 쓴다.)
vi.mock('@xterm/xterm', async () => {
  const { StubTerminal } = await import('./test/xtermStub');
  return { Terminal: StubTerminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {}, Base64: class {} }));

import { App } from './App';
import { terminalFocused } from './lib/keys';
import { useStore } from './state/store';
import { lastTerminal } from './test/xtermStub';
import {
  EMPTY_PANE,
  NEW_SESSION,
  NEW_TERM_PANE,
  SPLIT_PANE,
  TERM_CWD,
  TERM_PANE,
  TEXT_PANE,
  backend,
  makeDirtySnapshot,
  requestWindowClose,
  resetBackend,
  withSplitTerminal,
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
    newFile: null,
    newSession: false,
    settings: false,
    pendingCwd: null,
    toast: null,
    fileDrop: false,
    confirm: null,
    resizeDraft: null,
    liveTitles: {},
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

  it('빈 블럭은 터미널·파일 열기·새 파일 버튼을 보여 준다', async () => {
    render(<App />);
    await waitForBoot();

    expect(screen.getByText('▮ 터미널 열기')).toBeInTheDocument();
    expect(screen.getByText('◫ 파일 열기')).toBeInTheDocument();
    expect(screen.getByText('✚ 새 파일')).toBeInTheDocument();
    expect(screen.getByText('파일을 이 블럭으로 드래그해도 열립니다')).toBeInTheDocument();
  });

  it('빈 블럭의 새 파일 버튼이 만들기 창을 그 블럭에 대고 연다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(screen.getByText('✚ 새 파일'));

    expect(screen.getByText('새 파일 만들기')).toBeInTheDocument();
    expect(useStore.getState().newFile).toEqual({ paneId: EMPTY_PANE });
  });

  it('Esc 는 만들기 창도 닫는다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(screen.getByText('✚ 새 파일'));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useStore.getState().newFile).toBeNull();
  });
});

describe('창 제목', () => {
  it('셸이 알려 준 제목이 창 머리글에 나타난다', async () => {
    render(<App />);
    await waitForBoot();

    const head = () => paneEl(TERM_PANE).querySelector('.pane__title')!;
    expect(head().textContent).toBe('pwsh · 새 터미널');

    act(() => lastTerminal().emitTitle('claude — rterm'));

    await waitFor(() => expect(head().textContent).toBe('claude — rterm'));
    // 툴팁도 같은 값을 보여 준다 (잘려도 마우스를 올려 전체를 볼 수 있게).
    expect(head().getAttribute('title')).toBe('claude — rterm');
  });
});

describe('새 세션', () => {
  /** 이름 묻는 창이 떠 있는가. */
  const nameInput = () => screen.getByLabelText('세션 이름') as HTMLInputElement;

  /** 새 세션이 만들어졌고 그 터미널이 세션을 가득 채우고 있는가. */
  const expectFullTerminalSession = async () => {
    await waitFor(() => expect(useStore.getState().snapshot?.activeId).toBe(NEW_SESSION));
    expect(backend.calls).toContain('session_create');
    await waitFor(() => expect(paneEl(NEW_TERM_PANE)).toBeTruthy());
    expect(document.querySelector('.stage--full')).toBeTruthy();
    expect(paneEl(NEW_TERM_PANE).className).toContain('pane--full');
    // 빈 블럭 안내가 아니라 진짜 터미널이 서 있어야 한다.
    expect(screen.queryByText('▮ 터미널 열기')).toBeNull();
    expect(paneEl(NEW_TERM_PANE).querySelector('.term-body')).toBeTruthy();
    // 이름을 받고 나면 창은 사라진다.
    expect(screen.queryByText('새 세션', { selector: '.picker__title' })).toBeNull();
  };

  it('＋ 는 세션을 곧바로 만들지 않고 이름부터 묻는다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(screen.getByLabelText('새 세션'));

    expect(screen.getByText('새 세션', { selector: '.picker__title' })).toBeInTheDocument();
    // 다음 기본 이름이 채워진 채로 뜬다 — 그대로 엔터를 쳐도 된다.
    expect(nameInput().value).toBe('새 세션 2');
    expect(backend.calls).not.toContain('session_create');
  });

  it('이름을 치고 엔터하면 그 이름으로 만들어진다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(screen.getByLabelText('새 세션'));
    fireEvent.change(nameInput(), { target: { value: '배포 · stg' } });
    fireEvent.keyDown(nameInput(), { key: 'Enter' });

    await expectFullTerminalSession();
    expect(backend.lastArgs('session_create')).toEqual({ name: '배포 · stg' });
    // 방금 띄운 터미널을 설정 모달이 곧바로 덮어 버리면 안 된다.
    expect(useStore.getState().settings).toBe(false);
    // 고른 창은 그 터미널이어야 Ctrl+Shift+F · Ctrl+휠 이 곧바로 듣는다.
    expect(useStore.getState().sel).toBe(NEW_TERM_PANE);
  });

  it('생성 버튼도 엔터와 같은 일을 한다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(screen.getByLabelText('새 세션'));
    fireEvent.change(nameInput(), { target: { value: '  로그 보기  ' } });
    fireEvent.click(screen.getByText('생성'));

    await expectFullTerminalSession();
    expect(backend.lastArgs('session_create')).toEqual({ name: '로그 보기' });
  });

  it('한글 조합 중의 엔터는 만들기가 아니라 글자 확정이다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(screen.getByLabelText('새 세션'));
    fireEvent.compositionStart(nameInput());
    fireEvent.change(nameInput(), { target: { value: '한' } });
    fireEvent.keyDown(nameInput(), { key: 'Enter' });

    expect(backend.calls).not.toContain('session_create');
    fireEvent.compositionEnd(nameInput());
    fireEvent.keyDown(nameInput(), { key: 'Enter' });
    await expectFullTerminalSession();
  });

  it('닫기는 취소 — 세션이 만들어지지 않는다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(screen.getByLabelText('새 세션'));
    fireEvent.click(screen.getByText('닫기'));

    expect(useStore.getState().newSession).toBe(false);
    expect(backend.calls).not.toContain('session_create');
    expect(useStore.getState().snapshot?.activeId).not.toBe(NEW_SESSION);
  });

  it('이름이 비어 있으면 만들 수 없다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(screen.getByLabelText('새 세션'));
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    fireEvent.keyDown(nameInput(), { key: 'Enter' });

    expect(backend.calls).not.toContain('session_create');
    expect((screen.getByText('생성') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('세션 이름을 입력하세요')).toBeInTheDocument();
  });

  it('Esc 는 이름 묻는 창도 닫는다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(screen.getByLabelText('새 세션'));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useStore.getState().newSession).toBe(false);
    expect(backend.calls).not.toContain('session_create');
  });

  it('사이드바가 접혀 있어도 ＋ 로 세션을 더 만들 수 있다', async () => {
    render(<App />);
    await waitForBoot();

    // Ctrl+B 로 접으면 40px 레일만 남는다.
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => expect(document.querySelector('.rail')).toBeTruthy());
    expect(document.querySelector('.sidebar')).toBeNull();

    const plus = within(document.querySelector('.rail') as HTMLElement).getByLabelText('새 세션');
    fireEvent.click(plus);
    fireEvent.keyDown(nameInput(), { key: 'Enter' });

    await expectFullTerminalSession();
  });

  it('Ctrl+Shift+T 는 터미널 안에서도 이름 묻는 창을 연다', async () => {
    render(<App />);
    await waitForBoot();

    // 터미널에 포커스가 있어도 앱이 가져가는 조합이다.
    // (진짜 xterm 은 `.term-body` 안에 숨은 textarea 를 두고 거기서 키를 받는다.)
    const hidden = document.createElement('textarea');
    paneEl(TERM_PANE).querySelector('.term-body')!.appendChild(hidden);
    hidden.focus();
    expect(terminalFocused()).toBe(true);

    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true });

    fireEvent.keyDown(nameInput(), { key: 'Enter' });
    await expectFullTerminalSession();
  });
});

describe('나눈 자리에서 여는 터미널', () => {
  /** 터미널 창을 우클릭해 위·아래로 나눈다. */
  async function splitTheTerminal() {
    render(<App />);
    await waitForBoot();

    fireEvent.contextMenu(paneEl(TERM_PANE));
    fireEvent.click(screen.getByText('위·아래로 분할'));

    await waitFor(() => expect(paneEl(SPLIT_PANE)).toBeTruthy());
  }

  /** 갓 생긴 빈 블럭의 "터미널 열기". */
  const openTerminalThere = () =>
    fireEvent.click(within(paneEl(SPLIT_PANE)).getByText('▮ 터미널 열기'));

  const sentInherit = () => backend.lastArgs('pane_open_terminal')?.inherit;

  it('곧바로 열면 나눠 준 터미널과 같은 폴더에서 시작한다', async () => {
    await splitTheTerminal();

    // 무엇이 일어날지 빈 블럭이 먼저 알려 준다.
    expect(within(paneEl(SPLIT_PANE)).getByText(`터미널은 직전 터미널 폴더에서 시작합니다 · ${TERM_CWD}`))
      .toBeInTheDocument();

    openTerminalThere();

    await waitFor(() => expect(sentInherit()).toEqual({ sourcePaneId: TERM_PANE, cwd: TERM_CWD }));
    expect(await screen.findByText(`직전 터미널 폴더에서 시작 · ${TERM_CWD}`)).toBeInTheDocument();
  });

  it('그 사이 파일을 열었으면 세션에 적힌 폴더에서 시작한다', async () => {
    await splitTheTerminal();

    // 다른 블럭에 파일을 여는 것도 "다른 이벤트" 다 — 스냅샷이 갈리면 기억은 끝난다.
    await act(async () => {
      await useStore.getState().openFile(EMPTY_PANE, 'C:/work/rterm/README.md');
    });
    openTerminalThere();

    await waitFor(() => expect(backend.calls.filter((c) => c === 'pane_open_terminal')).toHaveLength(1));
    expect(sentInherit()).toBeNull();
  });

  it('나눠 준 터미널이 그새 폴더를 옮겼으면 물려받지 않는다', async () => {
    await splitTheTerminal();

    // 셸이 알려 준 새 폴더가 스냅샷에 실려 온다 (`cd` 뒤의 갱신).
    const moved = withSplitTerminal();
    moved.sessions[0].panes[0].cwd = 'C:/work/rterm/docs';
    backend.snapshot = moved;
    act(() => useStore.setState({ snapshot: moved }));

    openTerminalThere();

    await waitFor(() => expect(backend.calls).toContain('pane_open_terminal'));
    expect(sentInherit()).toBeNull();
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

describe('전체화면', () => {
  /** 터미널 창의 제목줄에 있는 전체화면 토글. */
  const fullButton = () =>
    within(paneEl(TERM_PANE)).getByTitle(/전체화면|창 모드로/) as HTMLButtonElement;

  it('전체화면으로 바꾸면 그 창만 세션 영역을 채운다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(fullButton());

    // 빈 블럭은 화면에서 빠지고 터미널만 남는다.
    await waitFor(() => expect(paneEl(EMPTY_PANE)).toBeNull());
    expect(backend.lastArgs('pane_set_full')).toMatchObject({
      sessionId: 'ses_test',
      paneId: TERM_PANE,
    });
    // 테두리가 두 겹으로 보이지 않도록 판 여백과 창 테두리를 걷어내는 표시.
    expect(document.querySelector('.stage--full')).toBeTruthy();
    expect(paneEl(TERM_PANE).className).toContain('pane--full');
    // 격자 자체는 그대로 남아 있어 창 모드로 돌아오면 배치가 살아난다.
    const grid = useStore.getState().snapshot?.sessions[0].grid;
    expect([grid?.cols, grid?.rows]).toEqual([2, 1]);
  });

  it('Ctrl+Shift+F 로 창 모드로 돌아온다 — 터미널을 가득 채운 뒤에도', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(fullButton());
    await waitFor(() => expect(paneEl(EMPTY_PANE)).toBeNull());

    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(paneEl(EMPTY_PANE)).toBeTruthy());
    expect(backend.lastArgs('pane_set_full')).toMatchObject({ paneId: null });
    expect(document.querySelector('.stage--full')).toBeNull();
  });

  it('세션 헤더 버튼도 같은 토글이다 — 전체화면이 되면 그 바까지 창이 덮는다', async () => {
    render(<App />);
    await waitForBoot();

    // 창이 하나뿐이면 고르지 않아도 그 창이 대상이 된다.
    fireEvent.click(screen.getByText('⤢ 전체화면'));

    // 세션 헤더 자체가 사라진다 — 고른 창이 이 바까지 감싸는 전체화면이라서다.
    await waitFor(() => expect(document.querySelector('.session-head')).toBeNull());
    expect(backend.lastArgs('pane_set_full')).toMatchObject({ paneId: TERM_PANE });

    // 돌아가는 길은 창 제목줄의 토글(⤡)이나 Ctrl+Shift+F 뿐이다.
    fireEvent.click(fullButton());
    await waitFor(() => expect(screen.getByText('⤢ 전체화면')).toBeInTheDocument());
  });

  it('Ctrl+E 로 레이아웃 편집을 켜면 격자가 보이도록 창 모드로 돌아간다', async () => {
    render(<App />);
    await waitForBoot();

    fireEvent.click(fullButton());
    await waitFor(() => expect(paneEl(EMPTY_PANE)).toBeNull());

    // 세션 헤더가 숨어 있어도 단축키는 그대로 듣는다.
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true });

    await waitFor(() => expect(backend.lastArgs('pane_set_full')).toMatchObject({ paneId: null }));
    expect(paneEl(EMPTY_PANE)).toBeTruthy();
    expect(useStore.getState().editMode).toBe(true);
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

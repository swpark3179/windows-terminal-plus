/**
 * 테스트용 가짜 Rust 백엔드.
 *
 * 병합 규칙 자체는 `rterm-core` 의 Rust 테스트가 검증한다. 여기서 확인하려는 것은
 * **UI 배선** — 드래그가 판정을 물어보는지, 거부 사유가 토스트로 뜨는지,
 * 성공하면 레이아웃이 갈아 끼워지는지 — 이라서 판정은 시나리오별로 미리 정해 둔다.
 */

import type { MergeVerdict, Pane, Session, Snapshot } from '../state/types';

export const TERM_PANE = 'p-term';
export const EMPTY_PANE = 'p-empty';
export const TEXT_PANE = 'p-text';

function pane(id: string, over: Partial<Pane>): Pane {
  return {
    id,
    kind: 'empty',
    title: '빈 블럭',
    r: 1,
    c: 1,
    rs: 1,
    cs: 1,
    zoom: 14,
    alive: false,
    dirty: false,
    ...over,
  };
}

export function makeSnapshot(): Snapshot {
  const session: Session = {
    id: 'ses_test',
    name: 'rterm · main',
    cwd: 'C:/work/rterm',
    shell: 'pwsh',
    start: '',
    sshHost: '',
    color: 0,
    env: [],
    grid: { cols: 2, rows: 1, colWeights: [1, 1], rowWeights: [1] },
    panes: [
      pane(TERM_PANE, { kind: 'term', title: 'pwsh · 새 터미널', alive: true, c: 1 }),
      pane(EMPTY_PANE, { c: 2 }),
    ],
  };
  return {
    version: 1,
    sessions: [session],
    activeId: session.id,
    sidebarOpen: true,
    savedAtEpoch: 1_700_000_000,
  };
}

/** 병합 후 두 창이 하나로 합쳐진 스냅샷. */
export function mergedSnapshot(): Snapshot {
  const snap = makeSnapshot();
  snap.sessions[0].grid = { cols: 1, rows: 1, colWeights: [1], rowWeights: [1] };
  snap.sessions[0].panes = [
    pane(TERM_PANE, { kind: 'term', title: 'pwsh · 새 터미널', alive: true, c: 1, cs: 1 }),
  ];
  return snap;
}

/** 두 번째 칸이 저장되지 않은 텍스트 편집기인 스냅샷. */
export function makeDirtySnapshot(): Snapshot {
  const snap = makeSnapshot();
  snap.sessions[0].panes[1] = pane(TEXT_PANE, {
    kind: 'text',
    title: 'notes.txt',
    c: 2,
    path: 'C:/work/rterm/notes.txt',
    content: '<div>메모</div>',
    dirty: true,
  });
  return snap;
}

/** 창을 닫으려 할 때 프론트엔드가 등록해 둔 처리기. */
export type CloseHandler = (event: { preventDefault: () => void }) => void;

export interface Backend {
  /** 부른 명령 이름 순서. */
  calls: string[];
  /** 명령별 마지막 인자 — 무엇을 보냈는지 확인할 때. */
  lastArgs: (cmd: string) => Record<string, unknown> | undefined;
  /** `window.destroy()` 가 불렸는지 — 실제로 종료됐다는 뜻. */
  destroyed: boolean;
  /** 닫기 확인이 취소돼 기본 동작이 막혔는지. */
  closePrevented: boolean;
  closeHandler: CloseHandler | null;
  /** `layout_merge_check` 가 돌려줄 판정. */
  verdict: MergeVerdict;
  /** `layout_merge` 가 거부할 때의 사유 문구. `null` 이면 성공. */
  mergeError: string | null;
  snapshot: Snapshot;
}

const argLog = new Map<string, Record<string, unknown>>();

export const backend: Backend = {
  calls: [],
  lastArgs: (cmd: string) => argLog.get(cmd),
  destroyed: false,
  closePrevented: false,
  closeHandler: null,
  verdict: { status: 'rejected', reason: 'tooManyPrograms', message: '프로그램이 열린 창은 하나만 병합할 수 있습니다' },
  mergeError: '프로그램이 열린 창은 하나만 병합할 수 있습니다',
  snapshot: makeSnapshot(),
};

export function resetBackend() {
  backend.calls = [];
  argLog.clear();
  backend.destroyed = false;
  backend.closePrevented = false;
  backend.closeHandler = null;
  backend.snapshot = makeSnapshot();
  backend.verdict = {
    status: 'rejected',
    reason: 'tooManyPrograms',
    message: '프로그램이 열린 창은 하나만 병합할 수 있습니다',
  };
  backend.mergeError = '프로그램이 열린 창은 하나만 병합할 수 있습니다';
}

export async function fakeInvoke(cmd: string, args?: unknown): Promise<unknown> {
  backend.calls.push(cmd);
  if (args && typeof args === 'object') argLog.set(cmd, args as Record<string, unknown>);
  switch (cmd) {
    case 'app_boot':
      return {
        snapshot: backend.snapshot,
        restored: false,
        home: 'C:/Users/tester',
        snapshotPath: 'C:/Users/tester/AppData/Roaming/rterm/sessions/snapshot.json',
      };
    case 'layout_merge_check':
      return backend.verdict;
    case 'layout_merge':
      if (backend.mergeError) throw backend.mergeError;
      backend.snapshot = mergedSnapshot();
      return { snapshot: backend.snapshot, keepId: TERM_PANE, message: '가로줄 2개 창 병합' };
    case 'pane_close':
      // 닫으면 그 칸은 빈 블럭으로 돌아간다.
      backend.snapshot = makeSnapshot();
      return backend.snapshot;
    case 'pane_save': {
      // 저장하면 dirty 표시가 내려간다.
      const saved = makeDirtySnapshot();
      saved.sessions[0].panes[1].dirty = false;
      backend.snapshot = saved;
      return { path: 'C:/work/rterm/notes.txt', bytes: 6, snapshot: saved };
    }
    case 'pty_open':
      return { restored: '', banner: '', attached: false };
    case 'pty_run_ai': {
      const kind = (args as { kind?: string } | undefined)?.kind;
      return kind === 'codex' ? 'codex resume --last' : 'claude --continue';
    }
    case 'pty_write':
    case 'pty_resize':
    case 'pty_detach':
    case 'set_sidebar_open':
    case 'snapshot_flush':
      return null;
    default:
      return backend.snapshot;
  }
}

/** `getCurrentWindow()` 대역. 닫기 처리기를 붙잡아 뒀다가 테스트에서 직접 부른다. */
export const windowStub = {
  minimize: () => Promise.resolve(),
  toggleMaximize: () => Promise.resolve(),
  close: () => Promise.resolve(),
  destroy: () => {
    backend.destroyed = true;
    return Promise.resolve();
  },
  onCloseRequested: (handler: CloseHandler) => {
    backend.closeHandler = handler;
    return Promise.resolve(() => {
      backend.closeHandler = null;
    });
  },
};

/** 사용자가 창 닫기를 시도한 것처럼 만든다. */
export function requestWindowClose() {
  backend.closeHandler?.({
    preventDefault: () => {
      backend.closePrevented = true;
    },
  });
}

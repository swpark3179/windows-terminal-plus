/**
 * 앱 상태. 두 부분으로 나뉜다.
 *
 * 1. `snapshot` — Rust 가 소유한 진짜 상태의 사본. 명령을 부르고 받은 값으로 통째로 갈아 끼운다.
 * 2. 나머지 — 선택·드래그·모달처럼 화면에만 사는 값.
 */

import { create } from 'zustand';
import * as api from '../ipc/bridge';
import type {
  MdMode,
  MergeVerdict,
  Pane,
  Session,
  Snapshot,
  SplitDir,
  TrackAxis,
} from './types';
import { ZOOM_BASE, ZOOM_MAX, ZOOM_MIN } from './types';

/** 저장하지 않은 변경이 있을 때 띄우는 3지선다. */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** 부제 — 대상 파일 이름 등. */
  detail?: string;
  saveLabel: string;
  discardLabel: string;
  onSave: () => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
}

export type ContextTarget =
  | { kind: 'session'; id: string; x: number; y: number }
  | { kind: 'pane'; id: string; x: number; y: number };

interface AppState {
  // ── Rust 미러 ────────────────────────────────
  snapshot: Snapshot | null;
  restored: boolean;
  home: string;
  snapshotPath: string;
  ready: boolean;

  // ── 화면 전용 ────────────────────────────────
  query: string;
  editMode: boolean;
  /** 편집 모드에서 고른 조작. */
  op: null | 'merge' | 'swap';
  sel: string | null;
  /** 드래그로 모이는 중인 창들. */
  mergeSet: string[] | null;
  mergeVerdict: MergeVerdict | null;
  dragMerge: boolean;
  /** 커서를 따라다니는 배지 위치. */
  dragPos: { x: number; y: number } | null;
  ctx: ContextTarget | null;
  palette: boolean;
  paletteQuery: string;
  paletteSel: number;
  picker: { paneId: string } | null;
  settings: boolean;
  toast: string | null;
  /** OS 에서 파일을 끌어오는 중. */
  fileDrop: boolean;
  /** 저장 · 버리고 진행 · 취소를 묻는 중. */
  confirm: ConfirmRequest | null;
  /** 경계를 끄는 동안의 임시 트랙 몫. 손을 떼면 Rust 로 넘어간다. */
  resizeDraft: { axis: TrackAxis; weights: number[] } | null;

  // ── 액션 ────────────────────────────────────
  boot: () => Promise<void>;
  /** Rust 상태만 다시 읽어 온다 (PTY 종료 등 프론트가 모르는 변화 반영). */
  refresh: () => Promise<void>;
  apply: (snapshot: Snapshot) => void;
  flash: (message: string) => void;
  clearToast: () => void;

  setQuery: (q: string) => void;
  toggleSidebar: () => void;
  toggleEdit: () => void;
  selectPane: (id: string) => void;

  splitSelected: (dir: SplitDir) => Promise<void>;
  splitPane: (paneId: string, dir: SplitDir) => Promise<void>;
  startMerge: (paneId?: string) => void;
  startSwap: (paneId?: string) => void;
  paneMouseDown: (paneId: string) => void;
  paneMouseEnter: (paneId: string) => void;
  setDragPos: (x: number, y: number) => void;
  finishMerge: () => Promise<void>;

  /** 저장하지 않은 변경이 있으면 먼저 묻고, 없으면 바로 닫는다. */
  requestClosePane: (paneId: string) => void;
  closePane: (paneId: string) => Promise<void>;
  /** 모든 세션의 편집 중인 파일을 저장한다. */
  saveAllDirty: () => Promise<void>;
  openTerminal: (paneId: string) => Promise<void>;
  openFile: (paneId: string, path: string) => Promise<void>;
  zoomBy: (paneId: string, delta: number) => Promise<void>;
  zoomReset: (paneId: string) => Promise<void>;
  setMdMode: (paneId: string, mode: MdMode) => Promise<void>;
  savePane: (paneId: string) => Promise<void>;

  newSession: () => Promise<void>;
  activateSession: (id: string) => Promise<void>;
  duplicateSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  patchSession: (patch: Parameters<typeof api.updateSession>[1]) => Promise<void>;
  resetSnapshot: () => Promise<void>;

  openContext: (target: ContextTarget) => void;
  closeContext: () => void;
  openPalette: () => void;
  closePalette: () => void;
  setPaletteQuery: (q: string) => void;
  setPaletteSel: (i: number) => void;
  openPicker: (paneId: string) => void;
  closePicker: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  setFileDrop: (on: boolean) => void;
  setConfirm: (request: ConfirmRequest | null) => void;
  setResizeDraft: (draft: { axis: TrackAxis; weights: number[] } | null) => void;
  resetTrackWeights: () => Promise<void>;
  closeOverlays: () => void;
}

/** 실패한 명령을 토스트로 알리고 조용히 넘어간다. */
async function guard(run: () => Promise<void>, flash: (m: string) => void) {
  try {
    await run();
  } catch (e) {
    flash(typeof e === 'string' ? e : e instanceof Error ? e.message : '작업에 실패했습니다');
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<AppState>((set, get) => ({
  snapshot: null,
  restored: false,
  home: '',
  snapshotPath: '',
  ready: false,

  query: '',
  editMode: false,
  op: null,
  sel: null,
  mergeSet: null,
  mergeVerdict: null,
  dragMerge: false,
  dragPos: null,
  ctx: null,
  palette: false,
  paletteQuery: '',
  paletteSel: 0,
  picker: null,
  settings: false,
  toast: null,
  fileDrop: false,
  confirm: null,
  resizeDraft: null,

  boot: async () => {
    const boot = await api.bootApp();
    set({
      snapshot: boot.snapshot,
      restored: boot.restored,
      home: boot.home,
      snapshotPath: boot.snapshotPath,
      ready: true,
    });
    if (boot.restored) {
      const count = boot.snapshot.sessions.length;
      get().flash(`이전 스냅샷에서 세션 ${count}개 복원 · 레이아웃/스크롤백 유지`);
    }
  },

  refresh: async () => {
    try {
      const boot = await api.bootApp();
      set({ snapshot: boot.snapshot });
    } catch {
      // 갱신 실패는 조용히 넘어간다 — 다음 명령이 어차피 새 스냅샷을 가져온다.
    }
  },

  apply: (snapshot) => set({ snapshot }),

  flash: (message) => {
    clearTimeout(toastTimer);
    set({ toast: message });
    toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },

  clearToast: () => set({ toast: null }),

  setQuery: (query) => set({ query }),

  toggleSidebar: () => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const sidebarOpen = !snapshot.sidebarOpen;
    set({ snapshot: { ...snapshot, sidebarOpen } });
    void api.setSidebarOpen(sidebarOpen);
  },

  toggleEdit: () =>
    set((s) => ({
      editMode: !s.editMode,
      op: null,
      mergeSet: null,
      mergeVerdict: null,
      dragMerge: false,
      resizeDraft: null,
      ctx: null,
    })),

  selectPane: (sel) => set({ sel }),

  splitSelected: async (dir) => {
    const { sel, flash } = get();
    if (!sel) {
      flash('먼저 분할할 창을 클릭해 선택하세요');
      return;
    }
    await get().splitPane(sel, dir);
  },

  splitPane: async (paneId, dir) => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    await guard(async () => {
      const res = await api.splitPane(snapshot.activeId, paneId, dir);
      apply(res.snapshot);
      set({ sel: res.newPaneId });
      flash(dir === 'leftRight' ? '좌·우로 분할' : '위·아래로 분할');
    }, flash);
  },

  startMerge: (paneId) =>
    set((s) => ({
      editMode: true,
      op: s.op === 'merge' && !paneId ? null : 'merge',
      sel: paneId ?? s.sel,
      mergeSet: null,
      mergeVerdict: null,
      dragMerge: false,
      ctx: null,
    })),

  startSwap: (paneId) =>
    set((s) => ({
      editMode: true,
      op: s.op === 'swap' && !paneId ? null : 'swap',
      sel: paneId ?? s.sel,
      ctx: null,
    })),

  paneMouseDown: (paneId) => {
    const { editMode, op, sel, snapshot, flash, apply } = get();
    if (!editMode) {
      set({ sel: paneId });
      return;
    }

    if (op === 'swap') {
      if (!sel || sel === paneId || !snapshot) {
        set({ sel: paneId });
        return;
      }
      const first = sel;
      void guard(async () => {
        const next = await api.swapPanes(snapshot.activeId, first, paneId);
        apply(next);
        set({ op: null, sel: paneId });
        flash('위치 교환 완료');
      }, flash);
      return;
    }

    if (op === 'merge') {
      set({ dragMerge: true, mergeSet: [paneId], mergeVerdict: null, sel: paneId });
      return;
    }

    set({ sel: paneId });
  },

  paneMouseEnter: (paneId) => {
    const { dragMerge, mergeSet, snapshot } = get();
    if (!dragMerge || !mergeSet || !snapshot) return;
    if (mergeSet.includes(paneId)) return;

    const next = [...mergeSet, paneId];
    set({ mergeSet: next });

    // 규칙은 Rust 한 곳에만 있다 — 미리보기도 같은 판정을 받아 쓴다.
    void api
      .checkMerge(snapshot.activeId, next)
      .then((verdict) => {
        // 판정이 돌아오는 사이 드래그가 더 진행됐으면 버린다.
        const cur = get().mergeSet;
        if (cur && cur.length === next.length && cur[cur.length - 1] === paneId) {
          set({ mergeVerdict: verdict });
        }
      })
      .catch(() => set({ mergeVerdict: null }));
  },

  setDragPos: (x, y) => set({ dragPos: { x, y } }),

  finishMerge: async () => {
    const { mergeSet, snapshot, flash, apply } = get();
    set({ dragMerge: false, dragPos: null });

    if (!mergeSet || mergeSet.length < 2 || !snapshot) {
      // 창 하나에서 끝난 드래그는 조용히 취소한다.
      set({ mergeSet: null, mergeVerdict: null });
      return;
    }

    const ids = mergeSet;
    set({ mergeSet: null, mergeVerdict: null });

    try {
      const res = await api.mergePanes(snapshot.activeId, ids);
      apply(res.snapshot);
      set({ op: null, sel: res.keepId });
      flash(res.message);
    } catch (e) {
      // 병합 불가 — 요구사항대로 사유만 알리고 레이아웃은 그대로 둔다.
      flash(typeof e === 'string' ? e : '병합할 수 없습니다');
    }
  },

  requestClosePane: (paneId) => {
    const { snapshot } = get();
    const pane = activePanes(snapshot).find((p) => p.id === paneId);
    if (!pane?.dirty) {
      void get().closePane(paneId);
      return;
    }
    set({
      confirm: {
        title: '저장하지 않은 변경이 있습니다',
        message: `${pane.title} 의 변경 내용을 저장할까요?`,
        detail: pane.path ?? undefined,
        saveLabel: '저장 후 닫기',
        discardLabel: '저장하지 않고 닫기',
        onSave: async () => {
          await get().savePane(paneId);
          await get().closePane(paneId);
        },
        onDiscard: async () => {
          await get().closePane(paneId);
        },
      },
    });
  },

  closePane: async (paneId) => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    await guard(async () => {
      apply(await api.closePane(snapshot.activeId, paneId));
      flash('창을 닫아 빈 블럭으로');
    }, flash);
  },

  saveAllDirty: async () => {
    const { snapshot, flash } = get();
    if (!snapshot) return;
    let saved = 0;
    for (const session of snapshot.sessions) {
      for (const pane of session.panes) {
        if (!pane.dirty || !pane.path) continue;
        try {
          await api.savePane(session.id, pane.id);
          saved += 1;
        } catch (e) {
          flash(typeof e === 'string' ? e : `${pane.title} 저장에 실패했습니다`);
        }
      }
    }
    await get().refresh();
    if (saved > 0) flash(`${saved}개 파일 저장됨`);
  },

  openTerminal: async (paneId) => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    await guard(async () => {
      apply(await api.openTerminalPane(snapshot.activeId, paneId));
      set({ sel: paneId });
    }, flash);
  },

  openFile: async (paneId, path) => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    await guard(async () => {
      apply(await api.openFilePane(snapshot.activeId, paneId, path));
      set({ sel: paneId });
    }, flash);
  },

  zoomBy: async (paneId, delta) => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    const pane = activePanes(snapshot).find((p) => p.id === paneId);
    if (!pane) return;
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pane.zoom + delta));
    if (zoom === pane.zoom) return;
    await guard(async () => {
      apply(await api.setPaneZoom(snapshot.activeId, paneId, zoom));
    }, flash);
  },

  zoomReset: async (paneId) => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    await guard(async () => {
      apply(await api.setPaneZoom(snapshot.activeId, paneId, ZOOM_BASE));
    }, flash);
  },

  setMdMode: async (paneId, mode) => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    await guard(async () => {
      apply(await api.setPaneMdMode(snapshot.activeId, paneId, mode));
      flash(mode === 'view' ? '마크다운 뷰어' : '마크다운 에디터');
    }, flash);
  },

  savePane: async (paneId) => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    await guard(async () => {
      const res = await api.savePane(snapshot.activeId, paneId);
      apply(res.snapshot);
      flash(`저장됨 · ${res.path.split(/[\\/]/).pop()} (${res.bytes} B)`);
    }, flash);
  },

  newSession: async () => {
    const { flash, apply } = get();
    await guard(async () => {
      apply(await api.createSession());
      set({ sel: null, settings: true });
      flash('새 세션 생성 · 빈 블럭에서 시작');
    }, flash);
  },

  activateSession: async (id) => {
    const { flash, apply } = get();
    await guard(async () => {
      apply(await api.activateSession(id));
      set({ sel: null, op: null, mergeSet: null, mergeVerdict: null });
    }, flash);
  },

  duplicateSession: async (id) => {
    const { flash, apply } = get();
    await guard(async () => {
      apply(await api.duplicateSession(id));
      set({ ctx: null, sel: null });
      flash('세션 복제');
    }, flash);
  },

  deleteSession: async (id) => {
    const { flash, apply } = get();
    await guard(async () => {
      apply(await api.deleteSession(id));
      set({ ctx: null, sel: null });
      flash('세션 삭제');
    }, flash);
  },

  patchSession: async (patch) => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    await guard(async () => {
      apply(await api.updateSession(snapshot.activeId, patch));
    }, flash);
  },

  resetSnapshot: async () => {
    const { flash, apply } = get();
    await guard(async () => {
      apply(await api.resetSnapshot());
      set({ sel: null, op: null, editMode: false });
      flash('스냅샷 초기화');
    }, flash);
  },

  openContext: (ctx) => set({ ctx }),
  closeContext: () => set({ ctx: null }),
  openPalette: () => set({ palette: true, paletteQuery: '', paletteSel: 0, ctx: null }),
  closePalette: () => set({ palette: false }),
  setPaletteQuery: (paletteQuery) => set({ paletteQuery, paletteSel: 0 }),
  setPaletteSel: (paletteSel) => set({ paletteSel }),
  openPicker: (paneId) => set({ picker: { paneId }, ctx: null }),
  closePicker: () => set({ picker: null }),
  openSettings: () => set({ settings: true, ctx: null }),
  closeSettings: () => set({ settings: false }),
  setFileDrop: (fileDrop) => set({ fileDrop }),
  setConfirm: (confirm) => set({ confirm }),
  setResizeDraft: (resizeDraft) => set({ resizeDraft }),

  resetTrackWeights: async () => {
    const { snapshot, flash, apply } = get();
    if (!snapshot) return;
    await guard(async () => {
      apply(await api.resetTrackWeights(snapshot.activeId));
      flash('창 크기를 균등하게');
    }, flash);
  },

  closeOverlays: () =>
    set({
      ctx: null,
      picker: null,
      settings: false,
      palette: false,
      confirm: null,
      op: null,
      mergeSet: null,
      mergeVerdict: null,
      dragMerge: false,
    }),
}));

// ── 셀렉터 ───────────────────────────────────────────────

export function activeSession(snapshot: Snapshot | null): Session | null {
  if (!snapshot) return null;
  return snapshot.sessions.find((s) => s.id === snapshot.activeId) ?? snapshot.sessions[0] ?? null;
}

export function activePanes(snapshot: Snapshot | null): Pane[] {
  return activeSession(snapshot)?.panes ?? [];
}

/** 저장되지 않은 변경이 있는 파일 패널 — 세션 구분 없이 전부. */
export function dirtyPanes(snapshot: Snapshot | null): { session: Session; pane: Pane }[] {
  if (!snapshot) return [];
  return snapshot.sessions.flatMap((session) =>
    session.panes.filter((pane) => pane.dirty && pane.path).map((pane) => ({ session, pane })),
  );
}

/** 저장 시각을 디자인의 `HH:MM 기록` 형태로. */
export function formatSavedAt(epoch: number | null | undefined): string {
  if (!epoch) return '변경 없음';
  const d = new Date(epoch * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} 기록`;
}

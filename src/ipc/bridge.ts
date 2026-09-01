/**
 * Rust 명령을 타입 붙여 감싼 얇은 층. 프론트엔드는 여기 밖에서 `invoke` 를 직접 부르지 않는다.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import {
  readText as pluginReadText,
  writeText as pluginWriteText,
} from '@tauri-apps/plugin-clipboard-manager';
import type {
  AiKind,
  Boot,
  FileEntry,
  ImageDoc,
  TrackAxis,
  MdMode,
  MergeResult,
  MergeVerdict,
  SaveResult,
  SessionPatch,
  Snapshot,
  SpawnResult,
  SplitDir,
  SplitResult,
} from '../state/types';

export const bootApp = () => invoke<Boot>('app_boot');
export const flushSnapshot = () => invoke<number>('snapshot_flush');
export const resetSnapshot = () => invoke<Snapshot>('snapshot_reset');
export const setSidebarOpen = (open: boolean) => invoke<number>('set_sidebar_open', { open });

// ── 세션 ────────────────────────────────────────────────
export const createSession = () => invoke<Snapshot>('session_create');
export const duplicateSession = (sessionId: string) =>
  invoke<Snapshot>('session_duplicate', { sessionId });
export const deleteSession = (sessionId: string) => invoke<Snapshot>('session_delete', { sessionId });
export const activateSession = (sessionId: string) =>
  invoke<Snapshot>('session_activate', { sessionId });
export const updateSession = (sessionId: string, patch: SessionPatch) =>
  invoke<Snapshot>('session_update', { sessionId, patch });

// ── 레이아웃 ─────────────────────────────────────────────
export const splitPane = (sessionId: string, paneId: string, dir: SplitDir) =>
  invoke<SplitResult>('layout_split', { sessionId, paneId, dir });

/** 드래그 중 매 hover 마다 호출. 상태를 바꾸지 않는다. */
export const checkMerge = (sessionId: string, paneIds: string[]) =>
  invoke<MergeVerdict>('layout_merge_check', { sessionId, paneIds });

export const mergePanes = (sessionId: string, paneIds: string[]) =>
  invoke<MergeResult>('layout_merge', { sessionId, paneIds });

export const swapPanes = (sessionId: string, a: string, b: string) =>
  invoke<Snapshot>('layout_swap', { sessionId, a, b });

/** 경계 드래그가 끝났을 때 새 트랙 몫을 기록한다. */
export const setTrackWeights = (sessionId: string, axis: TrackAxis, weights: number[]) =>
  invoke<Snapshot>('layout_set_weights', { sessionId, axis, weights });

export const resetTrackWeights = (sessionId: string) =>
  invoke<Snapshot>('layout_reset_weights', { sessionId });

export const closePane = (sessionId: string, paneId: string) =>
  invoke<Snapshot>('pane_close', { sessionId, paneId });

export const openTerminalPane = (sessionId: string, paneId: string) =>
  invoke<Snapshot>('pane_open_terminal', { sessionId, paneId });

export const setPaneZoom = (sessionId: string, paneId: string, zoom: number) =>
  invoke<Snapshot>('pane_set_zoom', { sessionId, paneId, zoom });

export const setPaneMdMode = (sessionId: string, paneId: string, mode: MdMode) =>
  invoke<Snapshot>('pane_set_md_mode', { sessionId, paneId, mode });

// ── 터미널 ───────────────────────────────────────────────
/**
 * 터미널 화면을 연다 — 이미 돌고 있는 셸이면 다시 붙고, 없으면 새로 띄운다.
 * `onData` 채널로 raw 바이트가 흘러온다.
 * xterm 이 이미 살아 있을 때만 불러야 한다 — ConPTY 가 시작 직후 커서 위치를 묻는다.
 */
export const openPty = (
  sessionId: string,
  paneId: string,
  cols: number,
  rows: number,
  onData: Channel<ArrayBuffer>,
) => invoke<SpawnResult>('pty_open', { sessionId, paneId, cols, rows, onData });

/** xterm 이 사라질 때 출력 채널만 뗀다. 셸은 계속 돈다. */
export const detachPty = (paneId: string) => invoke<void>('pty_detach', { paneId });

export const writePty = (paneId: string, data: string) => invoke<void>('pty_write', { paneId, data });
export const resizePty = (paneId: string, cols: number, rows: number) =>
  invoke<void>('pty_resize', { paneId, cols, rows });

/**
 * 고른 창에서 AI 대화를 이어붙인다.
 *
 * 세션 ID 는 넘기지 않는다 — `claude --continue` / `codex resume --last` 가 그 창의
 * 현재 폴더에서 가장 최근 대화를 알아서 찾는다.
 */
export const runAi = (paneId: string, kind: AiKind) =>
  invoke<string>('pty_run_ai', { paneId, kind });

// ── 파일 ─────────────────────────────────────────────────
export const listFiles = (cwd: string) => invoke<FileEntry[]>('fs_list', { cwd });

/** 이미지는 스냅샷에 담지 않고 열 때마다 읽어 온다. */
export const readImage = (path: string) => invoke<ImageDoc>('fs_read_image', { path });

export const setPaneImageZoom = (sessionId: string, paneId: string, zoom: number | null) =>
  invoke<void>('pane_set_image_zoom', { sessionId, paneId, zoom });
export const openFilePane = (sessionId: string, paneId: string, path: string) =>
  invoke<Snapshot>('pane_open_file', { sessionId, paneId, path });
export const setPaneContent = (sessionId: string, paneId: string, content: string) =>
  invoke<void>('pane_set_content', { sessionId, paneId, content });
export const savePane = (sessionId: string, paneId: string) =>
  invoke<SaveResult>('pane_save', { sessionId, paneId });

// ── 클립보드 ─────────────────────────────────────────────
//
// 웹뷰의 `navigator.clipboard` 는 WebView2 에서 권한·사용자 제스처 사정으로 조용히 실패한다.
// 진짜 Win32 클립보드는 Rust 쪽 플러그인으로만 다루고, 브라우저 API 는 `pnpm dev` 를
// 그냥 브라우저로 열었을 때와 테스트를 위한 뒷길로만 남긴다.

/**
 * 시스템 클립보드의 텍스트.
 *
 * 클립보드가 비었거나 그림만 들어 있으면 플러그인이 오류를 던진다 — 사용자에게 보일 만한
 * 사건이 아니므로 빈 문자열로 갈음한다.
 */
export async function readClipboardText(): Promise<string> {
  try {
    return (await pluginReadText()) ?? '';
  } catch {
    try {
      return (await navigator.clipboard?.readText()) ?? '';
    } catch {
      return '';
    }
  }
}

/** 시스템 클립보드에 텍스트를 쓴다. 두 길 모두 막히면 호출부가 알 수 있도록 throw 한다. */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    await pluginWriteText(text);
  } catch (e) {
    const fallback = navigator.clipboard?.writeText;
    if (!fallback) throw e;
    await fallback.call(navigator.clipboard, text);
  }
}

export { Channel };

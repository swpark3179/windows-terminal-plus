/**
 * Rust(`rterm-core`)가 내려주는 모양을 그대로 옮긴 타입들.
 * 레이아웃 계산은 전부 Rust 가 하므로 여기에는 규칙이 아니라 모양만 있다.
 */

export type PaneKind = 'empty' | 'term' | 'md' | 'text' | 'image';
export type Shell = 'pwsh' | 'cmd' | 'wsl' | 'ssh';
export type MdMode = 'view' | 'edit';

/** 터미널 창에서 돌고 있는 AI CLI. */
export type AiKind = 'claude' | 'codex';

/** 디자인의 `dir: v/h` 에 대응. */
export type SplitDir = 'leftRight' | 'topBottom';
export type MergeAxis = 'row' | 'col';
export type MergeRejectReason = 'tooFew' | 'missing' | 'notAligned' | 'tooManyPrograms';

export interface EnvVar {
  k: string;
  v: string;
}

export interface Grid {
  cols: number;
  rows: number;
  /** 트랙별 몫. 길이는 cols/rows 와 같다. `grid-template-*` 의 fr 값이 된다. */
  colWeights: number[];
  rowWeights: number[];
}

/** 크기를 조절할 트랙 방향. */
export type TrackAxis = 'col' | 'row';

export interface Pane {
  id: string;
  kind: PaneKind;
  title: string;
  /** CSS grid 좌표 — `grid-area: r / c / span rs / span cs`. */
  r: number;
  c: number;
  rs: number;
  cs: number;
  /** 폰트 px. 14 = 100%. */
  zoom: number;
  alive: boolean;
  /** 셸이 알려 준 마지막 작업 폴더. 다음에 이 창을 열 때의 시작 위치. */
  cwd?: string | null;
  /** 스냅샷을 찍을 때 이 창에서 돌고 있던 AI CLI. */
  ai?: AiKind | null;
  path?: string | null;
  content?: string | null;
  mode?: MdMode | null;
  /** 이미지 패널의 확대 배율(%). 없으면 창에 맞춤. */
  imageZoom?: number | null;
  dirty: boolean;
}

export interface Session {
  id: string;
  name: string;
  cwd: string;
  shell: Shell;
  start: string;
  sshHost: string;
  color: number;
  env: EnvVar[];
  grid: Grid;
  panes: Pane[];
  /** 혼자 세션 영역을 가득 채우고 있는 창. 없으면 평소의 격자 배치. */
  fullPaneId?: string | null;
}

export interface Snapshot {
  version: number;
  sessions: Session[];
  activeId: string;
  sidebarOpen: boolean;
  savedAtEpoch?: number | null;
}

export interface Boot {
  snapshot: Snapshot;
  restored: boolean;
  home: string;
  snapshotPath: string;
}

/** 병합 판정. 드래그 중에도 이 값으로 오버레이 색을 정한다. */
export type MergeVerdict =
  | {
      status: 'ok';
      keepId: string;
      r: number;
      c: number;
      rs: number;
      cs: number;
      axis: MergeAxis;
      count: number;
    }
  | { status: 'rejected'; reason: MergeRejectReason; message: string };

export interface SplitResult {
  snapshot: Snapshot;
  newPaneId: string;
}

export interface MergeResult {
  snapshot: Snapshot;
  keepId: string;
  message: string;
}

export interface SpawnResult {
  /** 화면에 다시 그릴 내용(ANSI). */
  restored: string;
  banner: string;
  /** 이미 돌고 있던 셸에 다시 붙었는지. */
  attached: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  ext: string;
  size: string;
  isMarkdown: boolean;
  isImage: boolean;
}

export interface ImageDoc {
  /** `data:image/png;base64,...` */
  dataUrl: string;
  mime: string;
  bytes: number;
}

export interface FileDoc {
  name: string;
  path: string;
  isMarkdown: boolean;
  content: string;
}

export interface SaveResult {
  path: string;
  bytes: number;
  snapshot: Snapshot;
}

export interface SessionPatch {
  name?: string;
  cwd?: string;
  shell?: Shell;
  start?: string;
  sshHost?: string;
  env?: EnvVar[];
}

export interface PtyExitEvent {
  paneId: string;
  code: number;
}

/** 사이드바 색상 dot — 디자인의 `DOT` 상수. */
export const DOT_COLORS = ['#c96442', '#7a5cc0', '#c9a03f', '#5a8f52', '#3f7fa8'];

export const SHELL_LABELS: Record<Shell, string> = {
  pwsh: 'PowerShell 7 · pwsh',
  cmd: '명령 프롬프트 · cmd',
  wsl: 'WSL · Ubuntu',
  ssh: 'SSH 원격',
};

/** 패널 종류 배지 색 — 디자인의 `kc`. */
export const KIND_STYLE: Record<
  Exclude<PaneKind, 'empty'>,
  { label: string; fg: string; ring: string; bg: string }
> = {
  term: { label: 'TERM', fg: '#3f7a37', ring: '#cfe0cb', bg: '#f1f6ef' },
  md: { label: 'MD', fg: '#a04f2e', ring: '#e8cfc4', bg: '#fbf1ec' },
  text: { label: 'TXT', fg: '#7a5232', ring: '#e6dcc8', bg: '#f9f5ea' },
  image: { label: 'IMG', fg: '#3f5fa8', ring: '#ccd6ea', bg: '#f0f3fa' },
};


export const ZOOM_BASE = 14;
export const ZOOM_MIN = 9;
export const ZOOM_MAX = 34;

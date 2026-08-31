/**
 * 창 경계 드래그 계산.
 *
 * 레이아웃은 트랙마다 몫을 가진 CSS grid 다. 경계를 끌면 **이웃한 두 트랙만** 몫을
 * 주고받으므로 합이 변하지 않는다 — 한 창이 커진 만큼 반대쪽 창이 정확히 작아진다.
 * 그 선을 가로지르는 창(두 트랙을 함께 덮는 창)은 폭의 합이 그대로라 크기가 변하지 않는다.
 */

import type { Grid, Pane } from '../state/types';

/** 트랙 하나가 가질 수 있는 가장 작은 몫 (Rust 의 `MIN_TRACK_WEIGHT` 와 맞춘다). */
export const MIN_WEIGHT = 0.04;

/** 손잡이를 놓을 자리 하나. */
export interface Seam {
  /** 몇 번째 트랙 경계인가 — 트랙 `line` 과 `line + 1` 사이 (1-기반). */
  line: number;
  /** 이 이음매가 실제로 보이는 구간의 시작 트랙 (반대 축, 1-기반). */
  start: number;
  /** 구간 길이 (반대 축 트랙 수). */
  span: number;
}

/** 창이 반대 축의 트랙 `t` 를 덮는가. */
function covers(from: number, size: number, t: number): boolean {
  return from <= t && from + size > t;
}

/**
 * 세로 이음매 — 좌우로 인접한 창 사이의 경계.
 *
 * 어떤 창이 `line` 과 `line+1` 트랙을 함께 덮고 있으면 그 행에서는 경계가 보이지 않으므로
 * 손잡이를 놓지 않는다. 그래서 이음매가 여러 토막으로 나뉠 수 있다.
 */
export function verticalSeams(panes: Pane[], grid: Grid): Seam[] {
  return seams(grid.cols, grid.rows, (line, track) =>
    panes.some(
      (p) => p.c <= line && p.c + p.cs > line + 1 && covers(p.r, p.rs, track),
    ),
  );
}

/** 가로 이음매 — 위아래로 인접한 창 사이의 경계. */
export function horizontalSeams(panes: Pane[], grid: Grid): Seam[] {
  return seams(grid.rows, grid.cols, (line, track) =>
    panes.some(
      (p) => p.r <= line && p.r + p.rs > line + 1 && covers(p.c, p.cs, track),
    ),
  );
}

/** 경계선마다 "가로지르는 창이 없는" 연속 구간을 모은다. */
function seams(
  lines: number,
  crossTracks: number,
  crossedAt: (line: number, track: number) => boolean,
): Seam[] {
  const found: Seam[] = [];

  for (let line = 1; line <= lines - 1; line++) {
    let start = 0;
    for (let track = 1; track <= crossTracks + 1; track++) {
      const open = track <= crossTracks && !crossedAt(line, track);
      if (open) {
        if (start === 0) start = track;
      } else if (start !== 0) {
        found.push({ line, start, span: track - start });
        start = 0;
      }
    }
  }
  return found;
}

/**
 * 경계를 `deltaPx` 만큼 민 결과의 새 몫 배열.
 *
 * @param weights 현재 트랙 몫
 * @param line    움직이는 경계 (트랙 `line` 과 `line+1` 사이, 1-기반)
 * @param deltaPx 끌린 거리 (양수 = 오른쪽/아래)
 * @param trackPx 트랙들이 실제로 차지하는 픽셀 (칸 사이 여백은 뺀 값)
 */
export function dragWeights(
  weights: number[],
  line: number,
  deltaPx: number,
  trackPx: number,
): number[] {
  const a = line - 1;
  const b = line;
  if (a < 0 || b >= weights.length || trackPx <= 0) return weights;

  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return weights;

  const perPx = total / trackPx;
  const pair = weights[a] + weights[b];

  // 둘이 가진 몫 안에서만 주고받는다 — 나머지 트랙은 손대지 않는다.
  const nextA = Math.min(pair - MIN_WEIGHT, Math.max(MIN_WEIGHT, weights[a] + deltaPx * perPx));

  const next = [...weights];
  next[a] = nextA;
  next[b] = pair - nextA;
  return next;
}

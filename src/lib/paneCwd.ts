/**
 * 나눈 자리에서 곧바로 여는 터미널이 물려받을 폴더.
 *
 * 터미널을 우클릭해 분할하면 대개 "지금 이 폴더에서 하나 더" 라는 뜻이다. 그래서 갓 생긴
 * 빈 블럭 하나에 대해서만, **분할 직후에 한해** 나눠 준 터미널의 폴더를 기억해 둔다.
 *
 * 그 사이에 다른 일이 있었으면 물려받지 않고 세션 설정의 폴더로 돌아간다. "다른 일" 은 두 갈래다.
 *
 * 1. 그 블럭이나 다른 창에서 무슨 일이 일어났다 — 파일을 열었다, 또 나눴다, 세션을 옮겼다…
 *    스냅샷을 갈아 끼우는 모든 길이 `store.apply` 를 지나므로 기억은 거기서 한 번에 지워진다.
 * 2. 나눠 준 터미널이 자리를 옮겼다(`cd`) 또는 끝났다 — 여기의 `inheritForPane` 이 걸러낸다.
 *    화면이 든 스냅샷은 명령이 오갈 때만 갱신되므로 마지막 판정은 Rust 가 셸의 실시간 값으로
 *    한 번 더 한다(`commands::layout::pane_open_terminal`).
 */

import type { Pane } from '../state/types';

export interface PendingCwd {
  /** 분할로 갓 생긴 빈 블럭. 이 블럭에 터미널을 열 때만 쓰인다. */
  paneId: string;
  /** 나눠 준 터미널의 창 id. */
  sourceId: string;
  /** 나눌 때 그 터미널이 서 있던 폴더. */
  cwd: string;
}

/** 창이 살아 있는 터미널이고 폴더를 알려 준 적이 있으면 그 폴더. */
function knownCwd(pane: Pane | undefined): string | null {
  if (!pane || pane.kind !== 'term' || !pane.alive) return null;
  const cwd = pane.cwd?.trim();
  return cwd ? cwd : null;
}

/**
 * 분할 직후 기억해 둘 것. 나눠 준 창이 폴더를 알려 준 터미널일 때만 생긴다
 * (셸 통합이 없으면 폴더를 모르므로 물려줄 것도 없다).
 */
export function inheritFromSplit(
  panes: Pane[],
  sourceId: string,
  newPaneId: string,
): PendingCwd | null {
  const cwd = knownCwd(panes.find((p) => p.id === sourceId));
  return cwd ? { paneId: newPaneId, sourceId, cwd } : null;
}

/** 이 블럭에 터미널을 열 때 아직 유효한 기억. 아니면 `null` — 세션 폴더에서 뜬다. */
export function inheritForPane(
  panes: Pane[],
  pending: PendingCwd | null,
  paneId: string,
): PendingCwd | null {
  if (!pending || pending.paneId !== paneId) return null;
  // 그 사이 이 블럭에 무엇인가 열렸다면 물려줄 자리가 아니다.
  if (panes.find((p) => p.id === paneId)?.kind !== 'empty') return null;
  // 나눠 준 터미널이 끝났거나 폴더를 옮겼다.
  return knownCwd(panes.find((p) => p.id === pending.sourceId)) === pending.cwd ? pending : null;
}

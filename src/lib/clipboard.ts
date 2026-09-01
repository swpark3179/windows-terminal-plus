/**
 * 터미널과 시스템 클립보드 사이에서 오가는 글자를 다듬는 곳.
 *
 * 실제 클립보드 접근은 `ipc/bridge` 가 한다. 여기 있는 것은 전부 순수 함수라
 * 규칙 하나하나를 테스트로 못 박을 수 있다.
 */

/**
 * 한 번에 붙여넣을 수 있는 최대 글자 수.
 *
 * `pty_write` 는 동기 명령이고 그 끝의 `PtyHandle::write` 가 블로킹 `write_all` 이다.
 * stdin 을 빨아들이지 않는 프로그램에 수 MB 를 밀어 넣으면 창이 그대로 굳는다.
 */
export const MAX_PASTE_CHARS = 512 * 1024;

/** 괄호 붙여넣기(bracketed paste) 의 시작·끝 표식. */
const BRACKET_MARKERS = /\u001b\[20[01]~/g;

/**
 * 붙여넣기 전 정리.
 *
 * 표식을 지우는 것이 핵심이다 — 클립보드 안에 `ESC[201~` 가 들어 있으면 괄호 붙여넣기
 * 구간을 빠져나가 그 뒤가 **명령으로 실행된다.** xterm 의 `paste()` 는 이걸 지우지 않는다.
 * 개행은 셸이 받는 모양인 `\r` 로 통일한다.
 */
export function sanitizePasteText(raw: string): string {
  return raw
    .replace(/\u0000/g, '')
    .replace(BRACKET_MARKERS, '')
    .replace(/\r\n/g, '\r')
    .replace(/\n/g, '\r');
}

/**
 * 복사할 글자 정리.
 *
 * 줄 끝 공백은 터미널이 칸을 채우느라 생긴 것이라 지운다. 넓은 글자 사이의 NBSP 도 되돌린다.
 * **끝 개행은 남긴다** — 줄 전체를 골라 붙여넣으면 실행되는 것이 윈도우 터미널과 같은 동작이다.
 */
export function normalizeCopyText(raw: string): string {
  return raw.replace(/\u00a0/g, ' ').replace(/[ \t]+(?=\r?\n)/g, '');
}

/** "512 KB" 처럼 사람이 읽는 크기 문구. 토스트에 넣는다. */
export function describeSize(chars: number): string {
  if (chars < 1024) return `${chars}자`;
  if (chars < 1024 * 1024) return `${Math.round(chars / 1024)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

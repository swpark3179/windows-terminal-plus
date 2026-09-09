/**
 * 터미널이 준 글자를 앱 UI 에 옮길 때 거치는 문.
 *
 * 창 제목(OSC 0/2)이든 하이퍼링크 주소(OSC 8)든, 그 값을 정하는 것은 **터미널 안에서 도는
 * 프로그램**이다. `cat evil.bin` 한 번이면 아무 값이나 흘러나온다. 터미널 화면 안에서는 그것이
 * 문제가 아니지만(그저 글자다), 앱의 제목줄·툴팁으로 옮기는 순간 세 가지가 생긴다.
 *
 * - **제어문자** — 줄바꿈이나 CSI 가 낀 글자가 제목줄에 들어가면 배치가 깨진다.
 * - **방향 전환 문자** — `U+202E` 같은 것 하나로 보이는 순서가 뒤집힌다.
 *   `evil.tld/` 뒤에 그 문자와 `gnp.exe` 를 붙이면 `evil.tld/exe.png` 로 보인다.
 * - **길이** — xterm 의 OSC 페이로드 상한은 천만 글자다. 그대로 `title=` 속성에 넣을 수는 없다.
 */

/** 제목·주소를 화면에 보일 때의 길이 상한. 넘으면 뒤를 잘라 `…` 을 붙인다. */
export const MAX_TERM_TEXT = 160;

/**
 * 눈에 보이지 않으면서 **보이는 순서를 바꾸는** 문자들.
 *
 * `U+200E/200F` 는 좌우 표시, `U+202A~202E` 는 끼워넣기·덮어쓰기, `U+2066~2069` 는 격리다.
 * 하나라도 남으면 뒤에 오는 글자의 순서를 믿을 수 없다.
 */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** C0·C1 제어문자와 DEL. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * 터미널이 준 글자를 UI 에 실을 수 있는 한 줄로 다듬는다.
 *
 * 빈 문자열이 나오면(전부 제어문자였다면) 호출부가 원래 값을 그대로 두면 된다.
 */
export function sanitizeTerminalText(raw: string, max: number = MAX_TERM_TEXT): string {
  const flat = raw.replace(CONTROL, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // 자른 자리를 알 수 있게 표시한다 — 잘린 주소를 온전한 것으로 착각하지 않도록.
  return `${flat.slice(0, max - 1)}…`;
}

/**
 * 앱과 셸의 단축키 경계.
 *
 * 터미널에 포커스가 있을 때 여기서 true 인 조합만 앱이 가로채고, 나머지는 전부 PTY 로 간다.
 * 그래야 셸의 readline 편집(Ctrl+B/E/A/K …)이 살아 있다.
 * 디자인이 안내하는 Ctrl+B / Ctrl+E 는 터미널 밖에서 동작하고,
 * 터미널 안에서도 쓰고 싶을 때를 위해 Shift 를 더한 조합을 함께 받는다.
 */
export function appOwnsKey(e: KeyboardEvent): boolean {
  if (!e.ctrlKey) return false;
  const k = e.key.toLowerCase();
  if (e.shiftKey) return k === 'p' || k === 'b' || k === 'e';
  return k === ',' || k === 's' || k === '+' || k === '=' || k === '-' || k === '0';
}

/** 지금 포커스가 터미널 안에 있는가. */
export function terminalFocused(): boolean {
  const el = document.activeElement;
  return !!(el && el instanceof Element && el.closest('.term-body'));
}

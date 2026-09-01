/**
 * 앱과 셸의 단축키 경계.
 *
 * 터미널에 포커스가 있을 때 여기서 true 인 조합만 앱이 가로채고, 나머지는 전부 PTY 로 간다.
 * 그래야 셸의 readline 편집(Ctrl+B/E/A/K …)이 살아 있다.
 * 디자인이 안내하는 Ctrl+B / Ctrl+E 는 터미널 밖에서 동작하고,
 * 터미널 안에서도 쓰고 싶을 때를 위해 Shift 를 더한 조합을 함께 받는다.
 *
 * 복사·붙여넣기 조합은 **여기 넣지 않는다.** 선택 영역이 있는지 알아야 판정이 갈리므로
 * 터미널 안(`terminalKeyAction`)에서 풀고, 전역 처리기는 지금처럼 모르는 채로 둔다.
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

/**
 * 터미널 클립보드 조작.
 *
 * `copy-if-selection` 은 윈도우 터미널의 Ctrl+C 다 — 선택이 있으면 복사, 없으면 셸로 보내
 * 실행 중인 명령을 끊는다. 선택 여부는 이 함수가 알 수 없으므로 호출부가 판정한다.
 */
export type TerminalKeyAction = 'copy' | 'paste' | 'copy-if-selection' | null;

/** 이벤트에서 실제로 읽는 값만 추린 모양 — 테스트에서 평범한 객체로 부를 수 있다. */
export type KeyLike = Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export function terminalKeyAction(e: KeyLike): TerminalKeyAction {
  // 같은 처리기가 keypress·keyup 에도 불린다. 걸러 내지 않으면 한 번 누를 때 두 번 붙는다.
  if (e.type !== 'keydown') return null;
  // 윈도우에서 AltGr 은 ctrlKey + altKey 로 들어온다. 가로채면 그 자판의 문자 입력이 죽는다.
  if (e.altKey) return null;

  const k = e.key.toLowerCase();

  if (k === 'insert') {
    if (e.ctrlKey && !e.shiftKey) return 'copy';
    if (e.shiftKey && !e.ctrlKey) return 'paste';
    return null;
  }

  if (!e.ctrlKey) return null;
  if (e.shiftKey) return k === 'c' ? 'copy' : k === 'v' ? 'paste' : null;
  if (k === 'c') return 'copy-if-selection';
  if (k === 'v') return 'paste';
  return null;
}

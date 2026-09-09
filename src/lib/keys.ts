/**
 * 앱과 셸의 단축키 경계.
 *
 * 터미널에 포커스가 있을 때 여기서 true 인 조합만 앱이 가로채고, 나머지는 전부 PTY 로 간다.
 * 그래야 셸의 readline 편집(Ctrl+B/E/A/K …)이 살아 있다.
 * 디자인이 안내하는 Ctrl+B / Ctrl+E 는 터미널 밖에서 동작하고,
 * 터미널 안에서도 쓰고 싶을 때를 위해 Shift 를 더한 조합을 함께 받는다.
 * 전체화면 토글(Ctrl+Shift+F)은 터미널을 가득 채운 상태에서 되돌릴 길이 필요하므로
 * 반드시 앱이 가져간다. Shift 없는 Ctrl+F 는 readline 의 커서 이동이라 건드리지 않는다.
 * 새 세션(Ctrl+Shift+T)은 윈도우 터미널의 "새 탭" 과 같은 자리다. Shift 없는 Ctrl+T 는
 * readline 의 transpose-chars 라 그대로 셸에 넘긴다.
 *
 * 저장은 Ctrl+Shift+S 로 옮겼다. Shift 없는 Ctrl+S 는 터미널이 관찰할 수 있는 진짜 키다
 * (0x13 · XOFF · readline 의 정방향 검색)  — 앱이 가져가 버리면 셸에서 그 키가 죽는다.
 * 터미널 밖(에디터 패널)에서는 이 관문을 지나지 않으므로 Ctrl+S 가 그대로 듣는다.
 *
 * `Ctrl+Shift+<글자>` 는 xterm 이 어떤 바이트도 내보내지 않는 조합이라(`common/input/Keyboard.ts`
 * 의 ctrl 분기는 `!shiftKey` 를 요구한다) 셸에서 빼앗을 것이 없다. 그래서 앱·터미널 조작을
 * 여기에 모은다.
 *
 * 복사·붙여넣기 조합은 **여기 넣지 않는다.** 선택 영역이 있는지 알아야 판정이 갈리므로
 * 터미널 안(`terminalKeyAction`)에서 풀고, 전역 처리기는 지금처럼 모르는 채로 둔다.
 */
export function appOwnsKey(e: KeyboardEvent): boolean {
  if (!e.ctrlKey) return false;
  const k = keyName(e);
  if (e.shiftKey) {
    return k === 'p' || k === 'b' || k === 'e' || k === 'f' || k === 't' || k === 's';
  }
  return k === ',' || k === '+' || k === '=' || k === '-' || k === '0';
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
export type TerminalKeyAction =
  | 'copy'
  | 'paste'
  | 'copy-if-selection'
  | 'newline'
  | 'select-all'
  | 'clear'
  | null;

/** 이벤트에서 실제로 읽는 값만 추린 모양 — 테스트에서 평범한 객체로 부를 수 있다. */
export type KeyLike = Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey'> & {
  /** 물리 키(`KeyV`·`Insert` …). `key` 가 글자를 못 줄 때만 쓴다. */
  code?: string;
};

/**
 * 판정에 쓸 키 이름.
 *
 * 한글 입력 상태에서는 크로미움이 글자 대신 `'Process'`(그리고 `keyCode` 229)를 주는 일이 있어
 * `Ctrl+V` 가 통째로 새어 나간다 — `Shift+Insert` 는 `'Insert'` 라 IME 와 무관하게 늘 살아남는
 * 것과 대비된다. 그때만 **물리 키**로 되짚는다. 평소에는 `key` 를 그대로 쓴다 — 드보락처럼 자판이
 * 다르면 물리 키와 글자가 어긋나므로, 글자가 있을 때는 글자가 진실이다.
 */
function keyName(e: KeyLike): string {
  const k = e.key.toLowerCase();
  if (k !== 'process' && k !== 'unidentified') return k;
  switch (e.code) {
    case 'KeyC':
      return 'c';
    case 'KeyV':
      return 'v';
    case 'Insert':
      return 'insert';
    default:
      return k;
  }
}

export function terminalKeyAction(e: KeyLike): TerminalKeyAction {
  // 같은 처리기가 keypress·keyup 에도 불린다. 걸러 내지 않으면 한 번 누를 때 두 번 붙는다.
  if (e.type !== 'keydown') return null;
  // 윈도우에서 AltGr 은 ctrlKey + altKey 로 들어온다. 가로채면 그 자판의 문자 입력이 죽는다.
  if (e.altKey) return null;

  const k = keyName(e);

  if (k === 'insert') {
    if (e.ctrlKey && !e.shiftKey) return 'copy';
    if (e.shiftKey && !e.ctrlKey) return 'paste';
    return null;
  }

  // Shift+Enter · Ctrl+Enter — 그냥 Enter 는 VT 로 보면 CR 하나뿐이라 셸이 구분할 수 없다.
  // 무엇을 대신 보낼지는 `lib/win32Input.ts` 가 정한다 (ConPTY 가 청했으면 진짜 Shift+Enter
  // 키 이벤트, 아니면 순수 LF). 여기서는 "줄바꿈을 뜻하는 키" 라는 것만 가른다.
  if (k === 'enter' && (e.ctrlKey || e.shiftKey)) return 'newline';

  if (!e.ctrlKey) return null;
  if (e.shiftKey) {
    // 윈도우 터미널의 "모두 선택"·"버퍼 비우기". 셸이 볼 수 없는 조합이라 안전하게 가져간다.
    if (k === 'a') return 'select-all';
    if (k === 'k') return 'clear';
    return k === 'c' ? 'copy' : k === 'v' ? 'paste' : null;
  }
  if (k === 'c') return 'copy-if-selection';
  if (k === 'v') return 'paste';
  return null;
}

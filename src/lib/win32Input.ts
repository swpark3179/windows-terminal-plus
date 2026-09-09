/**
 * win32-input-mode — 윈도우 콘솔 앱에 **진짜 키 이벤트**를 보내는 길.
 *
 * ## 왜 필요한가
 *
 * ConPTY 는 우리가 보낸 VT 바이트를 `INPUT_RECORD` 로 되돌려 클라이언트에게 준다. 그 되돌리기가
 * 손실이 있다. 제어문자는 `VkKeyScanW` 로 되짚어 키를 찾는데(`InputStateMachineEngine.cpp` 의
 * `_GenerateKeyFromChar`), LF(`0x0a`)에 대응하는 키는 자판에 없다. 그래서 예전처럼 순수 LF 를
 * 보내면 클라이언트에게는 `Ctrl+J` 가 아니라 **가상 키와 수정자가 어긋난 이벤트**가 도착하고,
 * 그 뒤는 프로그램마다 다른 예비 경로에 맡겨진다. 윈도우에서 `codex` 의 줄바꿈이 되지 않던 자리다.
 *
 * 마이크로소프트가 이 문제(microsoft/terminal#4999, #530)를 위해 만든 것이 이 모드다. ConPTY 는
 * 부팅하자마자 `CSI ? 9001 h` 를 우리에게 보내 "키를 `INPUT_RECORD` 모양 그대로 달라" 고 청한다
 * (`src/host/VtIo.cpp` 의 `StartIfNeeded`). 우리가 알아듣고 아래 시퀀스로 답하면 ConPTY 가 되짚기를
 * **건너뛰고** 그 값을 그대로 `KEY_EVENT_RECORD` 로 만들어 클라이언트에게 넘긴다.
 *
 * ```
 *   ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
 *
 *   Vk: wVirtualKeyCode      Sc: wVirtualScanCode   Uc: UnicodeChar (10진수)
 *   Kd: bKeyDown (0/1)       Cs: dwControlKeyState  Rc: wRepeatCount (없으면 1)
 * ```
 * (`InputStateMachineEngine::_GenerateWin32Key` 의 인자 순서와 1:1 로 맞춰 두었다.)
 *
 * ## 왜 Shift+Enter 가 아니라 Ctrl+J 를 보내는가
 *
 * 이 자리에서 고를 수 있는 키가 여러 개인데, **클라이언트가 콘솔 레코드를 읽는지 VT 바이트를
 * 읽는지에 따라 결과가 갈린다.** 클라이언트가 `ENABLE_VIRTUAL_TERMINAL_INPUT` 을 켜 두면
 * (`wsl.exe`·`ssh.exe`, Node 의 `RAW_VT` 모드 등) conhost 가 레코드를 **다시 VT 로 번역해서**
 * 준다(`inputBuffer.cpp` 의 `if (vtInputMode) { _termInput.HandleKey(...) }`). 그 번역은
 * `UnicodeChar` 를 보지 않고 가상 키만 본다(`terminalInput.cpp` 의 `case VK_RETURN`).
 *
 * | 보내는 키 | 레코드를 읽는 쪽 (codex → crossterm) | VT 로 번역되는 쪽 |
 * | --- | --- | --- |
 * | Shift+Enter | `(Enter, SHIFT)` → 줄바꿈 ✓ | `\r` → **제출** ✗ |
 * | Ctrl+Enter · Ctrl+Shift+Enter | `(Enter, CTRL[, SHIFT])` → 아무것도 아님 ✗ | `\n` ✓ |
 * | Ctrl+M | `(Char('m'), CTRL)` → 줄바꿈 ✓ | `\r` → **제출** ✗ |
 * | **Ctrl+J** | `(Char('j'), CTRL)` → 줄바꿈 ✓ | `\n` ✓ |
 *
 * `Ctrl+J` 만 양쪽에서 줄바꿈이다.
 *
 * - **레코드를 읽는 쪽** (`codex` → crossterm): `VK_J` + `LEFT_CTRL_PRESSED` →
 *   `KeyEvent{ Char('j'), CONTROL }`. crossterm 은 특수 키가 아닌 가상 키에 대해
 *   `ToUnicodeEx(vk, sc, 수정자 없음)` 으로 "그 키의 맨 글자" 를 되찾으므로 `'j'` 가 나온다
 *   (`event/sys/windows/parse.rs` 의 `get_char_for_key`). 그것이 codex 의 줄바꿈 목록 첫 항목인
 *   `ctrl(Char('j'))` 다(`keymap.rs` 의 `editor.insert_newline`). 제출은 `plain(Enter)` 하나뿐이라
 *   (`chat_composer.rs` 의 `submit_keys`) 스칠 일이 없다.
 * - **VT 로 번역되는 쪽** (`wsl.exe`·`ssh.exe`, VT 입력을 켠 프로그램): `VK_J` 는 문자 키이고
 *   Ctrl 이 눌려 있으므로 그 제어문자 `0x0a` 가 나간다 — 예전과 **똑같은** 순수 LF 다.
 * - **레코드를 바이트로 펴는 쪽** (`claude` → Node/libuv 의 `RAW` 모드): `UnicodeChar` 가 0 이
 *   아니면 그 글자를 그대로 내보낸다(`uv_tty_read`). 여기에 LF 를 실어 두었으니 역시 LF 다.
 *
 * 그래서 어느 길로 가든 "줄바꿈" 이고, 어디에서도 제출로 바뀌지 않는다. 모드를 청하지 않은
 * 상대에게는(윈도우가 아닌 개발 환경 등) 예전 그대로 LF 한 바이트만 보낸다.
 */

/** ConPTY 가 켜 달라고 청하는 사설 모드 번호 (`CSI ? 9001 h` / `l`). */
export const WIN32_INPUT_MODE = 9001;

/** `dwControlKeyState` 비트 (winuser.h). */
export const LEFT_CTRL_PRESSED = 0x0008;

/** `wVirtualKeyCode` — 지금 쓰는 것만. */
export const VK_J = 0x4a;

/**
 * `J` 의 스캔 코드.
 *
 * crossterm 이 `ToUnicodeEx(vk, sc, …)` 에 그대로 넘기므로 가상 키와 짝이 맞아야 한다.
 * `0x24` 는 US 배열(한국어 윈도우의 라틴 배열도 같다)에서 `J` 자리이고, 실제로 `Ctrl+J` 를
 * 누르면 만들어지는 값이다 — 이 모드의 취지가 "진짜 키를 그대로" 이므로 진짜 값을 쓴다.
 */
export const SC_J = 0x24;

/** `KEY_EVENT_RECORD` 에서 우리가 채우는 값들. */
export interface Win32Key {
  /** `wVirtualKeyCode`. */
  vk: number;
  /** `wVirtualScanCode`. */
  sc: number;
  /** `UnicodeChar` 의 코드 포인트. 0 이면 "글자 없음". */
  ch: number;
  /** `bKeyDown`. */
  down: boolean;
  /** `dwControlKeyState`. */
  mods: number;
}

/** 키 하나를 win32-input-mode 시퀀스로. */
export function win32KeySequence(k: Win32Key): string {
  // `Rc`(반복 횟수)는 생략한다 — 빠지면 ConPTY 가 1 로 읽는다.
  return `\x1b[${k.vk};${k.sc};${k.ch};${k.down ? 1 : 0};${k.mods}_`;
}

const CTRL_J: Omit<Win32Key, 'down'> = {
  vk: VK_J,
  sc: SC_J,
  // LF — 레코드를 바이트로 펴는 쪽(Node 의 RAW 모드)이 받을 글자.
  ch: 0x0a,
  mods: LEFT_CTRL_PRESSED,
};

/**
 * "줄바꿈" — `Ctrl+J` 를 눌렀다 뗀 것.
 *
 * **뗌(key up)까지 보내야 한다.** conhost 는 앞뒤로 붙은 같은 눌림 레코드를 하나로 합치면서
 * `wRepeatCount` 만 올리는데(`inputBuffer.cpp` 의 `_CoalesceEvent`: `lastKey.bKeyDown &&
 * inKey.bKeyDown && 같은 스캔코드·글자·수정자` → `wRepeatCount += …`), crossterm 은
 * `wRepeatCount` 를 보지 않아 레코드 하나당 이벤트 하나만 만든다. 그러면 빠르게 두 번 누른
 * 줄바꿈이 한 번으로 삼켜진다. 사이에 뗌이 끼면 `lastKey.bKeyDown` 이 거짓이 되어 합쳐지지 않는다.
 *
 * 뗌 자체는 아무 데서도 글자를 만들지 않는다 — VT 번역은 뗌에서 곧바로 돌아가고
 * (`terminalInput.cpp` 의 `if (!key.keyDown)`), codex 는 `KeyEventKind::Release` 를 거르고,
 * libuv 는 뗌을 아예 무시한다(`uv_tty_read`).
 */
export const WIN32_NEWLINE =
  win32KeySequence({ ...CTRL_J, down: true }) + win32KeySequence({ ...CTRL_J, down: false });

/** 예전부터 쓰던 줄바꿈 — 순수 LF(= Ctrl+J 가 보내는 바이트). */
export const PLAIN_NEWLINE = '\n';

/**
 * 창별 모드 상태.
 *
 * xterm 인스턴스가 아니라 **PTY** 에 딸린 값이다. 세션을 오가면 xterm 은 사라졌다 다시 생기지만
 * 셸은 계속 살아 있고, ConPTY 는 부팅할 때 딱 한 번만 `CSI ? 9001 h` 를 보낸다. 그래서 창 id 로
 * 따로 기억해 둬야 세션을 다녀온 뒤에도 줄바꿈이 그대로 듣는다.
 * (창 id 는 재사용되지 않으므로 — 닫힌 창은 새 id 의 빈 블럭이 된다 — 지워 두지 않아도 샐 것이 없다.)
 */
const modes = new Map<string, boolean>();

export function setWin32InputMode(paneId: string, on: boolean): void {
  modes.set(paneId, on);
}

export function win32InputMode(paneId: string): boolean {
  return modes.get(paneId) === true;
}

/** 이 창에 보낼 줄바꿈 바이트. */
export function newlineSequence(paneId: string): string {
  return win32InputMode(paneId) ? WIN32_NEWLINE : PLAIN_NEWLINE;
}

/** 테스트 전용 — 창 사이에 상태가 새지 않게 한다. */
export function resetWin32InputModes(): void {
  modes.clear();
}

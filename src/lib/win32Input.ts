/**
 * win32-input-mode — 윈도우 콘솔 앱에 **진짜 키 이벤트**를 보내는 길.
 *
 * ## 왜 필요한가
 *
 * ConPTY 는 우리가 보낸 VT 바이트를 `INPUT_RECORD` 로 되돌려 클라이언트에게 준다. 그런데 VT 에는
 * Shift+Enter 를 나타낼 바이트가 없다 — 그냥 Enter 와 똑같은 CR 이다. 그래서 윈도우에서
 * `codex` 처럼 콘솔 API 로 키를 읽는 프로그램은 "제출" 과 "줄바꿈" 을 구분할 수 없었다.
 *
 * 마이크로소프트가 이 문제(microsoft/terminal#4999, #530)를 위해 만든 것이 이 모드다. ConPTY 는
 * 부팅하자마자 `CSI ? 9001 h` 를 우리에게 보내 "키를 `INPUT_RECORD` 모양 그대로 달라" 고 청한다
 * (`src/host/VtIo.cpp` 의 `StartIfNeeded`). 우리가 알아듣고 아래 시퀀스로 답하면 ConPTY 가 그것을
 * 그대로 `KEY_EVENT_RECORD` 로 복원해 클라이언트에게 넘긴다.
 *
 * ```
 *   ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
 *
 *   Vk: wVirtualKeyCode      Sc: wVirtualScanCode   Uc: UnicodeChar (10진수)
 *   Kd: bKeyDown (0/1)       Cs: dwControlKeyState  Rc: wRepeatCount (없으면 1)
 * ```
 * (`InputStateMachineEngine::_GenerateWin32Key` 의 인자 순서와 1:1 로 맞춰 두었다.)
 *
 * ## 왜 `UnicodeChar` 에 LF 를 싣는가
 *
 * 같은 키 하나가 성격이 다른 두 부류의 프로그램에 닿는다.
 *
 * - **콘솔 레코드를 그대로 읽는 쪽** (codex → crossterm): `wVirtualKeyCode` 를 본다.
 *   `VK_RETURN` → `KeyCode::Enter`, `SHIFT_PRESSED` → `KeyModifiers::SHIFT`
 *   (crossterm `event/sys/windows/parse.rs`). codex 안에서 그 이벤트는 **제출을 빗나가고
 *   줄바꿈에 맞는다** — 제출은 `plain(Enter)` 하나뿐이고(`chat_composer.rs` 의 `submit_keys`),
 *   줄바꿈 목록에는 `shift(Enter)` 가 있다(`keymap.rs` 의 `editor.insert_newline`). 둘을 견주는
 *   `normalize_key_parts` 는 `KeyCode::Char` 가 아닌 키의 수정자를 건드리지 않으므로
 *   `(Enter, SHIFT)` 가 `(Enter, NONE)` 과 같아질 길이 없다(`key_hint.rs`).
 * - **레코드를 다시 바이트로 펴는 쪽** (claude → Node/libuv, 그리고 `wsl.exe`·`ssh.exe`):
 *   `UnicodeChar` 가 0 이 아니면 그 글자를 그대로 내보낸다(`libuv` 의 `uv_tty_read`).
 *   여기에 LF(10)를 실어 두면 예전과 똑같이 순수 LF 가 흘러가 claude 의 줄바꿈이 유지된다.
 *
 * 그래서 한 시퀀스로 양쪽이 함께 산다. 모드가 켜지지 않은 곳(윈도우가 아닌 개발 환경 등)에서는
 * 예전 그대로 LF 한 바이트만 보낸다 — 청하지 않은 상대에게 win32 시퀀스를 들이밀지 않는다.
 *
 * LF 만 보내던 예전 방식이 윈도우에서 불안했던 까닭도 여기 있다. ConPTY 는 C0 제어문자를
 * `VkKeyScanW` 로 되짚어 키 이벤트를 만드는데(`InputStateMachineEngine::_GenerateKeyFromChar`),
 * `'\n'` 에 대응하는 키가 자판에 없다. 그래서 클라이언트에게는 `Enter`+`Shift` 가 아니라 가상 키와
 * 수정자가 어긋난 이벤트가 도착하고, 그 뒤는 프로그램마다 다른 예비 경로에 맡겨진다. 이 모드는
 * 그 되짚기를 아예 건너뛰고 **의도한 키 이벤트를 그대로** 전한다.
 */

/** ConPTY 가 켜 달라고 청하는 사설 모드 번호 (`CSI ? 9001 h` / `l`). */
export const WIN32_INPUT_MODE = 9001;

/** `dwControlKeyState` 비트 (winuser.h). */
export const SHIFT_PRESSED = 0x0010;
export const LEFT_CTRL_PRESSED = 0x0008;

/** `wVirtualKeyCode` — 지금 쓰는 것만. */
export const VK_RETURN = 0x0d;

/** Enter 의 스캔 코드 — `MapVirtualKeyW(VK_RETURN, MAPVK_VK_TO_VSC)`. */
export const SC_RETURN = 0x1c;

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

/**
 * "줄바꿈" — Shift+Enter 눌림 하나.
 *
 * 뗌(key up)은 보내지 않는다. 콘솔 클라이언트는 관례적으로 `bKeyDown` 을 확인하고 뗌을 버리지만
 * (codex 는 `KeyEventKind::Release` 를 거르고, libuv 는 아예 무시한다), 확인하지 않는 프로그램에
 * 두 번 들어가는 쪽이 한 번도 안 들어가는 쪽보다 나쁘다. Enter 의 뗌을 기다리는 프로그램은 없다.
 */
export const WIN32_NEWLINE = win32KeySequence({
  vk: VK_RETURN,
  sc: SC_RETURN,
  // LF — 레코드를 바이트로 펴는 쪽(claude·wsl·ssh)이 받을 글자.
  ch: 0x0a,
  down: true,
  mods: SHIFT_PRESSED,
});

/** 예전부터 쓰던 줄바꿈 — 순수 LF(= Ctrl+J 가 보내는 바이트). */
export const PLAIN_NEWLINE = '\n';

/**
 * 창별 모드 상태.
 *
 * xterm 인스턴스가 아니라 **PTY** 에 딸린 값이다. 세션을 오가면 xterm 은 사라졌다 다시 생기지만
 * 셸은 계속 살아 있고, ConPTY 는 부팅할 때 딱 한 번만 `CSI ? 9001 h` 를 보낸다. 그래서 창 id 로
 * 따로 기억해 둬야 세션을 다녀온 뒤에도 Shift+Enter 가 그대로 듣는다.
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

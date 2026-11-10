import { beforeEach, describe, expect, it } from 'vitest';

import {
  WIN32_ESCAPE,
  inputSequence,
  resetWin32InputModes,
  setWin32InputMode,
} from './win32Input';

const PANE = 'p-1';

/** 눌림·뗌 한 쌍. `[vk, sc, ch, mods]`. */
function pair(vk: number, sc: number, ch: number, mods: number): string {
  return `\x1b[${vk};${sc};${ch};1;${mods}_\x1b[${vk};${sc};${ch};0;${mods}_`;
}

const ALT = 0x02;
const SHIFT = 0x10;

beforeEach(() => {
  resetWin32InputModes();
});

describe('inputSequence', () => {
  it('ConPTY 가 청하지 않았으면 무엇이든 그대로 보낸다', () => {
    for (const d of ['\x1b', '\x1b[', 'a', '\x03']) {
      expect(inputSequence(PANE, d)).toBe(d);
    }
  });

  it('Esc 는 VK_ESCAPE 를 눌렀다 뗀 것으로 — 맨 ESC 는 ConPTY 가 잘린 시퀀스로 보고 붙잡는다', () => {
    setWin32InputMode(PANE, true);
    expect(WIN32_ESCAPE).toBe('\x1b[27;1;27;1;0_\x1b[27;1;27;0;0_');
    expect(inputSequence(PANE, '\x1b')).toBe(WIN32_ESCAPE);
  });

  it('ESC 뒤 한 글자가 새 시퀀스를 여는 Alt 조합도 레코드로 — 그대로 두면 파서가 열린 채 남는다', () => {
    setWin32InputMode(PANE, true);
    expect(inputSequence(PANE, '\x1b\x1b')).toBe(pair(0x1b, 0x01, 0x1b, ALT));
    expect(inputSequence(PANE, '\x1b[')).toBe(pair(0xdb, 0x1a, 0x5b, ALT));
    expect(inputSequence(PANE, '\x1b]')).toBe(pair(0xdd, 0x1b, 0x5d, ALT));
    expect(inputSequence(PANE, '\x1bO')).toBe(pair(0x4f, 0x18, 0x4f, ALT | SHIFT));
    expect(inputSequence(PANE, '\x1bP')).toBe(pair(0x50, 0x19, 0x50, ALT | SHIFT));
    expect(inputSequence(PANE, '\x1bX')).toBe(pair(0x58, 0x2d, 0x58, ALT | SHIFT));
    expect(inputSequence(PANE, '\x1b^')).toBe(pair(0x36, 0x07, 0x5e, ALT | SHIFT));
    expect(inputSequence(PANE, '\x1b_')).toBe(pair(0xbd, 0x0c, 0x5f, ALT | SHIFT));
  });

  it('닫힌 채 끝나는 입력은 한 바이트도 바꾸지 않는다', () => {
    setWin32InputMode(PANE, true);
    const untouched = [
      'a',
      '가',
      '\r',
      '\x03', // Ctrl+C — ConPTY 의 Ctrl+C 전용 길을 타는 지금 모양 그대로
      '\x7f',
      '\x1b[A', // 방향키
      '\x1bOA', // 응용 커서 모드의 방향키
      '\x1b[15~', // F5
      '\x1bb', // Alt+B
      '\x1b.', // Alt+. (readline 의 yank-last-arg)
      '\x1bo', // 소문자 Alt+O 는 그 자리에서 닫힌다
      '\x1b[I', // 포커스 보고
      '\x1b[O',
      '\x1b[?1;2c', // DA 응답
      '\x1b[12;40R', // 커서 위치 응답
      '\x1b[<0;10;5M', // 마우스 보고
      '\x1b[200~\x1b\x1b[201~', // 괄호 붙여넣기 — ESC 가 들어 있어도 통째로 일치하지 않는다
    ];
    for (const d of untouched) {
      expect(inputSequence(PANE, d)).toBe(d);
    }
  });

  it('모드는 창마다 따로다', () => {
    setWin32InputMode(PANE, true);
    expect(inputSequence('p-2', '\x1b')).toBe('\x1b');
    setWin32InputMode(PANE, false);
    expect(inputSequence(PANE, '\x1b')).toBe('\x1b');
  });
});

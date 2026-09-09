import { describe, expect, it } from 'vitest';

import { MAX_TERM_TEXT, sanitizeTerminalText } from './termText';

describe('sanitizeTerminalText', () => {
  it('평범한 글자는 그대로 둔다', () => {
    expect(sanitizeTerminalText('pwsh · C:\\work\\rterm')).toBe('pwsh · C:\\work\\rterm');
    expect(sanitizeTerminalText('claude — 한글도 그대로')).toBe('claude — 한글도 그대로');
  });

  it('제어문자를 빈칸으로 바꿔 한 줄로 만든다 — 제목줄 배치가 깨지면 안 된다', () => {
    expect(sanitizeTerminalText('두\n줄\r짜리')).toBe('두 줄 짜리');
    expect(sanitizeTerminalText('앞\u0000뒤')).toBe('앞 뒤');
    // C1 영역(8비트 CSI 등)도 같이 걸린다.
    expect(sanitizeTerminalText('x\u009bmy')).toBe('x my');
  });

  it('이어진 빈칸은 하나로 접고 앞뒤는 다듬는다', () => {
    expect(sanitizeTerminalText('  가운데   빈칸  ')).toBe('가운데 빈칸');
  });

  it('방향 전환 문자를 지운다 — 보이는 순서를 뒤집는 눈속임을 막는다', () => {
    // U+202E 하나로 `…/gnp.exe` 가 `…/exe.png` 로 보인다.
    expect(sanitizeTerminalText('evil.tld/\u202egnp.exe')).toBe('evil.tld/gnp.exe');
    for (const ch of ['\u200e', '\u200f', '\u202a', '\u202d', '\u2066', '\u2069']) {
      expect(sanitizeTerminalText(`a${ch}b`)).toBe('ab');
    }
  });

  it('너무 긴 값은 자르고 잘렸다는 것을 남긴다', () => {
    const long = 'x'.repeat(MAX_TERM_TEXT * 2);
    const out = sanitizeTerminalText(long);
    expect(out).toHaveLength(MAX_TERM_TEXT);
    expect(out.endsWith('…')).toBe(true);
    // 상한을 직접 줄 수도 있다.
    expect(sanitizeTerminalText('abcdef', 3)).toBe('ab…');
  });

  it('알맹이가 없으면 빈 문자열 — 호출부가 원래 값을 지키게 한다', () => {
    expect(sanitizeTerminalText('\u0000\u0001 \u202e')).toBe('');
    expect(sanitizeTerminalText('')).toBe('');
  });
});

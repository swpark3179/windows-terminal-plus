import { describe, expect, it } from 'vitest';

import { describeSize, normalizeCopyText, sanitizePasteText } from './clipboard';

const ESC = '\u001b';
const NUL = '\u0000';
const NBSP = '\u00a0';

describe('sanitizePasteText', () => {
  it('개행을 셸이 받는 CR 로 통일한다', () => {
    expect(sanitizePasteText('a\r\nb\nc')).toBe('a\rb\rc');
    expect(sanitizePasteText('한\r\n글')).toBe('한\r글');
  });

  it('NUL 을 버린다', () => {
    expect(sanitizePasteText(`a${NUL}b`)).toBe('ab');
  });

  it('괄호 붙여넣기 표식을 지운다 — 없으면 뒤가 명령으로 실행된다', () => {
    expect(sanitizePasteText(`echo hi${ESC}[201~rm -rf /`)).toBe('echo hirm -rf /');
    expect(sanitizePasteText(`${ESC}[200~payload${ESC}[201~`)).toBe('payload');
  });

  it('두 번 걸러도 결과가 같다', () => {
    const once = sanitizePasteText(`a\r\nb${ESC}[201~c`);
    expect(sanitizePasteText(once)).toBe(once);
  });
});

describe('normalizeCopyText', () => {
  it('줄 끝 공백을 지운다 — 터미널이 칸을 채우느라 생긴 것이다', () => {
    expect(normalizeCopyText('ls -al   \ncd ..\t\n')).toBe('ls -al\ncd ..\n');
  });

  it('NBSP 를 보통 공백으로 되돌린다', () => {
    expect(normalizeCopyText(`git${NBSP}status`)).toBe('git status');
  });

  it('끝 개행은 남긴다 — 줄 전체를 골라 붙여넣으면 실행되는 것이 맞다', () => {
    expect(normalizeCopyText('pnpm test\n')).toBe('pnpm test\n');
  });
});

describe('describeSize', () => {
  it('크기에 따라 단위를 바꾼다', () => {
    expect(describeSize(12)).toBe('12자');
    expect(describeSize(2048)).toBe('2 KB');
    expect(describeSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

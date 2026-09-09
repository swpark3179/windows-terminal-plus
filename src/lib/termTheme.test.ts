/**
 * 배색이 읽을 수 있는 상태로 남아 있는지 검사한다.
 *
 * 색은 취향의 문제라 값 자체를 고정해 두면 손볼 때마다 테스트를 고치게 된다. 그래서 값이 아니라
 * **규칙**을 고정한다 — 배경 대비, 보통색과 밝은색의 구분, CSS 와의 일치.
 */

import { describe, expect, it } from 'vitest';

import {
  ANSI_PAIRS,
  TERM_THEME,
  WORD_SEPARATOR,
  contrastRatio,
  relativeLuminance,
} from './termTheme';

const BG = TERM_THEME.background!;

/** 검정을 뺀 모든 글자색 — 이들은 본문으로 읽히므로 AA 를 넘어야 한다. */
const READABLE = [
  'foreground',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

describe('대비 계산', () => {
  it('WCAG 의 알려진 값과 맞는다', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#000000')).toBeCloseTo(1, 5);
    // 순서를 바꿔도 같은 값이어야 한다.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#777777'),
      10,
    );
    // 회색 #767676 위 흰색은 널리 알려진 4.54:1 경계다.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });
});

describe('터미널 배색', () => {
  it('본문으로 읽히는 색은 모두 WCAG AA(4.5:1) 를 넘는다', () => {
    for (const key of READABLE) {
      const color = TERM_THEME[key] as string;
      expect(contrastRatio(color, BG), `${key} (${color})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('검정은 배경과 구분되기만 한다 — 여기서 AA 를 요구하면 검정이 아니게 된다', () => {
    const ratio = contrastRatio(TERM_THEME.black as string, BG);
    expect(ratio).toBeGreaterThan(1.3);
    expect(ratio).toBeLessThan(2.5);
  });

  it('밝은색은 보통색보다 눈에 띄게 밝다 — 굵은 글자가 밝은색으로 그려지기 때문이다', () => {
    for (const [normal, bright] of ANSI_PAIRS) {
      const n = relativeLuminance(TERM_THEME[normal] as string);
      const b = relativeLuminance(TERM_THEME[bright] as string);
      expect(b / n, `${normal} → ${bright}`).toBeGreaterThanOrEqual(1.4);
    }
  });

  it('보통색 흰색과 본문색은 같고, 밝은 흰색은 그보다 밝다', () => {
    // 예전 배색은 white 와 foreground 가 같으면서 brightWhite 도 거의 같아, SGR 1 이 보이지 않았다.
    expect(TERM_THEME.white).toBe(TERM_THEME.foreground);
    expect(relativeLuminance(TERM_THEME.brightWhite as string)).toBeGreaterThan(
      relativeLuminance(TERM_THEME.white as string) * 1.4,
    );
  });

  it('선택 영역은 보이면서 그 위의 글자도 읽힌다', () => {
    const sel = TERM_THEME.selectionBackground as string;
    const inactive = TERM_THEME.selectionInactiveBackground as string;
    // 배경과 구분돼야 "골랐다" 는 것이 보인다.
    expect(contrastRatio(sel, BG)).toBeGreaterThan(1.5);
    expect(contrastRatio(inactive, BG)).toBeGreaterThan(1.25);
    // 그러면서 본문이 그 위에서 읽혀야 한다.
    expect(contrastRatio(TERM_THEME.foreground as string, sel)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(TERM_THEME.foreground as string, inactive)).toBeGreaterThanOrEqual(4.5);
  });

  it('커서는 배경 위에서 또렷하고, 커서 안쪽 글자는 배경색이다', () => {
    expect(contrastRatio(TERM_THEME.cursor as string, BG)).toBeGreaterThanOrEqual(4.5);
    expect(TERM_THEME.cursorAccent).toBe(BG);
  });

  it('CSS 와 나눠 쓰는 두 색은 문서에 적힌 값 그대로다', () => {
    // 이 두 값은 `styles/app.css` 의 `--term-bg` · `--bg` 와 같아야 한다. 한쪽만 고치면 창 여백과
    // 스크롤 막대가 본문과 다른 색이 되므로, 양쪽 파일에 서로를 가리키는 주석을 두고 값은 여기서
    // 못 박는다 (vitest 는 CSS 를 비워 두고 넘겨서 파일을 읽어 견줄 수가 없다).
    expect(BG).toBe('#1b1a18');
    expect(TERM_THEME.brightWhite).toBe('#faf9f5');
  });
});

describe('낱말 경계', () => {
  it('경로·플래그를 조각으로 고를 수 있게 한다 — xterm 기본값은 통째로 잡는다', () => {
    for (const ch of ['/', '\\', '-', '=', ':', '.', ',', '|']) {
      expect(WORD_SEPARATOR, `구분자에 ${ch} 가 있어야 한다`).toContain(ch);
    }
    // xterm 기본값에 있던 것들도 그대로 남아 있어야 한다.
    for (const ch of [' ', '(', ')', '[', ']', '{', '}', "'", '"']) {
      expect(WORD_SEPARATOR).toContain(ch);
    }
  });

  it('낱말을 이루는 글자는 경계가 아니다', () => {
    for (const ch of ['a', 'Z', '0', '_', '가']) {
      expect(WORD_SEPARATOR).not.toContain(ch);
    }
  });
});

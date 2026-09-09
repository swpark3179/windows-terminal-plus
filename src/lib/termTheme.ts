/**
 * 터미널 배색과 낱말 경계.
 *
 * 값만 있는 모듈이 아니라 **규칙이 있는 모듈**이다 — 색을 손볼 때 읽을 수 없게 되는 일을 막도록
 * 대비 계산을 함께 두고, `termTheme.test.ts` 가 모든 항목을 검사한다.
 */

import type { ITheme } from '@xterm/xterm';

/**
 * 터미널 색상 — 윈도우 터미널의 기본 배색(Campbell)을 이 앱의 따뜻한 톤으로 옮긴 것.
 *
 * 예전 배색은 대비는 넉넉했지만 **보통색과 밝은색이 거의 같았다**(밝기 차 1.15~1.35배).
 * xterm 은 굵은 글자를 밝은색으로 그리므로(`drawBoldTextInBrightColors` 기본값 true)
 * 굵게·밝게가 화면에서 구분되지 않았고, `white` 와 `foreground` 가 같은 값이라 밝은 흰색도
 * 눈에 띄지 않았다. Campbell 을 그대로 옮겨 오는 것도 답이 아니다 — 이 배경(#1b1a18) 위에서
 * 빨강 2.9:1 · 파랑 2.1:1 · 자주 2.2:1 로 읽을 수 없다.
 *
 * 그래서 **색상(hue)은 Campbell 을, 밝기는 대비로** 정했다. OKLCH 에서 색상마다 sRGB 안에서
 * 낼 수 있는 가장 선명한 색을 고르고, 보통색은 배경 대비 5.2:1, 밝은색은 8:1(노란색만 6.7/9.8)에
 * 맞췄다. 전부 WCAG AA(4.5:1)를 넘고 보통색→밝은색 밝기 차는 1.5배 이상이다.
 * 검정만 예외로 1.6:1 — 배경과 구분되기만 하면 된다.
 *
 * 배경은 CSS 의 `--term-bg` 와 **같은 값이어야 한다** (테스트가 두 파일을 견준다).
 */
export const TERM_THEME: ITheme = {
  background: '#1b1a18', // = --term-bg
  foreground: '#cfccc6', // 10.9:1 — Campbell 의 #CCCCCC 에 대응하는 따뜻한 회색
  cursor: '#d99b74', //  7.4:1 — = --term-accent
  cursorAccent: '#1b1a18', //         커서 안쪽 글자색
  selectionBackground: '#4a4138', //  선택 위에서 본문은 6.3:1
  // 우클릭 메뉴가 포커스를 가져가도 선택 영역이 보여야 한다 (xterm 기본값은 회색이라 튄다).
  selectionInactiveBackground: '#3b342c',
  black: '#413c34', //  1.6:1
  red: '#ef5b57', //  5.2:1
  green: '#40a037', //  5.2:1
  yellow: '#c79a2c', //  6.7:1
  blue: '#458eeb', //  5.2:1
  magenta: '#cb66c9', //  5.2:1
  cyan: '#2a9ba0', //  5.2:1
  white: '#cfccc6', // 10.9:1 — = foreground
  brightBlack: '#8a8478', //  4.7:1 — 흐린 글자(주석·힌트)가 여기로 온다
  brightRed: '#f39890', //  8.0:1
  brightGreen: '#52c847', //  8.0:1
  brightYellow: '#e8bd48', //  9.8:1
  brightBlue: '#84b3f1', //  8.0:1
  brightMagenta: '#e396e0', //  8.0:1
  brightCyan: '#37c2c8', //  8.0:1
  brightWhite: '#faf9f5', // 16.5:1 — = --bg
  // 선택한 글자색은 지정하지 않는다 — 골라도 원래 색이 그대로 보여야 한다.
  // 16~255 번은 xterm 의 기본 256색 큐브를 쓴다 (extendedAnsi 미지정).
};

/**
 * 낱말 단위 선택(더블클릭)의 경계 문자.
 *
 * xterm 기본값은 `` ' ()[]{}\'"` ' `` 뿐이라 `--flag=value` 나 `C:\a\b` 를 한 낱말로 잡는다.
 * 윈도우 터미널의 `wordDelimiters` 기본값을 그대로 가져와 경로·플래그·URL 을 조각으로 고르게 한다.
 * (`src/cascadia/TerminalSettingsModel/defaults.json` 의 `wordDelimiters`.)
 */
export const WORD_SEPARATOR = ' /\\()"\'-.,:;<>~!@#$%^&*|+=[]{}~?\u2502';

/** `#rrggbb` → 0~255 세 값. */
function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 상대 휘도. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 명도 대비 (1~21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 보통색과 그에 대응하는 밝은색 짝. 굵게/밝게가 구분되는지 보는 데 쓴다. */
export const ANSI_PAIRS = [
  ['black', 'brightBlack'],
  ['red', 'brightRed'],
  ['green', 'brightGreen'],
  ['yellow', 'brightYellow'],
  ['blue', 'brightBlue'],
  ['magenta', 'brightMagenta'],
  ['cyan', 'brightCyan'],
  ['white', 'brightWhite'],
] as const satisfies readonly (readonly [keyof ITheme, keyof ITheme])[];

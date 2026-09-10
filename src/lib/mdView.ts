/**
 * 마크다운 뷰어의 표시 설정 — 테마 · 글꼴 · 목차 · 본문 폭.
 *
 * 이 값들은 **문서가 아니라 읽는 사람**에게 속한다. 창마다 다르게 두면 문서를 옮겨 다닐 때마다
 * 다시 맞춰야 하고, Rust 스냅샷에 넣으면 레이아웃 · 셸 버퍼와 같은 무게로 취급된다.
 * 그래서 브라우저 저장소에 앱 전체 설정 한 벌로 둔다 (참고 저장소 `markdown-viewer` 와 같은 선택).
 */

import type { MdFont, MdPrefs, MdTheme } from '../state/types';

const KEY = 'rterm-md-view-v1';

export const MD_PREFS_DEFAULT: MdPrefs = {
  theme: 'light',
  font: 'sans',
  toc: false,
  narrow: true,
};

/** 뷰어 본문 글꼴 — 이름과 실제 스택. 셋 다 앱이 번들로 들고 있는 얼굴에서 고른다. */
export const MD_FONTS: { key: MdFont; label: string; stack: string }[] = [
  {
    key: 'sans',
    label: '산세리프',
    stack: "'Roboto', 'Noto Sans KR', system-ui, sans-serif",
  },
  {
    key: 'serif',
    label: '세리프',
    stack: "Georgia, 'Times New Roman', 'Noto Sans KR', serif",
  },
  {
    key: 'mono',
    label: '고정폭',
    stack: "'Cascadia Mono', 'Noto Sans Mono', 'Noto Sans KR', monospace",
  },
];

export function fontStack(font: MdFont): string {
  return (MD_FONTS.find((f) => f.key === font) ?? MD_FONTS[0]).stack;
}

/** 저장된 값 중 우리가 아는 것만 받아들인다 — 손으로 고친 저장소가 화면을 깨지 못하게. */
export function normalisePrefs(raw: unknown): MdPrefs {
  if (!raw || typeof raw !== 'object') return { ...MD_PREFS_DEFAULT };
  const v = raw as Partial<Record<keyof MdPrefs, unknown>>;
  const themes: MdTheme[] = ['light', 'dark'];
  const fonts: MdFont[] = MD_FONTS.map((f) => f.key);
  return {
    theme: themes.includes(v.theme as MdTheme) ? (v.theme as MdTheme) : MD_PREFS_DEFAULT.theme,
    font: fonts.includes(v.font as MdFont) ? (v.font as MdFont) : MD_PREFS_DEFAULT.font,
    toc: typeof v.toc === 'boolean' ? v.toc : MD_PREFS_DEFAULT.toc,
    narrow: typeof v.narrow === 'boolean' ? v.narrow : MD_PREFS_DEFAULT.narrow,
  };
}

/** 저장소를 읽을 수 없는 환경(테스트 · 사생활 보호 모드)에서도 기본값으로 살아남는다. */
export function loadPrefs(): MdPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return normalisePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...MD_PREFS_DEFAULT };
  }
}

export function savePrefs(prefs: MdPrefs): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // 저장하지 못해도 이번 실행 동안은 화면 상태가 살아 있다.
  }
}

/** 상태바에 띄우는 문서 크기 — 참고 저장소의 `docStats`. */
export function docStats(source: string): string {
  const lines = source ? source.split('\n').length : 0;
  const words = source.split(/\s+/).filter(Boolean).length;
  return `${lines}줄 · ${words}단어 · ${source.length.toLocaleString()}자`;
}

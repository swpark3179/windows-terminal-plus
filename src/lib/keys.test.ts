import { describe, expect, it } from 'vitest';

import { appOwnsKey, terminalKeyAction, type KeyLike } from './keys';

function key(over: Partial<KeyLike>): KeyLike {
  return { type: 'keydown', key: 'a', ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

describe('terminalKeyAction', () => {
  it('Ctrl+Shift+C 와 Ctrl+Insert 는 복사다', () => {
    expect(terminalKeyAction(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe('copy');
    expect(terminalKeyAction(key({ key: 'Insert', ctrlKey: true }))).toBe('copy');
  });

  it('Ctrl+Shift+V 와 Shift+Insert 는 붙여넣기다', () => {
    expect(terminalKeyAction(key({ key: 'V', ctrlKey: true, shiftKey: true }))).toBe('paste');
    expect(terminalKeyAction(key({ key: 'Insert', shiftKey: true }))).toBe('paste');
  });

  it('Ctrl+C 는 선택 여부에 맡기고 Ctrl+V 는 바로 붙여넣는다', () => {
    expect(terminalKeyAction(key({ key: 'c', ctrlKey: true }))).toBe('copy-if-selection');
    expect(terminalKeyAction(key({ key: 'v', ctrlKey: true }))).toBe('paste');
  });

  it('keydown 이 아니면 아무것도 하지 않는다 — 한 번 눌러 두 번 붙는 것을 막는다', () => {
    expect(terminalKeyAction(key({ type: 'keyup', key: 'v', ctrlKey: true }))).toBeNull();
    expect(terminalKeyAction(key({ type: 'keypress', key: 'c', ctrlKey: true }))).toBeNull();
  });

  it('AltGr(Ctrl+Alt) 는 넘긴다 — 그 자판의 문자 입력을 뺏으면 안 된다', () => {
    expect(terminalKeyAction(key({ key: 'v', ctrlKey: true, altKey: true }))).toBeNull();
    expect(terminalKeyAction(key({ key: 'c', ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull();
  });

  it('그 밖의 조합은 건드리지 않는다', () => {
    expect(terminalKeyAction(key({ key: 'c' }))).toBeNull();
    expect(terminalKeyAction(key({ key: 'x', ctrlKey: true }))).toBeNull();
    expect(terminalKeyAction(key({ key: 'b', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(terminalKeyAction(key({ key: 'Insert', ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('appOwnsKey', () => {
  // 전역 처리기(App.tsx)의 관문은 그대로여야 한다. 여기에 c/v 가 끼면 앱이 처리하지도 않을
  // 키에 대해 관문이 열려 버린다.
  it('클립보드 조합은 여전히 앱의 것이 아니다', () => {
    for (const k of ['c', 'v']) {
      expect(appOwnsKey({ ctrlKey: true, shiftKey: false, key: k } as KeyboardEvent)).toBe(false);
      expect(appOwnsKey({ ctrlKey: true, shiftKey: true, key: k } as KeyboardEvent)).toBe(false);
    }
  });

  it('기존 조합은 그대로 가져간다', () => {
    expect(appOwnsKey({ ctrlKey: true, shiftKey: true, key: 'p' } as KeyboardEvent)).toBe(true);
    expect(appOwnsKey({ ctrlKey: true, shiftKey: false, key: 's' } as KeyboardEvent)).toBe(true);
  });
});

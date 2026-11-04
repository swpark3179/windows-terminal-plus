import { act, cleanup, render } from '@testing-library/react';
import { createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_MS, motionAllowed, playExit, useExitMotion } from './motion';

/** `prefers-reduced-motion` 답을 정해 둔 `matchMedia`. jsdom 에는 아예 없다. */
function stubMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({ matches: reduce && q.includes('reduce'), media: q }) as MediaQueryList),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.querySelectorAll('[data-exit]').forEach((n) => n.remove());
});

describe('motionAllowed', () => {
  it('판정할 수 없으면 모션을 쓰지 않는다 — 모션은 덤이다', () => {
    expect(motionAllowed()).toBe(false);
  });

  it('모션을 줄여 달라고 했으면 쓰지 않는다', () => {
    stubMotion(true);
    expect(motionAllowed()).toBe(false);
    stubMotion(false);
    expect(motionAllowed()).toBe(true);
  });
});

describe('playExit', () => {
  it('보이는 모습만 복제해 잠깐 남기고, 클릭도 포커스도 받지 않는다', () => {
    vi.useFakeTimers();
    stubMotion(false);
    const node = document.createElement('div');
    node.className = 'menu';
    node.innerHTML = '<input id="new-session-name" value="">';
    node.querySelector('input')!.value = '분할';

    const ghost = playExit(node)!;

    expect(ghost.parentNode).toBe(document.body);
    expect(ghost).toHaveClass('menu');
    expect(ghost).toHaveAttribute('data-exit');
    expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(ghost.style.pointerEvents).toBe('none');
    expect(ghost.querySelector('input')!.value).toBe('분할');
    expect(ghost.querySelector('[id]')).toBeNull();

    vi.advanceTimersByTime(EXIT_MS);
    expect(ghost.isConnected).toBe(false);
  });

  it('모션을 줄였으면 아무것도 남기지 않는다', () => {
    stubMotion(true);
    expect(playExit(document.createElement('div'))).toBeNull();
    expect(document.querySelector('[data-exit]')).toBeNull();
  });
});

describe('useExitMotion', () => {
  function Overlay({ initial }: { initial: string | null }) {
    const [text, setText] = useState(initial);
    const ref = useExitMotion<HTMLDivElement>();
    (Overlay as unknown as { set: (v: string | null) => void }).set = setText;
    return text ? createElement('div', { key: text, ref, className: 'toast' }, text) : null;
  }
  const set = (v: string | null) =>
    act(() => (Overlay as unknown as { set: (v: string | null) => void }).set(v));

  it('닫힐 때 옛 노드로 퇴장 모션을 돌린다', () => {
    stubMotion(false);
    render(createElement(Overlay, { initial: '저장됨' }));
    set(null);
    const ghosts = document.querySelectorAll('[data-exit]');
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toHaveTextContent('저장됨');
  });

  it('다시 그리기만 할 때는 돌리지 않는다', () => {
    stubMotion(false);
    const view = render(createElement(Overlay, { initial: '저장됨' }));
    view.rerender(createElement(Overlay, { initial: '저장됨' }));
    expect(document.querySelector('[data-exit]')).toBeNull();
  });

  it('새 내용으로 갈아 끼워지면 옛 것이 빠지며 새 것이 들어온다', () => {
    stubMotion(false);
    render(createElement(Overlay, { initial: '좌·우로 분할' }));
    set('위·아래로 분할');
    expect(document.querySelector('[data-exit]')).toHaveTextContent('좌·우로 분할');
  });
});

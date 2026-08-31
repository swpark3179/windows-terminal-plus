/**
 * 한글(IME) 입력 회귀 테스트.
 *
 * 예전에는 타자마다 값을 Rust 로 보내고 돌아온 스냅샷을 그대로 `value` 로 되먹였다.
 * 그러면 조합 도중 React 가 입력창을 덮어써서 커서가 맨 뒤로 튄다.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextField } from './TextField';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const tick = (ms = 300) => act(() => void vi.advanceTimersByTime(ms));

describe('TextField', () => {
  it('조합이 끝나기 전에는 바깥으로 보내지 않는다', () => {
    const onCommit = vi.fn();
    const { container } = render(<TextField value="" onCommit={onCommit} />);
    const input = container.querySelector('input')!;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'ㅎ' } });
    fireEvent.change(input, { target: { value: '하' } });
    fireEvent.change(input, { target: { value: '한' } });
    tick();

    // 중간 글자(ㅎ, 하)가 새어 나가지 않는다.
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('한');
  });

  it('조합이 끝나면 완성된 글자를 한 번만 보낸다', () => {
    const onCommit = vi.fn();
    const { container } = render(<TextField value="" onCommit={onCommit} />);
    const input = container.querySelector('input')!;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '한' } });
    fireEvent.compositionEnd(input, { target: { value: '한' } });
    tick();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('한');
  });

  it('조합 중에 예전 값이 다시 내려와도 입력창을 덮어쓰지 않는다', () => {
    // 커서가 튀던 원인 그대로 재현: 부모가 낡은 value 로 다시 렌더한다.
    const { container, rerender } = render(<TextField value="세션" onCommit={vi.fn()} />);
    const input = container.querySelector('input')!;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '세션 이' } });

    rerender(<TextField value="세션" onCommit={vi.fn()} />);

    expect(input.value).toBe('세션 이');
  });

  it('보내기 전 사이에 낡은 값이 와도 방금 친 글자가 남는다', () => {
    const { container, rerender } = render(<TextField value="a" onCommit={vi.fn()} />);
    const input = container.querySelector('input')!;

    fireEvent.change(input, { target: { value: 'ab' } });
    rerender(<TextField value="a" onCommit={vi.fn()} />);

    expect(input.value).toBe('ab');
  });

  it('타자를 모아 한 번만 보낸다', () => {
    const onCommit = vi.fn();
    const { container } = render(<TextField value="" onCommit={onCommit} />);
    const input = container.querySelector('input')!;

    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });
    tick();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('abc');
  });

  it('포커스를 잃으면 기다리지 않고 바로 보낸다', () => {
    const onCommit = vi.fn();
    const { container } = render(<TextField value="" onCommit={onCommit} />);
    const input = container.querySelector('input')!;

    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith('x');
  });

  it('바깥에서 바뀐 값은 편집 중이 아닐 때 받아들인다', () => {
    const { container, rerender } = render(<TextField value="처음" onCommit={vi.fn()} />);
    const input = container.querySelector('input')!;

    rerender(<TextField value="바깥에서 바뀜" onCommit={vi.fn()} />);

    expect(input.value).toBe('바깥에서 바뀜');
  });

  it('사라질 때 미처 못 보낸 편집을 흘려보낸다', () => {
    const onCommit = vi.fn();
    const { container, unmount } = render(<TextField value="" onCommit={onCommit} />);
    const input = container.querySelector('input')!;

    fireEvent.change(input, { target: { value: '저장 전' } });
    unmount();

    expect(onCommit).toHaveBeenCalledWith('저장 전');
  });
});

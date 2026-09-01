/**
 * 세션 설정 — "종료 후 복원" 요약.
 *
 * AI 세션 ID 입력칸은 없어졌다. 그 자리에 무엇이 실제로 복원되는지(창별 폴더 · 돌던 AI)를
 * 보여 주므로, 그 요약이 스냅샷을 제대로 읽는지 확인한다.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => {
  const { fakeInvoke } = await import('../test/backend');
  return {
    invoke: (cmd: string, args?: unknown) => fakeInvoke(cmd, args),
    Channel: class {
      onmessage: ((data: ArrayBuffer) => void) | null = null;
    },
  };
});

import { SettingsModal } from './SettingsModal';
import { useStore } from '../state/store';
import { makeSnapshot, resetBackend } from '../test/backend';

/** `restore-row` 한 줄의 값을 라벨로 찾는다. */
function rowValue(label: string): string {
  const row = screen.getByText(label).closest('.restore-row');
  return row?.querySelector('.restore-row__val')?.textContent ?? '';
}

beforeEach(() => {
  resetBackend();
  useStore.setState({ snapshot: makeSnapshot(), settings: true });
});

afterEach(cleanup);

describe('종료 후 복원 요약', () => {
  it('손으로 넣던 AI 세션 ID 칸은 더 이상 없다', () => {
    render(<SettingsModal />);
    expect(screen.queryByText('Claude 세션 ID')).toBeNull();
    expect(screen.queryByText('Codex 세션 ID')).toBeNull();
  });

  it('아무것도 기억한 것이 없으면 그렇게 말한다', () => {
    render(<SettingsModal />);
    expect(rowValue('창별 작업 폴더')).toBe('아직 없음');
    expect(rowValue('실행 중이던 AI')).toBe('없음');
  });

  it('창이 기억하는 폴더와 돌던 AI 를 센다', () => {
    const snap = makeSnapshot();
    snap.sessions[0].panes[0].cwd = 'C:/work/rterm/src';
    snap.sessions[0].panes[0].ai = 'claude';
    useStore.setState({ snapshot: snap, settings: true });

    render(<SettingsModal />);
    expect(rowValue('창별 작업 폴더')).toBe('1 개 기억');
    expect(rowValue('실행 중이던 AI')).toBe('claude');
  });

  it('SSH 세션에는 폴더를 기억하지 못한다고 알린다', () => {
    const snap = makeSnapshot();
    snap.sessions[0].shell = 'ssh';
    useStore.setState({ snapshot: snap, settings: true });

    render(<SettingsModal />);
    expect(screen.getByText(/SSH 세션은 원격 셸이라/)).toBeInTheDocument();
  });
});

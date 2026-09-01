/**
 * AI 이어붙이기 칩 — 저장된 세션 ID 없이도 눌린다.
 *
 * 예전에는 설정 화면에 손으로 넣은 ID 가 있을 때만 칩이 떴다. 이제 창의 폴더가 복원되고
 * `claude --continue` / `codex resume --last` 가 그 폴더의 최근 대화를 알아서 찾으므로
 * ID 자체가 없어졌다. 그 전제가 UI 에서 깨지지 않는지 확인한다.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { SessionHeader } from './SessionHeader';
import { useStore } from '../state/store';
import { TERM_PANE, backend, makeSnapshot, resetBackend } from '../test/backend';

beforeEach(() => {
  resetBackend();
  useStore.setState({ snapshot: makeSnapshot(), sel: TERM_PANE });
});

afterEach(cleanup);

describe('AI 칩', () => {
  it('저장된 세션 ID 가 없어도 두 칩이 모두 보인다', () => {
    render(<SessionHeader />);
    expect(screen.getByRole('button', { name: 'claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'codex' })).toBeInTheDocument();
  });

  it('누르면 고른 창 id 와 종류만 넘긴다 — 세션 ID 는 없다', async () => {
    render(<SessionHeader />);
    fireEvent.click(screen.getByRole('button', { name: 'claude' }));

    await waitFor(() => expect(backend.calls).toContain('pty_run_ai'));
    expect(backend.lastArgs('pty_run_ai')).toEqual({ paneId: TERM_PANE, kind: 'claude' });
  });

  it('실행 중인 터미널이 없으면 토스트로 알리고 부르지 않는다', async () => {
    const snap = makeSnapshot();
    snap.sessions[0].panes[0].alive = false;
    useStore.setState({ snapshot: snap, sel: null });

    render(<SessionHeader />);
    fireEvent.click(screen.getByRole('button', { name: 'codex' }));

    await waitFor(() => expect(useStore.getState().toast).toBeTruthy());
    expect(backend.calls).not.toContain('pty_run_ai');
  });

  it('그 창에서 돌고 있는 AI 는 칩에 표시된다', () => {
    const snap = makeSnapshot();
    snap.sessions[0].panes[0].ai = 'claude';
    useStore.setState({ snapshot: snap, sel: TERM_PANE });

    render(<SessionHeader />);
    expect(screen.getByRole('button', { name: 'claude' }).className).toContain('chip--on');
    expect(screen.getByRole('button', { name: 'codex' }).className).not.toContain('chip--on');
  });
});

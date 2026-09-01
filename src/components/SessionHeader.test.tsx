/**
 * 세션 헤더 — 평소엔 이름 · cwd 를 보여 주고, 전체화면일 때는 아예 그리지 않는다.
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

import { SessionHeader } from './SessionHeader';
import { useStore } from '../state/store';
import { TERM_PANE, makeSnapshot, resetBackend } from '../test/backend';

beforeEach(() => {
  resetBackend();
  useStore.setState({ snapshot: makeSnapshot(), sel: TERM_PANE });
});

afterEach(cleanup);

describe('세션 헤더', () => {
  it('평소에는 세션 이름 · cwd 를 보여 준다', () => {
    render(<SessionHeader />);
    expect(screen.getByText('rterm · main')).toBeInTheDocument();
    expect(screen.getByText('C:/work/rterm')).toBeInTheDocument();
  });

  it('전체화면일 때는 아무것도 그리지 않는다 — 고른 창이 이 바까지 감싼다', () => {
    const snap = makeSnapshot();
    snap.sessions[0].fullPaneId = TERM_PANE;
    useStore.setState({ snapshot: snap, sel: TERM_PANE });

    const { container } = render(<SessionHeader />);
    expect(container).toBeEmptyDOMElement();
  });
});

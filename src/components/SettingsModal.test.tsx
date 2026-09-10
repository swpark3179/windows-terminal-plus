/**
 * 세션 설정 — 저장/닫기 그리고 "종료 후 복원" 요약.
 *
 * 설정은 고치는 즉시가 아니라 **저장을 눌러야** 기록된다(입력칸에서 엔터도 저장). 닫기는
 * 취소다. 그 배선과, 무엇이 실제로 복원되는지(창별 폴더 · 돌던 AI) 요약을 확인한다.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import { backend, makeSnapshot, resetBackend } from '../test/backend';

/** 라벨로 찾는 입력칸 (`field` 안의 한 칸). */
function fieldInput(label: string): HTMLInputElement {
  const field = screen.getByText(label).closest('.field');
  return field?.querySelector('input') as HTMLInputElement;
}

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

describe('저장 · 닫기', () => {
  it('고치는 동안에는 아무것도 기록되지 않는다', () => {
    render(<SettingsModal />);

    fireEvent.change(fieldInput('세션 이름'), { target: { value: '배포 · stg' } });
    fireEvent.change(fieldInput('작업 디렉터리'), { target: { value: 'C:/work/deploy' } });

    expect(backend.calls).not.toContain('session_update');
    expect(screen.getByText(/저장하지 않은 변경이 있습니다/)).toBeInTheDocument();
    // 창은 열린 채로 남는다.
    expect(useStore.getState().settings).toBe(true);
  });

  it('저장이 실제 기록이다 — 고친 값이 한 번에 나간다', () => {
    render(<SettingsModal />);

    fireEvent.change(fieldInput('세션 이름'), { target: { value: '배포 · stg' } });
    fireEvent.change(fieldInput('시작 명령'), { target: { value: 'cargo watch -x check' } });
    fireEvent.click(screen.getByText('저장'));

    expect(backend.lastArgs('session_update')).toEqual({
      sessionId: 'ses_test',
      patch: {
        name: '배포 · stg',
        cwd: 'C:/work/rterm',
        shell: 'pwsh',
        start: 'cargo watch -x check',
        sshHost: '',
        env: [],
      },
    });
    expect(useStore.getState().settings).toBe(false);
  });

  it('입력칸에서 엔터를 치면 저장 버튼과 같다', () => {
    render(<SettingsModal />);

    const name = fieldInput('세션 이름');
    fireEvent.change(name, { target: { value: '배포 · stg' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect((backend.lastArgs('session_update')?.patch as { name: string }).name).toBe('배포 · stg');
    expect(useStore.getState().settings).toBe(false);
  });

  it('한글 조합 중의 엔터는 저장이 아니라 글자 확정이다', () => {
    render(<SettingsModal />);

    const name = fieldInput('세션 이름');
    fireEvent.compositionStart(name);
    fireEvent.change(name, { target: { value: '한' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(backend.calls).not.toContain('session_update');
    expect(useStore.getState().settings).toBe(true);
  });

  it('닫기는 취소 — 고친 것을 버리고 세션은 그대로 둔다', () => {
    render(<SettingsModal />);

    fireEvent.change(fieldInput('세션 이름'), { target: { value: '버릴 이름' } });
    fireEvent.click(screen.getByText('닫기'));

    expect(backend.calls).not.toContain('session_update');
    expect(useStore.getState().settings).toBe(false);
    expect(useStore.getState().toast).toMatch(/저장하지 않고 닫았습니다/);
  });

  it('닫았다 다시 열면 세션의 값에서 다시 시작한다', () => {
    const { rerender } = render(<SettingsModal />);

    fireEvent.change(fieldInput('세션 이름'), { target: { value: '버릴 이름' } });
    fireEvent.click(screen.getByText('닫기'));
    useStore.setState({ settings: true });
    rerender(<SettingsModal />);

    expect(fieldInput('세션 이름').value).toBe('rterm · main');
  });

  it('환경변수도 저장을 눌러야 나간다', () => {
    render(<SettingsModal />);

    fireEvent.click(screen.getByText('＋ 추가'));
    const row = document.querySelector('.env-row') as HTMLElement;
    fireEvent.change(row.querySelector('.env-row__key') as HTMLInputElement, {
      target: { value: 'RUST_LOG' },
    });
    fireEvent.change(row.querySelector('.env-row__val') as HTMLInputElement, {
      target: { value: 'debug' },
    });
    expect(backend.calls).not.toContain('session_update');

    fireEvent.click(screen.getByText('저장'));

    expect((backend.lastArgs('session_update')?.patch as { env: unknown }).env).toEqual([
      { k: 'RUST_LOG', v: 'debug' },
    ]);
  });

  it('이름을 지운 채 저장해도 이름 없는 세션이 되지는 않는다', () => {
    render(<SettingsModal />);

    fireEvent.change(fieldInput('세션 이름'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('저장'));

    expect((backend.lastArgs('session_update')?.patch as { name: string }).name).toBe('rterm · main');
  });
});

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

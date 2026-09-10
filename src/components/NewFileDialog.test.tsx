/**
 * 새 파일 만들기 배선 — 이름·종류가 Rust 로 그대로 나가고, 실패하면 창이 닫히지 않는지.
 *
 * 어떤 이름이 허용되는지는 Rust(`commands/files.rs`)가 정한다. 여기서는 창의 행동만 본다.
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => {
  const { fakeInvoke } = await import('../test/backend');
  return {
    invoke: (cmd: string, args?: unknown) => fakeInvoke(cmd, args),
    Channel: class {},
  };
});

import { NewFileDialog } from './NewFileDialog';
import { useStore } from '../state/store';
import { EMPTY_PANE, backend, makeSnapshot, resetBackend } from '../test/backend';

function setup() {
  useStore.setState({ snapshot: makeSnapshot(), newFile: { paneId: EMPTY_PANE }, toast: null });
  const view = render(<NewFileDialog />);
  const container = view.container;
  return {
    container,
    input: container.querySelector('.newfile__name') as HTMLInputElement,
    create: Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '만들기',
    )!,
    note: () => container.querySelector('.newfile__note')?.textContent ?? '',
  };
}

beforeEach(() => {
  resetBackend();
  useStore.setState({ newFile: null, toast: null });
});
afterEach(cleanup);

describe('NewFileDialog', () => {
  it('닫혀 있으면 아무것도 그리지 않는다', () => {
    useStore.setState({ snapshot: makeSnapshot(), newFile: null });
    const { container } = render(<NewFileDialog />);
    expect(container.querySelector('.newfile')).toBeNull();
  });

  it('이름이 비어 있으면 만들 수 없다', () => {
    const { create } = setup();
    expect(create).toBeDisabled();
  });

  it('만들 파일의 전체 경로를 미리 보여 준다', () => {
    const { input, note } = setup();
    fireEvent.change(input, { target: { value: '설계 노트' } });
    expect(note()).toContain('C:/work/rterm');
    expect(note()).toContain('설계 노트.md');
  });

  it('종류를 바꾸면 붙는 확장자도 바뀐다', () => {
    const { container, input, note } = setup();
    fireEvent.change(input, { target: { value: '메모' } });
    const txt = Array.from(container.querySelectorAll('.newfile__kind')).find((b) =>
      (b.textContent ?? '').includes('.txt'),
    )!;
    fireEvent.click(txt);
    expect(note()).toContain('메모.txt');
  });

  it('쓸 수 없는 이름은 누르기 전에 알려 준다', () => {
    const { input, create, note } = setup();
    fireEvent.change(input, { target: { value: '../밖으로.md' } });
    expect(note()).toContain('밖으로는');
    expect(create).toBeDisabled();
  });

  it('이름과 종류를 Rust 로 그대로 보낸다', async () => {
    const { input, create } = setup();
    fireEvent.change(input, { target: { value: '메모' } });
    fireEvent.click(create);

    await waitFor(() => {
      expect(backend.calls).toContain('pane_create_file');
    });
    expect(backend.lastArgs('pane_create_file')).toMatchObject({
      paneId: EMPTY_PANE,
      name: '메모',
      kind: 'md',
    });
  });

  it('만들면 창이 닫히고 그 빈 블럭이 문서 창이 된다', async () => {
    const { input, create } = setup();
    fireEvent.change(input, { target: { value: '메모' } });
    fireEvent.click(create);

    await waitFor(() => expect(useStore.getState().newFile).toBeNull());
    const pane = useStore.getState().snapshot!.sessions[0].panes[1];
    expect(pane.kind).toBe('md');
    expect(pane.title).toBe('메모.md');
    // 방금 만든 빈 문서는 읽을 것이 없으므로 에디터로 열린다.
    expect(pane.mode).toBe('edit');
  });

  it('엔터로도 만들 수 있다', async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '메모' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(backend.calls).toContain('pane_create_file'));
  });

  it('한글 조합 중의 엔터는 확정이지 만들기가 아니다', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '메모' } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(backend.calls).not.toContain('pane_create_file');
  });

  it('이미 있는 이름이면 사유만 알리고 창을 열어 둔다', async () => {
    backend.createFileError = '이미 있는 파일입니다';
    const { input, create } = setup();
    fireEvent.change(input, { target: { value: 'README' } });
    fireEvent.click(create);

    await waitFor(() => expect(useStore.getState().toast).toBe('이미 있는 파일입니다'));
    // 이름만 고쳐 다시 누를 수 있어야 한다.
    expect(useStore.getState().newFile).not.toBeNull();
  });
});

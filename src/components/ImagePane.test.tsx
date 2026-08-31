/**
 * 이미지 뷰어 배선 — 파일을 읽어 오고, 배율 조작이 Rust 로 나가는지.
 * (색 계산 자체는 `lib/imageView.test.ts` 가 순수 함수로 검증한다.)
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let failRead = false;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'fs_read_image') {
      if (failRead) return Promise.reject('이미지가 너무 큽니다 (40.0 MB). 32 MB 이하만 열 수 있습니다');
      return Promise.resolve({
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        mime: 'image/png',
        bytes: 12,
      });
    }
    return Promise.resolve(null);
  },
  Channel: class {},
}));

import { ImagePane } from './ImagePane';
import type { Pane } from '../state/types';

const pane: Pane = {
  id: 'p-img',
  kind: 'image',
  title: 'logo.png',
  r: 1,
  c: 1,
  rs: 1,
  cs: 1,
  zoom: 14,
  alive: false,
  dirty: false,
  path: 'C:/work/logo.png',
  imageZoom: 100,
};

const zoomCalls = () => calls.filter((c) => c.cmd === 'pane_set_image_zoom');

beforeEach(() => {
  calls.length = 0;
  failRead = false;
});
afterEach(cleanup);

describe('ImagePane', () => {
  it('경로로 이미지를 읽어 화면에 건다', async () => {
    const { container } = render(<ImagePane pane={pane} sessionId="ses" />);

    await waitFor(() => {
      const img = container.querySelector('img.image-canvas') as HTMLImageElement | null;
      expect(img?.src).toContain('data:image/png;base64');
    });
    expect(calls[0]).toEqual({ cmd: 'fs_read_image', args: { path: 'C:/work/logo.png' } });
  });

  it('확대·축소는 정해진 배율 단계로 움직인다', async () => {
    const { getByTitle } = render(<ImagePane pane={pane} sessionId="ses" />);

    fireEvent.click(getByTitle('확대'));
    await waitFor(() => expect(zoomCalls()).toHaveLength(1));
    expect(zoomCalls()[0].args.zoom).toBe(150);

    fireEvent.click(getByTitle('축소'));
    await waitFor(() => expect(zoomCalls()).toHaveLength(2));
    expect(zoomCalls()[1].args.zoom).toBe(75);
  });

  it('맞춤은 배율을 비워 창 크기에 따르게 한다', async () => {
    const { getByTitle } = render(<ImagePane pane={pane} sessionId="ses" />);

    fireEvent.click(getByTitle('창에 맞추기'));

    await waitFor(() => expect(zoomCalls()).toHaveLength(1));
    expect(zoomCalls()[0].args.zoom).toBeNull();
  });

  it('100% 버튼은 원본 크기로 되돌린다', async () => {
    const fitted = { ...pane, imageZoom: null };
    const { getByTitle } = render(<ImagePane pane={fitted} sessionId="ses" />);

    fireEvent.click(getByTitle('원본 크기 (100%)'));

    await waitFor(() => expect(zoomCalls()).toHaveLength(1));
    expect(zoomCalls()[0].args.zoom).toBe(100);
  });

  it('스포이드를 켜면 뷰어가 집기 모드로 바뀐다', async () => {
    const { container, getByTitle } = render(<ImagePane pane={pane} sessionId="ses" />);
    const viewport = () => container.querySelector('.image-viewport')!;

    expect(viewport().className).not.toContain('image-viewport--picking');

    fireEvent.click(getByTitle('스포이드 · 클릭하면 색이 복사됩니다'));
    expect(viewport().className).toContain('image-viewport--picking');

    fireEvent.click(getByTitle('스포이드 · 클릭하면 색이 복사됩니다'));
    expect(viewport().className).not.toContain('image-viewport--picking');
  });

  it('열 수 없으면 사유를 보여 준다', async () => {
    failRead = true;
    const { findByText } = render(<ImagePane pane={pane} sessionId="ses" />);

    expect(
      await findByText('이미지가 너무 큽니다 (40.0 MB). 32 MB 이하만 열 수 있습니다'),
    ).toBeInTheDocument();
  });
});

/**
 * 라인 잘라내기와 되돌리기 — Ctrl+X 로 지운 줄이 Ctrl+Z 로 살아나야 한다.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.resolve(null),
  Channel: class {},
}));

import { TextPane } from './TextPane';
import type { Pane } from '../state/types';

const CONTENT = '<div>첫째 줄</div><div>둘째 줄</div><div>셋째 줄</div>';

const pane: Pane = {
  id: 'p-text',
  kind: 'text',
  title: 'notes.txt',
  r: 1,
  c: 1,
  rs: 1,
  cs: 1,
  zoom: 14,
  alive: false,
  dirty: false,
  path: 'C:/work/notes.txt',
  content: CONTENT,
};

function setup() {
  const view = render(<TextPane pane={pane} sessionId="ses_test" />);
  const body = view.container.querySelector('.text-body') as HTMLElement;
  return { view, body };
}

/** 지정한 줄의 맨 앞에 캐럿을 둔다. */
function caretInLine(body: HTMLElement, index: number) {
  const line = body.children[index];
  const range = document.createRange();
  range.setStart(line.firstChild!, 0);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

const lines = (body: HTMLElement) => Array.from(body.children).map((c) => c.textContent);

afterEach(cleanup);

describe('라인 잘라내기', () => {
  it('Ctrl+X 는 캐럿이 있는 줄을 지운다', () => {
    const { body } = setup();
    expect(lines(body)).toEqual(['첫째 줄', '둘째 줄', '셋째 줄']);

    caretInLine(body, 1);
    fireEvent.keyDown(body, { key: 'x', ctrlKey: true });

    expect(lines(body)).toEqual(['첫째 줄', '셋째 줄']);
  });

  it('Ctrl+Z 로 잘라낸 줄이 되살아난다', () => {
    const { body } = setup();

    caretInLine(body, 1);
    fireEvent.keyDown(body, { key: 'x', ctrlKey: true });
    expect(lines(body)).toEqual(['첫째 줄', '셋째 줄']);

    fireEvent.keyDown(body, { key: 'z', ctrlKey: true });

    expect(lines(body)).toEqual(['첫째 줄', '둘째 줄', '셋째 줄']);
  });

  it('여러 줄을 잘라내도 하나씩 되돌아온다', () => {
    const { body } = setup();

    caretInLine(body, 0);
    fireEvent.keyDown(body, { key: 'x', ctrlKey: true });
    caretInLine(body, 0);
    fireEvent.keyDown(body, { key: 'x', ctrlKey: true });
    expect(lines(body)).toEqual(['셋째 줄']);

    fireEvent.keyDown(body, { key: 'z', ctrlKey: true });
    expect(lines(body)).toEqual(['둘째 줄', '셋째 줄']);

    fireEvent.keyDown(body, { key: 'z', ctrlKey: true });
    expect(lines(body)).toEqual(['첫째 줄', '둘째 줄', '셋째 줄']);
  });

  it('되돌린 것을 Ctrl+Y 로 다시 잘라낼 수 있다', () => {
    const { body } = setup();

    caretInLine(body, 1);
    fireEvent.keyDown(body, { key: 'x', ctrlKey: true });
    fireEvent.keyDown(body, { key: 'z', ctrlKey: true });
    expect(lines(body)).toEqual(['첫째 줄', '둘째 줄', '셋째 줄']);

    fireEvent.keyDown(body, { key: 'y', ctrlKey: true });
    expect(lines(body)).toEqual(['첫째 줄', '셋째 줄']);
  });

  it('되돌릴 것이 없으면 아무 일도 없다', () => {
    const { body } = setup();
    fireEvent.keyDown(body, { key: 'z', ctrlKey: true });
    expect(lines(body)).toEqual(['첫째 줄', '둘째 줄', '셋째 줄']);
  });

  it('툴바에도 되돌리기 버튼이 있다', () => {
    const { view, body } = setup();

    caretInLine(body, 1);
    fireEvent.keyDown(body, { key: 'x', ctrlKey: true });
    fireEvent.click(view.getByTitle('되돌리기 · Ctrl+Z'));

    expect(lines(body)).toEqual(['첫째 줄', '둘째 줄', '셋째 줄']);
  });
});

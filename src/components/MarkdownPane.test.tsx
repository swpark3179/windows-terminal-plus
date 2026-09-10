/**
 * 마크다운 뷰어 배선 — 목차 · 찾기 · 테마 · 링크 처리.
 *
 * 렌더러 자체는 `lib/markdown.test.ts` 가, 표시·검색 알고리즘은 `lib/mdSearch.test.ts` 와
 * `lib/mdView.test.ts` 가 순수하게 검증한다. 여기서 보는 것은 **창 안에서의 배선** —
 * 눌렀을 때 실제로 그 일이 벌어지는지다.
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return Promise.resolve(null);
  },
  Channel: class {},
}));

// 다이어그램·문법 강조는 무거운 동적 import 라 이 테스트에서는 재운다.
vi.mock('../lib/mdEnhance', () => ({
  highlightCode: () => Promise.resolve(),
  renderMermaid: () => Promise.resolve(),
  wireCopyButtons: () => () => {},
}));

import { MarkdownPane } from './MarkdownPane';
import { useStore } from '../state/store';
import { MD_PREFS_DEFAULT } from '../lib/mdView';
import type { Pane } from '../state/types';

const DOC = [
  '# 첫 제목',
  '',
  '본문에는 rterm 이라는 낱말이 있다.',
  '',
  '## 둘째 제목',
  '',
  '여기에도 rterm 이 있다.',
  '',
  '[바깥](https://example.com) · [옆 문서](./guide.md) · [안](#둘째-제목)',
].join('\n');

const pane: Pane = {
  id: 'p-md',
  kind: 'md',
  title: 'notes.md',
  r: 1,
  c: 1,
  rs: 1,
  cs: 1,
  zoom: 14,
  alive: false,
  dirty: false,
  path: 'C:/work/docs/notes.md',
  content: DOC,
  mode: 'view',
};

function setup(over: Partial<Pane> = {}) {
  const view = render(<MarkdownPane pane={{ ...pane, ...over }} sessionId="ses" />);
  return { view, container: view.container };
}

const button = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(label),
  )!;

beforeEach(() => {
  calls.length = 0;
  useStore.setState({ mdPrefs: { ...MD_PREFS_DEFAULT }, toast: null, snapshot: null });
});
afterEach(cleanup);

describe('MarkdownPane 뷰어', () => {
  it('원문을 렌더해 문서로 보여 준다', () => {
    const { container } = setup();
    expect(container.querySelector('.md-doc h1')?.textContent).toBe('첫 제목');
    expect(container.querySelectorAll('[data-md-heading]')).toHaveLength(2);
  });

  it('문서 크기를 상태에 적는다', () => {
    const { container } = setup();
    expect(container.querySelector('.md-bar__stats')?.textContent).toContain('줄');
  });

  it('에디터 모드에서는 원문 그대로 두고 뷰어 도구를 띄우지 않는다', () => {
    const { container } = setup({ mode: 'edit' });
    expect(container.querySelector('.md-edit')?.textContent).toBe(DOC);
    expect(container.querySelector('.md-bar')).toBeNull();
  });
});

describe('목차', () => {
  it('목차를 켜면 제목이 순서대로 나온다', () => {
    const { container } = setup();
    fireEvent.click(button(container, '목차'));

    const items = Array.from(container.querySelectorAll('.md-toc__item'));
    expect(items.map((i) => i.textContent)).toEqual(['첫 제목', '둘째 제목']);
  });

  it('목차 상태는 앱 전체 설정으로 남는다 — 문서를 옮겨도 다시 맞추지 않게', () => {
    const { container } = setup();
    fireEvent.click(button(container, '목차'));
    expect(useStore.getState().mdPrefs.toc).toBe(true);
  });

  it('제목이 없는 문서에서는 목차 버튼이 잠긴다', () => {
    const { container } = setup({ content: '제목 없는 글' });
    expect(button(container, '목차')).toBeDisabled();
  });
});

describe('문서 안에서 찾기', () => {
  it('찾기를 켜고 낱말을 넣으면 자리를 표시하고 개수를 센다', async () => {
    const { container } = setup();
    fireEvent.click(button(container, '찾기'));

    const input = container.querySelector('.md-find__input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'rterm' } });

    await waitFor(() => {
      expect(container.querySelectorAll('mark.md-hit')).toHaveLength(2);
    });
    expect(container.querySelector('.md-find__count')?.textContent).toBe('1 / 2');
  });

  it('없는 낱말이면 없다고 알린다', async () => {
    const { container } = setup();
    fireEvent.click(button(container, '찾기'));
    const input = container.querySelector('.md-find__input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '없는낱말' } });

    await waitFor(() => {
      expect(container.querySelector('.md-find__count')?.textContent).toBe('없음');
    });
  });

  it('닫으면 표시가 본문에서 사라진다', async () => {
    const { container } = setup();
    fireEvent.click(button(container, '찾기'));
    const input = container.querySelector('.md-find__input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'rterm' } });
    await waitFor(() => expect(container.querySelectorAll('mark.md-hit')).toHaveLength(2));

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(container.querySelectorAll('mark.md-hit')).toHaveLength(0));
  });
});

describe('표시 설정', () => {
  it('테마를 바꾸면 창에 어두운 표시가 붙는다', () => {
    const { container } = setup();
    fireEvent.click(button(container, '☾'));
    expect(container.querySelector('.md-pane--dark')).not.toBeNull();
    expect(useStore.getState().mdPrefs.theme).toBe('dark');
  });

  it('글꼴을 고르면 본문 글꼴이 바뀐다', () => {
    const { container } = setup();
    const select = container.querySelector('.md-bar__font') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'mono' } });

    const doc = container.querySelector('.md-doc') as HTMLElement;
    expect(doc.style.fontFamily).toContain('Cascadia Mono');
  });

  it('본문 폭을 창 가득으로 풀 수 있다', () => {
    const { container } = setup();
    expect(container.querySelector('.md-doc--narrow')).not.toBeNull();
    fireEvent.click(container.querySelector('.md-bar__btn.is-on')!);
    expect(container.querySelector('.md-doc--narrow')).toBeNull();
  });
});

describe('본문 링크', () => {
  it('바깥 주소는 웹뷰가 아니라 OS 브라우저로 보낸다', () => {
    const { container } = setup();
    const link = container.querySelector('a[data-md-link="ext"]') as HTMLElement;
    fireEvent.click(link);

    const opened = calls.find((c) => c.cmd === 'link_open');
    expect(opened?.args.url).toBe('https://example.com');
  });

  it('옆 문서 링크는 문서 위치를 기준으로 풀어 연다', () => {
    // 빈 블럭이 없으면 열 자리가 없다고 알린다 — 그 판정이 실제 경로로 이뤄지는지 본다.
    const { container } = setup();
    const link = container.querySelector('a[data-md-link="rel"]') as HTMLElement;
    fireEvent.click(link);
    expect(useStore.getState().toast).toContain('빈 블럭이 없습니다');
  });

  it('없는 앵커를 누르면 조용히 넘어가지 않고 알린다', () => {
    const { container } = setup({ content: '[가짜](#없는제목)' });
    fireEvent.click(container.querySelector('a[data-md-link="anchor"]') as HTMLElement);
    expect(useStore.getState().toast).toContain('없는제목');
  });

  it('링크는 웹뷰를 그 주소로 끌고 가지 않는다', () => {
    const { container } = setup();
    const link = container.querySelector('a[data-md-link="ext"]') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

/**
 * 하이퍼링크 배선 — 특히 "지나가는 클릭으로 브라우저가 열리지 않는다" 를 못 박는다.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTermLinks } from './termLinks';

function setup(opts: { open?: () => Promise<void> } = {}) {
  const host = document.createElement('div');
  // jsdom 은 배치를 재지 않으므로 상자를 흉내 내 준다 (칩 위치 계산이 이 값을 읽는다).
  host.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300 }) as DOMRect;
  document.body.appendChild(host);

  const flash = vi.fn();
  const open = vi.fn(opts.open ?? (() => Promise.resolve()));
  const links = createTermLinks({ element: () => host, flash, open });
  return { host, flash, open, links, chip: () => host.querySelector('.term-link-chip') };
}

const mouse = (init: Partial<MouseEvent> = {}) =>
  ({ button: 0, ctrlKey: false, clientX: 100, clientY: 120, ...init }) as MouseEvent;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('링크 열기', () => {
  it('Ctrl 없이 누르면 열지 않고 방법만 알려 준다', () => {
    const { links, open, flash } = setup();
    links.activate(mouse(), 'https://example.com');
    expect(open).not.toHaveBeenCalled();
    expect(flash).toHaveBeenCalledWith(expect.stringContaining('Ctrl'));
  });

  it('Ctrl+클릭이면 Rust 로 넘긴다', () => {
    const { links, open } = setup();
    links.activate(mouse({ ctrlKey: true }), 'https://example.com/a?b=1');
    expect(open).toHaveBeenCalledWith('https://example.com/a?b=1');
  });

  it('이벤트가 아예 없으면 열지 않는다 — 애드온이 넘겨 줄 수 있는 모양이다', () => {
    const { links, open } = setup();
    links.activate(undefined, 'https://example.com');
    expect(open).not.toHaveBeenCalled();
  });

  it('주 버튼이 아니면 아무 말도 하지 않는다 — 우클릭·가운데 클릭도 이 처리기를 지난다', () => {
    const { links, open, flash } = setup();
    for (const button of [1, 2]) {
      links.activate(mouse({ button, ctrlKey: true }), 'https://example.com');
    }
    expect(open).not.toHaveBeenCalled();
    expect(flash).not.toHaveBeenCalled();
  });

  it('한글이 든 주소는 퍼센트 인코딩해서 넘긴다 — Rust 검사는 ASCII 만 받는다', () => {
    const { links, open } = setup();
    links.activate(mouse({ ctrlKey: true }), 'https://example.com/한글?q=값');
    expect(open).toHaveBeenCalledWith('https://example.com/%ED%95%9C%EA%B8%80?q=%EA%B0%92');
  });

  it('주소로 읽을 수 없으면 열지 않는다', () => {
    const { links, open, flash } = setup();
    links.activate(mouse({ ctrlKey: true }), 'https://');
    expect(open).not.toHaveBeenCalled();
    expect(flash).toHaveBeenCalledWith(expect.stringContaining('읽을 수 없습니다'));
  });

  it('열지 못하면 사유를 알린다', async () => {
    const { links, flash } = setup({ open: () => Promise.reject('http · https 주소만 열 수 있습니다') });
    links.activate(mouse({ ctrlKey: true }), 'https://example.com');
    await vi.waitFor(() =>
      expect(flash).toHaveBeenCalledWith('http · https 주소만 열 수 있습니다'),
    );
  });
});

describe('실제 주소 칩', () => {
  it('마우스를 올리면 주소를 띄우고 떼면 사라진다', () => {
    const { links, chip } = setup();
    expect(chip()).toBeNull();

    links.hover(mouse(), 'https://example.com/very/real/target');
    expect(chip()?.textContent).toBe('https://example.com/very/real/target');
    // 링크를 가로막지 않도록 xterm 이 아는 표시를 달아 둔다.
    expect(chip()?.className).toContain('xterm-hover');

    links.leave();
    expect(chip()).toBeNull();
  });

  it('칩은 터미널 상자 안에 머문다', () => {
    const { links, chip } = setup();
    // 오른쪽·위쪽 끝을 넘어서는 좌표.
    links.hover(mouse({ clientX: 9999, clientY: 20 }), 'https://example.com');
    const el = chip() as HTMLElement;
    expect(parseInt(el.style.left, 10)).toBeLessThanOrEqual(400);
    expect(parseInt(el.style.top, 10)).toBeGreaterThanOrEqual(0);
  });

  it('주소에 섞인 방향 전환 문자를 지운 채 보여 준다 — 칩이 눈속임을 옮기면 안 된다', () => {
    const { links, chip } = setup();
    links.hover(mouse(), 'https://evil.tld/\u202egnp.exe');
    expect(chip()?.textContent).toBe('https://evil.tld/gnp.exe');
  });

  it('여는 순간 칩을 거둔다 — 브라우저로 넘어간 뒤 남아 있으면 안 된다', () => {
    const { links, chip } = setup();
    links.hover(mouse(), 'https://example.com');
    expect(chip()).toBeTruthy();
    links.activate(mouse({ ctrlKey: true }), 'https://example.com');
    expect(chip()).toBeNull();
  });
});

/**
 * 문서 안에서 찾기 — 표시를 씌우고 벗기는 일이 본문을 망가뜨리지 않아야 한다.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearHits, markHits, stepHit } from './mdSearch';

let root: HTMLElement;

function setup(html: string) {
  root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('markHits', () => {
  it('찾은 자리를 표시로 감싼다', () => {
    setup('<p>rterm 은 터미널이다</p>');
    const hits = markHits(root, '터미널');
    expect(hits).toHaveLength(1);
    expect(root.querySelectorAll('mark.md-hit')).toHaveLength(1);
    expect(root.textContent).toBe('rterm 은 터미널이다');
  });

  it('대소문자를 가리지 않는다', () => {
    setup('<p>Rterm RTERM rterm</p>');
    expect(markHits(root, 'rterm')).toHaveLength(3);
  });

  it('한 줄 안의 여러 자리를 모두 찾는다', () => {
    setup('<p>가가가</p>');
    const hits = markHits(root, '가');
    expect(hits).toHaveLength(3);
    expect(root.textContent).toBe('가가가');
  });

  it('겹치는 낱말은 겹치지 않게 센다', () => {
    setup('<p>aaaa</p>');
    // "aa" 는 겹쳐 세면 3, 겹치지 않게 세면 2 — 표시를 씌워야 하므로 2 가 맞다.
    expect(markHits(root, 'aa')).toHaveLength(2);
  });

  it('여러 요소에 흩어져 있어도 각각 찾는다', () => {
    setup('<p>하나 메모</p><p>둘 <b>메모</b></p>');
    expect(markHits(root, '메모')).toHaveLength(2);
  });

  it('다이어그램 SVG 안은 건드리지 않는다', () => {
    setup('<div class="md-mermaid"><svg><text>메모</text></svg></div><p>메모</p>');
    expect(markHits(root, '메모')).toHaveLength(1);
    expect(root.querySelector('svg text')?.innerHTML).toBe('메모');
  });

  it('빈 검색어에는 아무것도 하지 않는다', () => {
    setup('<p>본문</p>');
    expect(markHits(root, '   ')).toHaveLength(0);
    expect(root.innerHTML).toBe('<p>본문</p>');
  });
});

describe('clearHits', () => {
  it('표시를 벗기고 원래 HTML 로 되돌린다', () => {
    setup('<p>rterm 은 터미널이다</p>');
    markHits(root, '터미널');
    clearHits(root);
    expect(root.innerHTML).toBe('<p>rterm 은 터미널이다</p>');
  });

  it('벗긴 뒤 다시 찾아도 낱말이 쪼개져 있지 않다', () => {
    // 표시를 벗기며 글자 노드를 다시 붙이지 않으면, 두 번째 검색이 경계에 걸린 낱말을 놓친다.
    setup('<p>터미널 문서</p>');
    markHits(root, '터미');
    clearHits(root);
    expect(markHits(root, '터미널')).toHaveLength(1);
  });
});

describe('stepHit', () => {
  it('끝에서 반대편으로 돈다', () => {
    expect(stepHit(3, 0, 1)).toBe(1);
    expect(stepHit(3, 2, 1)).toBe(0);
    expect(stepHit(3, 0, -1)).toBe(2);
  });

  it('찾은 것이 없으면 고를 것도 없다', () => {
    expect(stepHit(0, -1, 1)).toBe(-1);
  });
});

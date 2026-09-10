/**
 * 문서 안에서 찾기.
 *
 * 렌더된 본문의 **글자 노드만** 훑어 찾은 자리를 `<mark>` 로 감싼다. 원문을 다시 그리지 않으므로
 * 코드 강조도 다이어그램도 그대로 남는다. 대신 두 가지를 지켜야 한다.
 *
 * - 그림(`<svg>`)과 이미 씌운 표시 안으로는 들어가지 않는다 — mermaid 가 그린 SVG 의 글자를
 *   건드리면 다이어그램이 깨진다.
 * - 지울 때는 표시를 벗기고 `normalize()` 로 쪼개진 글자 노드를 다시 붙인다. 그러지 않으면
 *   찾기를 반복할수록 노드가 잘게 부서져 다음 검색이 낱말을 놓친다.
 */

const MARK = 'md-hit';
const CURRENT = 'md-hit--on';

/** 찾기 표시를 모두 벗겨 본문을 원래대로 되돌린다. */
export function clearHits(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll<HTMLElement>(`mark.${MARK}`));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    (parent as Element).normalize?.();
  }
}

/** 이 글자 노드를 훑어도 되는가. */
function searchable(node: Text): boolean {
  if (!node.nodeValue?.trim()) return false;
  const parent = node.parentElement;
  if (!parent) return false;
  return !parent.closest('svg, mark.' + MARK + ', .md-mermaid__pending');
}

/**
 * `query` 를 찾아 표시하고, 찾은 자리를 순서대로 돌려준다.
 *
 * 대소문자는 구분하지 않는다. 이미 씌워진 표시는 부르는 쪽이 `clearHits` 로 지우고 온다.
 */
export function markHits(root: HTMLElement, query: string): HTMLElement[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (searchable(text)) texts.push(text);
  }

  const hits: HTMLElement[] = [];
  for (const text of texts) {
    const value = text.nodeValue ?? '';
    const lower = value.toLowerCase();
    let at = lower.indexOf(needle);
    if (at < 0) continue;

    // 한 노드 안의 여러 자리를 뒤에서부터 자르면 앞쪽 위치가 밀리지 않는다.
    const cuts: number[] = [];
    while (at >= 0) {
      cuts.push(at);
      at = lower.indexOf(needle, at + needle.length);
    }

    let rest = text;
    let consumed = 0;
    for (const cut of cuts) {
      const middle = rest.splitText(cut - consumed);
      const tail = middle.splitText(needle.length);
      const mark = document.createElement('mark');
      mark.className = MARK;
      mark.textContent = middle.nodeValue;
      middle.parentNode?.replaceChild(mark, middle);
      hits.push(mark);
      consumed = cut + needle.length;
      rest = tail;
    }
  }
  return hits;
}

/**
 * 지금 보고 있는 자리만 진하게 칠하고 화면 안으로 끌어온다.
 * `scrollIntoView` 가 없는 환경(jsdom)에서도 색칠까지는 제 일을 한다.
 */
export function focusHit(hits: HTMLElement[], index: number): void {
  hits.forEach((hit, i) => hit.classList.toggle(CURRENT, i === index));
  hits[index]?.scrollIntoView?.({ block: 'center' });
}

/** 다음/이전 자리 — 끝에서는 반대편으로 돈다. */
export function stepHit(total: number, current: number, delta: 1 | -1): number {
  if (total === 0) return -1;
  return (current + delta + total) % total;
}

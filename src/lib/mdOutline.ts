/**
 * 목차 — 렌더된 본문에서 제목을 훑어 만든다.
 *
 * 원문을 다시 파싱하지 않고 **그려진 것**을 읽는 이유는, 목차가 가리키는 자리와 화면에 있는
 * 자리가 어긋날 수 없게 하기 위해서다. 렌더러가 어떤 이유로 제목을 빠뜨리면 목차에도 없다.
 */

export interface Heading {
  /** `data-md-heading` — 문서 안에서의 순번. 창이 여럿이라 id 대신 이것으로 찾는다. */
  index: number;
  level: number;
  text: string;
}

export function readOutline(root: HTMLElement): Heading[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-md-heading]')).map((el) => ({
    index: Number(el.dataset.mdHeading ?? 0),
    level: Number(el.dataset.mdLevel ?? 1),
    text: (el.textContent ?? '').trim(),
  }));
}

/**
 * 지금 읽고 있는 제목 — 화면 위쪽 경계를 지난 마지막 제목.
 *
 * `offsets` 는 각 제목의 문서 안 세로 위치, 순서대로. 첫 제목보다 위에 있으면 -1 (없음).
 * 경계에 살짝 여유(`slack`)를 두는 것은, 제목을 눌러 이동했을 때 그 제목이 곧바로
 * 켜지게 하기 위해서다 — 정확히 같은 값이면 반올림 한 픽셀에 밀려 앞 제목이 켜진다.
 */
export function activeHeading(offsets: number[], scrollTop: number, slack = 4): number {
  let found = -1;
  for (let i = 0; i < offsets.length; i += 1) {
    if (offsets[i] <= scrollTop + slack) found = i;
    else break;
  }
  return found;
}

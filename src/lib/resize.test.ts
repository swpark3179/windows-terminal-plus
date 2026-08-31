import { describe, expect, it } from 'vitest';
import { dragWeights, horizontalSeams, MIN_WEIGHT, verticalSeams } from './resize';
import type { Grid, Pane } from '../state/types';

/** 좌표만 있으면 되는 가짜 창. */
function pane(id: string, r: number, c: number, rs = 1, cs = 1): Pane {
  return {
    id,
    kind: 'empty',
    title: id,
    r,
    c,
    rs,
    cs,
    zoom: 14,
    alive: false,
    dirty: false,
  };
}

const grid = (cols: number, rows: number): Grid => ({
  cols,
  rows,
  colWeights: Array<number>(cols).fill(1),
  rowWeights: Array<number>(rows).fill(1),
});

describe('이음매 찾기', () => {
  it('창이 하나뿐이면 잡을 경계가 없다', () => {
    const panes = [pane('a', 1, 1)];
    expect(verticalSeams(panes, grid(1, 1))).toEqual([]);
    expect(horizontalSeams(panes, grid(1, 1))).toEqual([]);
  });

  it('좌우로 나뉘면 세로 경계가 하나 생긴다', () => {
    const panes = [pane('a', 1, 1), pane('b', 1, 2)];
    expect(verticalSeams(panes, grid(2, 1))).toEqual([{ line: 1, start: 1, span: 1 }]);
    expect(horizontalSeams(panes, grid(2, 1))).toEqual([]);
  });

  it('위아래로 나뉘면 가로 경계가 하나 생긴다', () => {
    const panes = [pane('a', 1, 1), pane('b', 2, 1)];
    expect(horizontalSeams(panes, grid(1, 2))).toEqual([{ line: 1, start: 1, span: 1 }]);
  });

  it('2×2 는 세로 하나 가로 하나, 각각 두 칸을 가로지른다', () => {
    const panes = [pane('a', 1, 1), pane('b', 1, 2), pane('c', 2, 1), pane('d', 2, 2)];
    expect(verticalSeams(panes, grid(2, 2))).toEqual([{ line: 1, start: 1, span: 2 }]);
    expect(horizontalSeams(panes, grid(2, 2))).toEqual([{ line: 1, start: 1, span: 2 }]);
  });

  it('선을 가로지르는 창이 있으면 그 구간에는 손잡이를 놓지 않는다', () => {
    // 디자인의 배치: 왼쪽에 세로로 긴 창 하나, 오른쪽에 위아래 두 창.
    const panes = [pane('tall', 1, 1, 2, 1), pane('top', 1, 2), pane('bottom', 2, 2)];

    // 세로 경계는 온전히 살아 있다.
    expect(verticalSeams(panes, grid(2, 2))).toEqual([{ line: 1, start: 1, span: 2 }]);
    // 가로 경계는 오른쪽 칸에서만 보인다 — 왼쪽은 긴 창이 가로지른다.
    expect(horizontalSeams(panes, grid(2, 2))).toEqual([{ line: 1, start: 2, span: 1 }]);
  });

  it('가로지르는 창 때문에 이음매가 여러 토막으로 나뉜다', () => {
    // 3열: 가운데 열만 위아래로 나뉘고 양옆은 세로로 긴 창.
    const panes = [
      pane('l', 1, 1, 2, 1),
      pane('m-top', 1, 2),
      pane('m-bottom', 2, 2),
      pane('r', 1, 3, 2, 1),
    ];
    expect(horizontalSeams(panes, grid(3, 2))).toEqual([{ line: 1, start: 2, span: 1 }]);
  });

  it('떨어진 두 토막을 각각 찾아낸다', () => {
    // 3열 중 가운데만 통짜, 양옆은 위아래로 나뉜 배치.
    const panes = [
      pane('l-top', 1, 1),
      pane('l-bottom', 2, 1),
      pane('m', 1, 2, 2, 1),
      pane('r-top', 1, 3),
      pane('r-bottom', 2, 3),
    ];
    expect(horizontalSeams(panes, grid(3, 2))).toEqual([
      { line: 1, start: 1, span: 1 },
      { line: 1, start: 3, span: 1 },
    ]);
  });

  it('4열이면 경계가 세 개 나온다', () => {
    const panes = [pane('a', 1, 1), pane('b', 1, 2), pane('c', 1, 3), pane('d', 1, 4)];
    expect(verticalSeams(panes, grid(4, 1)).map((s) => s.line)).toEqual([1, 2, 3]);
  });
});

describe('경계 끌기', () => {
  const trackPx = 1000;

  it('한쪽이 커진 만큼 반대쪽이 작아진다', () => {
    const next = dragWeights([1, 1], 1, 100, trackPx);
    // 몫 합 2, 1000px → 100px 은 0.2
    expect(next[0]).toBeCloseTo(1.2);
    expect(next[1]).toBeCloseTo(0.8);
    expect(next[0] + next[1]).toBeCloseTo(2);
  });

  it('반대 방향으로 끌면 반대로 움직인다', () => {
    const next = dragWeights([1, 1], 1, -250, trackPx);
    expect(next[0]).toBeCloseTo(0.5);
    expect(next[1]).toBeCloseTo(1.5);
  });

  it('관계없는 트랙은 건드리지 않는다', () => {
    const next = dragWeights([1, 1, 1], 2, 100, trackPx);
    expect(next[0]).toBe(1); // 첫 트랙 그대로
    expect(next[1] + next[2]).toBeCloseTo(2);
    expect(next[1]).toBeGreaterThan(next[2]);
  });

  it('아무리 밀어도 창이 사라지지는 않는다', () => {
    const next = dragWeights([1, 1], 1, 100000, trackPx);
    expect(next[1]).toBeCloseTo(MIN_WEIGHT);
    expect(next[0] + next[1]).toBeCloseTo(2);
  });

  it('반대쪽으로 끝까지 밀어도 마찬가지다', () => {
    const next = dragWeights([1, 1], 1, -100000, trackPx);
    expect(next[0]).toBeCloseTo(MIN_WEIGHT);
    expect(next[0] + next[1]).toBeCloseTo(2);
  });

  it('이미 치우친 상태에서도 합은 그대로다', () => {
    const next = dragWeights([1.6, 0.4], 1, -300, trackPx);
    expect(next[0] + next[1]).toBeCloseTo(2);
    expect(next[0]).toBeCloseTo(1.0);
  });

  it('범위를 벗어난 경계나 이상한 크기는 그대로 둔다', () => {
    expect(dragWeights([1, 1], 0, 50, trackPx)).toEqual([1, 1]);
    expect(dragWeights([1, 1], 2, 50, trackPx)).toEqual([1, 1]);
    expect(dragWeights([1, 1], 1, 50, 0)).toEqual([1, 1]);
  });
});

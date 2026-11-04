import { describe, expect, it } from 'vitest';

import { type Box, planLayout } from './layoutMotion';

const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  width,
  height,
});
const layout = (entries: [string, Box][]) => new Map(entries);

describe('planLayout', () => {
  it('좌·우로 나누면 원래 창은 줄어들고, 새 창은 가르는 선에서 펼쳐진다', () => {
    const plan = planLayout(
      layout([['a', box(0, 0, 1000, 600)]]),
      layout([
        ['a', box(0, 0, 496, 600)],
        ['b', box(504, 0, 496, 600)],
      ]),
    )!;
    expect(plan.moves).toEqual([{ id: 'a', from: box(0, 0, 1000, 600), to: box(0, 0, 496, 600) }]);
    // 폭 0 에서 시작 — 왼쪽 가장자리가 곧 가르는 선이다.
    expect(plan.enters).toEqual([{ id: 'b', from: box(504, 0, 0, 600), to: box(504, 0, 496, 600) }]);
    expect(plan.exits).toEqual([]);
  });

  it('위·아래로 나누면 새 창은 높이 0 에서 펼쳐진다', () => {
    const plan = planLayout(
      layout([['a', box(0, 0, 1000, 600)]]),
      layout([
        ['a', box(0, 0, 1000, 296)],
        ['b', box(0, 304, 1000, 296)],
      ]),
    )!;
    expect(plan.enters[0].from).toEqual(box(0, 304, 1000, 0));
  });

  it('교환은 두 창이 서로의 자리로 간다', () => {
    const plan = planLayout(
      layout([
        ['a', box(0, 0, 496, 600)],
        ['b', box(504, 0, 496, 600)],
      ]),
      layout([
        ['a', box(504, 0, 496, 600)],
        ['b', box(0, 0, 496, 600)],
      ]),
    )!;
    expect(plan.moves.map((m) => m.id).sort()).toEqual(['a', 'b']);
    expect(plan.enters).toEqual([]);
  });

  it('병합은 남는 창이 커지고 먹힌 창은 그 자리에서 흐려진다', () => {
    const plan = planLayout(
      layout([
        ['a', box(0, 0, 496, 600)],
        ['b', box(504, 0, 496, 600)],
      ]),
      layout([['a', box(0, 0, 1000, 600)]]),
    )!;
    expect(plan.moves).toEqual([{ id: 'a', from: box(0, 0, 496, 600), to: box(0, 0, 1000, 600) }]);
    expect(plan.exits).toEqual([{ id: 'b', at: box(504, 0, 496, 600) }]);
  });

  it('창을 닫으면 같은 자리의 새 빈 블럭이 제자리에서 나타날 뿐이다', () => {
    const plan = planLayout(
      layout([
        ['a', box(0, 0, 496, 600)],
        ['b', box(504, 0, 496, 600)],
      ]),
      layout([
        ['a', box(0, 0, 496, 600)],
        ['c', box(504, 0, 496, 600)],
      ]),
    )!;
    expect(plan.moves).toEqual([]);
    expect(plan.enters).toEqual([{ id: 'c', from: null, to: box(504, 0, 496, 600) }]);
    expect(plan.exits).toEqual([]);
  });

  it('아무것도 움직이지 않았으면 모션이 없다 — 파일을 열거나 터미널을 연 경우', () => {
    const same = layout([['a', box(0, 0, 1000, 600)]]);
    expect(planLayout(same, layout([['a', box(0.4, 0, 1000.3, 600)]]))).toBeNull();
  });

  it('이어지는 창이 하나도 없으면(세션 전환) 모션 없이 바꾼다', () => {
    expect(
      planLayout(layout([['a', box(0, 0, 10, 10)]]), layout([['z', box(0, 0, 10, 10)]])),
    ).toBeNull();
  });
});

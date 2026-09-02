/**
 * 스크롤 막대 기하 테스트.
 *
 * 이 파일이 지키려는 주장은 하나다 — **손잡이는 언제나 잡을 수 있는 크기이고, 그러면서도
 * 버퍼의 처음과 끝에 정확히 닿는다.** 8k 스크롤백에서 손잡이가 점이 되던 것이 원래 증상이라
 * 최소 길이를 강제하는데, 그 클램프가 도달 범위를 갉아먹지 않는지가 핵심이다.
 */

import { describe, expect, it } from 'vitest';

import {
  MIN_THUMB_PX,
  REL_PX_PER_STEP,
  type BarMetrics,
  dragStep,
  pageDirection,
  relDragOffset,
  relScrollSteps,
  relThumb,
  thumbOf,
  topFromOffset,
} from './scrollbar';

/** claude 가 한참 답한 뒤의 흔한 모양 — 스크롤백은 가득 찼고 창은 30줄이다. */
const FULL: BarMetrics = { maxTop: 8192, top: 0, rows: 30, trackPx: 300 };

describe('손잡이 크기', () => {
  it('스크롤할 것이 없으면 손잡이를 그리지 않는다', () => {
    expect(thumbOf({ maxTop: 0, top: 0, rows: 30, trackPx: 300 }).visible).toBe(false);
  });

  it('트랙이 0 이면 (아직 배치 전) 그리지 않는다', () => {
    expect(thumbOf({ ...FULL, trackPx: 0 }).visible).toBe(false);
  });

  it('8k 스크롤백에서도 최소 길이를 지킨다 — 비율대로면 1px 이다', () => {
    const ratio = Math.round((300 * 30) / (30 + 8192));
    expect(ratio).toBeLessThan(MIN_THUMB_PX);
    expect(thumbOf(FULL).sizePx).toBe(MIN_THUMB_PX);
  });

  it('확대해서 보이는 줄이 줄어도 최소값 아래로 안 내려간다', () => {
    // 배율을 올리면 rows 가 준다 (`pane.zoom` → fontSize → fit).
    for (const rows of [30, 20, 12, 6, 1]) {
      expect(thumbOf({ ...FULL, rows }).sizePx).toBeGreaterThanOrEqual(MIN_THUMB_PX);
    }
  });

  it('스크롤백이 적으면 비율 그대로다 — 최소값이 크기를 부풀리지 않는다', () => {
    const t = thumbOf({ maxTop: 30, top: 0, rows: 30, trackPx: 300 });
    expect(t.sizePx).toBe(150);
    expect(t.travelPx).toBe(150);
  });

  it('트랙이 최소 길이보다 짧으면 손잡이가 트랙을 채우고 넘치지 않는다', () => {
    const t = thumbOf({ ...FULL, trackPx: 20 });
    expect(t.sizePx).toBe(20);
    expect(t.travelPx).toBe(0);
  });
});

describe('손잡이 위치', () => {
  it('맨 위와 맨 아래에 정확히 닿는다 — 최소 길이로 잘려도', () => {
    const travel = thumbOf(FULL).travelPx;
    expect(thumbOf({ ...FULL, top: 0 }).offsetPx).toBe(0);
    expect(thumbOf({ ...FULL, top: 8192 }).offsetPx).toBe(travel);
  });

  it('버퍼 밖의 top 은 잘라서 본다', () => {
    expect(thumbOf({ ...FULL, top: -5 }).offsetPx).toBe(0);
    expect(thumbOf({ ...FULL, top: 99999 }).offsetPx).toBe(thumbOf(FULL).travelPx);
  });
});

describe('역변환 — 손잡이 위치에서 줄로', () => {
  it('양 끝이 버퍼의 처음과 끝이다', () => {
    const travel = thumbOf(FULL).travelPx;
    expect(topFromOffset(0, FULL)).toBe(0);
    expect(topFromOffset(travel, FULL)).toBe(8192);
  });

  it('트랙 밖으로 끌어도 0..maxTop 안에 머문다', () => {
    expect(topFromOffset(-500, FULL)).toBe(0);
    expect(topFromOffset(99999, FULL)).toBe(8192);
  });

  it('단조 증가한다 — 내릴수록 뒤쪽 줄이다', () => {
    const travel = thumbOf(FULL).travelPx;
    let prev = -1;
    for (let px = 0; px <= travel; px += 7) {
      const top = topFromOffset(px, FULL);
      expect(top).toBeGreaterThanOrEqual(prev);
      prev = top;
    }
  });

  it('왕복해도 1px 이 뜻하는 줄 수 안에서 돌아온다', () => {
    const { travelPx } = thumbOf(FULL);
    const rowsPerPx = Math.ceil(8192 / travelPx);
    for (const top of [0, 1, 500, 4000, 8191, 8192]) {
      const m = { ...FULL, top };
      const back = topFromOffset(thumbOf(m).offsetPx, m);
      expect(Math.abs(back - top)).toBeLessThanOrEqual(rowsPerPx);
    }
  });

  it('옮길 데가 없으면 (트랙이 손잡이보다 짧으면) 지금 줄을 그대로 돌려준다', () => {
    const m = { ...FULL, trackPx: 20, top: 4000 };
    expect(topFromOffset(0, m)).toBe(4000);
    expect(topFromOffset(999, m)).toBe(4000);
  });
});

describe('드래그', () => {
  it('잡은 지점을 뺀다 — 손잡이가 커서 밑으로 튀지 않는다', () => {
    // 손잡이 한가운데(18px 지점)를 잡고 트랙 100px 자리로 끌면 손잡이 위쪽은 82px 다.
    expect(dragStep(100, 18, FULL).offsetPx).toBe(82);
  });

  it('트랙 밖으로 끌어도 양 끝에 붙는다', () => {
    const travel = thumbOf(FULL).travelPx;
    expect(dragStep(-999, 18, FULL)).toEqual({ offsetPx: 0, top: 0 });
    expect(dragStep(9999, 18, FULL)).toEqual({ offsetPx: travel, top: 8192 });
  });

  it('출력이 쏟아져 지금 보는 줄이 흔들려도 결과가 같다 — top 을 읽지 않는다', () => {
    const still = dragStep(100, 18, { ...FULL, top: 0 });
    const streaming = dragStep(100, 18, { ...FULL, top: 7000 });
    expect(streaming).toEqual(still);
  });
});

describe('트랙 클릭', () => {
  it('손잡이 위쪽을 누르면 -1, 아래쪽을 누르면 +1, 손잡이 위면 0', () => {
    const m = { ...FULL, top: 4096 };
    const t = thumbOf(m);
    expect(pageDirection(t.offsetPx - 1, m)).toBe(-1);
    expect(pageDirection(t.offsetPx + 1, m)).toBe(0);
    expect(pageDirection(t.offsetPx + t.sizePx, m)).toBe(1);
  });

  it('스크롤할 것이 없으면 아무 쪽도 아니다', () => {
    expect(pageDirection(50, { maxTop: 0, top: 0, rows: 30, trackPx: 300 })).toBe(0);
  });
});

/**
 * 상대 모드 — 대체 화면(claude·vim·less)에는 스크롤백이 없어 "몇 번째 줄"이 없다.
 * 손잡이 자리는 뜻이 없고, **끈 거리**만 휠 칸 수로 바뀐다.
 */
describe('상대 모드', () => {
  it('손잡이는 고정 길이로 바닥에 선다', () => {
    const t = relThumb(300);
    expect(t.visible).toBe(true);
    expect(t.sizePx).toBe(MIN_THUMB_PX);
    expect(t.offsetPx).toBe(300 - MIN_THUMB_PX);
    expect(t.travelPx).toBe(300 - MIN_THUMB_PX);
  });

  it('트랙이 최소 길이보다 짧아도 넘치지 않는다', () => {
    const t = relThumb(20);
    expect(t.sizePx).toBe(20);
    expect(t.offsetPx).toBe(0);
  });

  it('아직 배치 전(트랙 0)이면 그리지 않는다', () => {
    expect(relThumb(0).visible).toBe(false);
  });

  it('끈 거리를 휠 칸 수로 바꾼다 — 위가 양수, 모자란 만큼은 버린다', () => {
    expect(relScrollSteps(REL_PX_PER_STEP * 10)).toBe(10);
    expect(relScrollSteps(-REL_PX_PER_STEP * 3)).toBe(-3);
    // 한 칸이 안 되면 아직 아무것도 보내지 않는다(0 쪽으로 버린다 — 부호가 뒤집히지 않게).
    expect(relScrollSteps(REL_PX_PER_STEP - 1)).toBe(0);
    expect(relScrollSteps(-(REL_PX_PER_STEP - 1))).toBe(0);
  });

  it('누적 총량이라 되돌려 끌면 그대로 되돌아온다', () => {
    const up = relScrollSteps(120);
    expect(relScrollSteps(0)).toBe(0);
    expect(up - relScrollSteps(60)).toBe(relScrollSteps(60));
  });

  it('손잡이는 포인터를 따라가되 트랙 밖으로 나가지 않는다', () => {
    const rest = 300 - MIN_THUMB_PX;
    expect(relDragOffset(rest, -60, 300)).toBe(rest - 60);
    expect(relDragOffset(rest, -9999, 300)).toBe(0);
    expect(relDragOffset(rest, 9999, 300)).toBe(rest);
  });
});

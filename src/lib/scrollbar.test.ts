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
  SPAN_HEAD_FRACTION,
  SPAN_MAX,
  type BarMetrics,
  type VirtualMetrics,
  clampSpan,
  dragStep,
  growSpan,
  pageDirection,
  spanFloor,
  thumbOf,
  topFromOffset,
  virtualGain,
  virtualTarget,
  virtualThumb,
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
 * 가상 뷰포트 — 대체 화면(claude·codex·vim·less)에는 스크롤백이 없어 "몇 번째 줄"이 없다.
 * 그래서 보낸 휠 칸을 세어 자리를 **추정**한다.
 *
 * 이 블록이 지키려는 주장은 셋이다.
 *
 * 1. **손잡이가 포인터에 붙는다.** 이득을 고정하면 사상이 `offsetPx = 시작자리 - 끈거리` 로
 *    펴진다 — 그래서 놓아도 자리가 튀지 않는다(예전 상대 모드가 바닥으로 되돌아가던 자리).
 * 2. **되돌려 끌면 그대로 되돌아온다.** 보낼 칸 수가 끈 거리의 순수 함수다.
 * 3. **꼭대기에 닿지 않는다.** 위쪽 끝은 알 수 없으므로 축척이 늘 여유를 남긴다.
 */
const V: VirtualMetrics = { rows: 30, trackPx: 300 };
/** 트랙 300px · 손잡이 36px → 움직일 거리 264px, 축척 하한 44칸(= 264/6). */
const V_TRAVEL = 300 - MIN_THUMB_PX;

describe('가상 뷰포트 — 축척', () => {
  it('하한은 한 화면과 travel/6 중 큰 쪽이다 — 예전 손맛(6px = 한 칸)이 여기서 온다', () => {
    expect(spanFloor(V)).toBe(V_TRAVEL / REL_PX_PER_STEP);
    // 줄이 아주 많은 창에서는 트랙을 다 훑어 적어도 한 화면은 가야 한다.
    expect(spanFloor({ ...V, rows: 120 })).toBe(120);
  });

  it('올라간 만큼 넓어지고 줄지는 않는다', () => {
    const floor = spanFloor(V);
    expect(growSpan(floor, 0, V)).toBe(floor);
    // 여유 안에 들어오면 그대로다.
    expect(growSpan(floor, floor * SPAN_HEAD_FRACTION, V)).toBe(floor);
    const grown = growSpan(floor, 40, V);
    expect(grown).toBeGreaterThan(floor);
    // 내려와도 좁아지지 않는다 — 한 번 겪은 넓이는 기억한다.
    expect(growSpan(grown, 0, V)).toBe(grown);
  });

  it('하한 아래로도 상한 위로도 나가지 않는다', () => {
    expect(clampSpan(1, V)).toBe(spanFloor(V));
    expect(clampSpan(Number.NaN, V)).toBe(spanFloor(V));
    expect(growSpan(spanFloor(V), 99999, V)).toBe(SPAN_MAX);
  });
});

describe('가상 뷰포트 — 손잡이', () => {
  it('길이는 고정이고 바닥에서는 트랙 아래에 선다', () => {
    const t = virtualThumb(0, spanFloor(V), V);
    expect(t.visible).toBe(true);
    expect(t.sizePx).toBe(MIN_THUMB_PX);
    expect(t.offsetPx).toBe(V_TRAVEL);
    expect(t.travelPx).toBe(V_TRAVEL);
  });

  it('축척이 자라도 길이는 그대로다 — 손 안에서 커졌다 작아지면 안 된다', () => {
    for (const span of [44, 100, 1000]) {
      expect(virtualThumb(10, span, V).sizePx).toBe(MIN_THUMB_PX);
    }
  });

  it('트랙이 최소 길이보다 짧아도 넘치지 않는다', () => {
    const t = virtualThumb(0, 44, { ...V, trackPx: 20 });
    expect(t.sizePx).toBe(20);
    expect(t.offsetPx).toBe(0);
  });

  it('아직 배치 전(트랙 0)이면 그리지 않는다', () => {
    expect(virtualThumb(0, 44, { ...V, trackPx: 0 }).visible).toBe(false);
  });

  it('올라갈수록 위로 간다 — 단조', () => {
    let span = spanFloor(V);
    let prev = V_TRAVEL + 1;
    for (const pos of [0, 5, 20, 44, 200, 900]) {
      span = growSpan(span, pos, V);
      const offset = virtualThumb(pos, span, V).offsetPx;
      expect(offset).toBeLessThanOrEqual(prev);
      prev = offset;
    }
  });

  it('꼭대기에는 닿지 않는다 — 위쪽 끝을 모르므로 축척이 여유를 남긴다', () => {
    let span = spanFloor(V);
    for (const pos of [44, 200, 700]) {
      span = growSpan(span, pos, V);
      expect(virtualThumb(pos, span, V).offsetPx).toBeGreaterThan(0);
    }
  });

  it('축척 상한을 넘어서면 꼭대기에 머문다 — 더는 담을 수 없다는 뜻이다', () => {
    const span = growSpan(spanFloor(V), 99999, V);
    expect(virtualThumb(99999, span, V).offsetPx).toBe(0);
  });
});

describe('가상 뷰포트 — 드래그', () => {
  const span = spanFloor(V);
  const gain = virtualGain(span, V);

  it('손잡이가 포인터에 정확히 붙는다 — 이득이 고정이면 사상이 그렇게 펴진다', () => {
    for (const pos0 of [0, 5, 20]) {
      const startPx = virtualThumb(pos0, span, V).offsetPx;
      for (const moved of [0, 12, 60, 120]) {
        const pos = virtualTarget(pos0, moved, gain);
        // 여유 구간(고무줄)에 들어가면 더 이상 1:1 이 아니다 — 거기는 별도 주장이다.
        if (growSpan(span, pos, V) !== span) continue;
        expect(virtualThumb(pos, span, V).offsetPx).toBe(startPx - moved);
      }
    }
  });

  it('되돌려 끌면 그대로 되돌아온다 — 보낼 칸 수가 끈 거리의 순수 함수다', () => {
    const pos0 = 20;
    expect(virtualTarget(pos0, 0, gain)).toBe(pos0);
    const up = virtualTarget(pos0, 60, gain) - pos0;
    const down = pos0 - virtualTarget(pos0, -60, gain);
    expect(up).toBeCloseTo(down);
    // 왕복 합이 0 이다.
    expect(virtualTarget(virtualTarget(pos0, 60, gain), -60, gain)).toBeCloseTo(pos0);
  });

  it('바닥 아래로는 내려가지 않는다', () => {
    expect(virtualTarget(5, -9999, gain)).toBe(0);
    expect(virtualTarget(0, -1, gain)).toBe(0);
  });

  it('겪어 보지 못한 구간에서는 손잡이가 "여기가 끝자락" 자리에 머문다', () => {
    // 축척이 `pos` 를 따라 자라므로 비율이 고정된다 — 손잡이가 트랙 위쪽 1/4 지점에 선다.
    // 1:1 이라면 벌써 꼭대기를 지나쳤을 거리인데도 닿지 않는다: 위쪽 끝을 모르기 때문이다.
    const frontier = Math.round(V_TRAVEL * (1 - SPAN_HEAD_FRACTION));
    let live = span;
    for (const moved of [V_TRAVEL, V_TRAVEL * 2, V_TRAVEL * 4]) {
      const pos = virtualTarget(0, moved, gain);
      live = growSpan(live, pos, V);
      const offset = virtualThumb(pos, live, V).offsetPx;
      expect(offset).toBeGreaterThan(0);
      // 축척을 정수로 두는 탓에 1px 안에서 흔들린다.
      expect(Math.abs(offset - frontier)).toBeLessThanOrEqual(2);
    }
  });

  it('옮길 데가 없으면 (트랙이 손잡이보다 짧으면) 이득이 0 이다', () => {
    expect(virtualGain(44, { ...V, trackPx: 20 })).toBe(0);
    expect(virtualTarget(7, 500, 0)).toBe(7);
  });
});

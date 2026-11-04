/**
 * 배치가 바뀔 때의 연속성 — 분할 · 병합 · 교환 · 닫기 · 전체화면.
 *
 * 격자가 바뀌면 창들이 한 프레임에 새 자리로 순간이동한다. 무엇이 어디로 갔는지 눈이 따라가지
 * 못해서, 방금 나눈 창이 어느 것인지·교환이 됐는지를 제목을 읽어 확인해야 했다.
 *
 * 흔한 FLIP(창 자체에 `transform: scale`)은 쓰지 않는다. 터미널 글자가 늘어나고 찌그러지고,
 * 크기를 매 프레임 바꾸면 xterm 이 다시 맞추며 ConPTY 까지 다시 그린다. 대신 창은 **곧바로 새
 * 자리에서** 그려 두고, 그 위로 **윤곽만** 옛 자리에서 새 자리로 움직인다. 창 내용은 제자리에서
 * 살짝 밝아질 뿐이라 다음 키는 곧바로 먹는다.
 *
 * 순서: 스냅샷을 갈아 끼우기 직전에 `captureLayout`(store 의 `apply`), 그려진 직후에 `playLayout`
 * (`PaneGrid` 의 layout effect). 계산은 `planLayout` 하나로 모여 있어 표로 검증한다.
 */

import { DUR_3, EASE_OUT, motionAllowed } from './motion';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LayoutPlan {
  /** 자리나 크기가 바뀐 창 — 윤곽이 옛 자리에서 새 자리로. */
  moves: { id: string; from: Box; to: Box }[];
  /** 새로 생긴 창. 옛 창 안에서 나왔으면(분할) 그 가르는 선에서 펼쳐지고, 아니면 제자리에서 나타난다. */
  enters: { id: string; from: Box | null; to: Box }[];
  /** 사라진 창 — 그 자리에서 윤곽이 흐려진다(병합으로 먹힌 창). */
  exits: { id: string; at: Box }[];
}

/** 1px 안쪽의 차이는 반올림 오차다. */
const near = (a: number, b: number) => Math.abs(a - b) < 1;
const sameBox = (a: Box, b: Box) =>
  near(a.left, b.left) && near(a.top, b.top) && near(a.width, b.width) && near(a.height, b.height);
const contains = (outer: Box, inner: Box) =>
  inner.left >= outer.left - 1 &&
  inner.top >= outer.top - 1 &&
  inner.left + inner.width <= outer.left + outer.width + 1 &&
  inner.top + inner.height <= outer.top + outer.height + 1;

/**
 * 두 배치 사이에 무엇이 움직였는가. 아무것도 이어지지 않으면(세션을 옮겼다) `null` — 모션 없이 바꾼다.
 */
export function planLayout(before: Map<string, Box>, after: Map<string, Box>): LayoutPlan | null {
  const kept = [...after.keys()].filter((id) => before.has(id));
  if (kept.length === 0) return null;

  const moves: LayoutPlan['moves'] = [];
  for (const id of kept) {
    const from = before.get(id)!;
    const to = after.get(id)!;
    if (!sameBox(from, to)) moves.push({ id, from, to });
  }

  const enters: LayoutPlan['enters'] = [];
  for (const [id, to] of after) {
    if (before.has(id)) continue;
    // 옛 창 하나가 이 자리를 품고 있었다면 그 창을 나눠 생긴 것이다 — 가르는 선에서 펼친다.
    const parent = [...before.values()].find((b) => contains(b, to) && !sameBox(b, to));
    let from: Box | null = null;
    if (parent) {
      if (to.left - parent.left > 1) from = { left: to.left, top: to.top, width: 0, height: to.height };
      else if (to.top - parent.top > 1) from = { left: to.left, top: to.top, width: to.width, height: 0 };
    }
    enters.push({ id, from, to });
  }

  const exits: LayoutPlan['exits'] = [];
  for (const [id, at] of before) {
    if (after.has(id)) continue;
    // 닫힌 창은 같은 자리의 새 빈 블럭으로 바뀐다 — 그 자리는 새 블럭이 나타나는 것으로 충분하다.
    if (enters.some((e) => sameBox(e.to, at))) continue;
    exits.push({ id, at });
  }

  if (moves.length === 0 && enters.length === 0 && exits.length === 0) return null;
  return { moves, enters, exits };
}

/** 지금 격자의 창 자리들. 전체화면 뒤에 숨은 창은 보이지 않으므로 뺀다. */
function measure(): Map<string, Box> {
  const out = new Map<string, Box>();
  document.querySelectorAll<HTMLElement>('.grid > [data-pane]').forEach((el) => {
    if (el.classList.contains('pane--behind')) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    out.set(el.dataset.pane!, { left: r.left, top: r.top, width: r.width, height: r.height });
  });
  return out;
}

/** 스냅샷을 갈아 끼운 뒤 이 시간 안에 그려지지 않으면 그 기억은 버린다(다른 렌더에 엉뚱하게 붙지 않게). */
const STALE_MS = 400;

let pending: { at: number; session: string; boxes: Map<string, Box> } | null = null;

/** 스냅샷을 갈아 끼우기 **직전**에 부른다. */
export function captureLayout(sessionId: string | undefined) {
  if (!sessionId || !motionAllowed()) {
    pending = null;
    return;
  }
  pending = { at: performance.now(), session: sessionId, boxes: measure() };
}

const px = (b: Box) => ({
  left: `${b.left}px`,
  top: `${b.top}px`,
  width: `${b.width}px`,
  height: `${b.height}px`,
});

/** 윤곽이 옛 자리에서 새 자리로 가는 데 쓰는 시간의 전부 — 이동 3/4, 도착 뒤 사라짐 1/4. */
const FRAME_MS = DUR_3 + 60;

/** 화면 위에 잠깐 떠서 옛 자리 → 새 자리로 가는 윤곽. 창 내용과 무관한 빈 상자라 늘어나도 티가 안 난다. */
function frame(from: Box, to: Box | null) {
  const el = document.createElement('div');
  el.className = 'layout-frame';
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, px(from));
  document.body.appendChild(el);
  // 움직이는 동안은 또렷하게, 도착한 뒤에 빠진다 — 움직이며 흐려지면 어디로 갔는지 놓친다.
  const keyframes: Keyframe[] = to
    ? [
        { ...px(from), opacity: 1, easing: EASE_OUT },
        { ...px(to), opacity: 1, offset: 0.75 },
        { ...px(to), opacity: 0 },
      ]
    : [{ opacity: 1 }, { opacity: 0 }];
  const duration = to ? FRAME_MS : DUR_3;
  const done = () => el.remove();
  if (typeof el.animate !== 'function') return done();
  const anim = el.animate(keyframes, { duration, fill: 'forwards' });
  anim.onfinish = done;
  anim.oncancel = done;
  // 탭이 가려져 애니메이션이 멈춰도 남지 않게.
  window.setTimeout(done, duration + 200);
}

function brighten(id: string, from: number) {
  const el = document.querySelector<HTMLElement>(`.grid > [data-pane="${CSS.escape(id)}"]`);
  if (!el || typeof el.animate !== 'function') return;
  el.animate([{ opacity: from }, { opacity: 1 }], { duration: DUR_3, easing: EASE_OUT });
}

/** 새 배치가 그려진 **직후**에 부른다. 기억이 없거나 다른 세션이면 아무것도 하지 않는다. */
export function playLayout(sessionId: string) {
  const p = pending;
  pending = null;
  if (!p || p.session !== sessionId || performance.now() - p.at > STALE_MS || !motionAllowed()) return;
  const plan = planLayout(p.boxes, measure());
  if (!plan) return;
  for (const m of plan.moves) {
    frame(m.from, m.to);
    brighten(m.id, 0.6);
  }
  for (const e of plan.enters) {
    if (e.from) frame(e.from, e.to);
    brighten(e.id, e.from ? 0.2 : 0.4);
  }
  for (const x of plan.exits) frame(x.at, null);
}

/**
 * 거부된 조작을 창이 직접 알린다 — 짧게 좌우로 흔든다(병합 불가).
 *
 * `translate` 만 쓰므로 터미널 글자가 찌그러지지 않는다. 토스트가 사유를 적고, 흔들림은 "어느 창
 * 들이" 를 알려 준다.
 */
export function shakePanes(ids: string[]) {
  if (!motionAllowed()) return;
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(`.grid > [data-pane="${CSS.escape(id)}"]`);
    if (!el || typeof el.animate !== 'function') continue;
    el.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-5px)' },
        { transform: 'translateX(4px)' },
        { transform: 'translateX(-2px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: DUR_3, easing: EASE_OUT },
    );
  }
}

/** 테스트용 — 남아 있는 기억을 버린다. */
export function resetLayoutMotion() {
  pending = null;
}


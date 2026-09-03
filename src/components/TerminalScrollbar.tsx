import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';

import {
  type BarMetrics,
  type Thumb,
  type VirtualMetrics,
  dragStep,
  growSpan,
  pageDirection,
  sideOf,
  spanFloor,
  thumbOf,
  virtualGain,
  virtualTarget,
  virtualThumb,
} from '../lib/scrollbar';
import {
  type WheelSender,
  createWheelSender,
  isSyntheticWheel,
  trackingMode,
  wheelNotches,
  wheelRequested,
} from '../lib/termWheel';
import type { AiKind } from '../state/types';

/** 막대 위에서 휠을 한 칸 굴렸을 때 넘길 줄 수. */
const WHEEL_LINES = 3;

/** 끄는 중일 때만 채워진다. */
type Drag =
  /** 절대 모드 — `offsetPx` 는 포인터가 정한 손잡이 자리다. */
  | { mode: 'absolute'; grabPx: number; offsetPx: number }
  /**
   * 가상 모드 — 자리는 `pos` 가 정하고, 여기서는 **이득을 붙잡아 둔다.** 제스처 안에서 이득이
   * 변하지 않아야 보내는 칸 수가 끈 거리의 순수 함수가 되고, 되돌려 끌면 그대로 되돌아온다.
   * `sent` 는 이 제스처에서 지금까지 보낸 칸 수다(`pos0` 기준).
   */
  | { mode: 'virtual'; startY: number; gain: number; pos0: number; sent: number };

/**
 * 터미널 스크롤 막대.
 *
 * 브라우저 기본 스크롤바 대신 앱이 직접 그린다. 이유는 두 가지다.
 *
 * - **크기** — 8k 스크롤백이 다 차면 기본 손잡이가 점이 되어 잡을 수가 없다. 여기서는
 *   `lib/scrollbar` 가 최소 길이를 보장한다.
 * - **드래그** — claude·codex 처럼 출력을 쏟아내는 프로그램 밑에서는 손잡이가 커서에서
 *   빠져나간다. 버퍼가 가득 찬 뒤에도 xterm 이 스크롤을 올려 둔 사용자를 위해 줄이 밀려날
 *   때마다 `ydisp` 를 하나씩 줄이기 때문이다 — 글자는 제자리인데 손잡이만 위로 기어오른다.
 *   그래서 **끄는 동안에는 손잡이 자리를 포인터가 쥐고**, 버퍼발 갱신은 길이만 건드린다.
 *
 * 모드가 둘이다. **절대 모드**(일반 버퍼)는 손잡이 자리가 곧 보는 줄이라 `scrollToLine` 으로
 * 옮긴다. **가상 모드**(대체 화면)는 xterm 스크롤백이 없어 옮길 것이 없으므로, 움직인 거리를
 * 휠로 바꿔 프로그램에 보내고(`lib/termWheel`) **보낸 칸을 세어 자리를 추정한다**
 * (`lib/scrollbar` 의 가상 뷰포트). claude 가 대체 화면에서 자기 대화이력을 넘기는 길이 바로
 * 그 휠이다. 추정치라 위쪽 끝은 알 수 없지만, 바닥은 한 화면치를 더 내려 보내 확정할 수 있다.
 *
 * 기하는 전부 `lib/scrollbar` 에 있고 여기서는 배선만 한다. 손잡이의 크기·위치는 리액트 상태가
 * 아니라 DOM 에 직접 쓴다 — claude 가 답하는 내내 프레임마다 불리는 자리라 상태로 두면
 * 그동안 리액트 렌더가 같이 돈다.
 */
export function TerminalScrollbar({ term, ai }: { term: Terminal; ai?: AiKind | null }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [relative, setRelative] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  /** 바닥에서 위로 올라간 휠 칸 수(추정). 소수를 유지한다 — 보낼 때만 반올림한다. */
  const posRef = useRef(0);
  /** 트랙 전체가 뜻하는 칸 수(축척). */
  const spanRef = useRef(0);
  /** 마지막으로 본 마우스 보고 모드. 바뀌면 한 칸이 뜻하는 줄 수가 달라진다. */
  const modeRef = useRef<string | null>(null);
  const senderRef = useRef<WheelSender | null>(null);

  /** 대체 화면인가 — 스크롤백이 없어 막대가 추정으로 도는 자리다. */
  const isVirtual = useCallback(() => term.buffer.active.type === 'alternate', [term]);

  /** 지금 터미널 상태. 아직 배치 전이면 `null`. */
  const metrics = useCallback((): BarMetrics | null => {
    const track = trackRef.current;
    if (!track) return null;
    const buf = term.buffer.active;
    return {
      maxTop: buf.baseY,
      top: buf.viewportY,
      rows: term.rows,
      trackPx: track.getBoundingClientRect().height,
    };
  }, [term]);

  /** 추정치를 처음으로 되돌린다 — 대체 화면을 드나들 때, 마우스 보고 모드가 바뀔 때. */
  const reset = useCallback((m: VirtualMetrics) => {
    posRef.current = 0;
    spanRef.current = spanFloor(m);
    senderRef.current?.cancel();
  }, []);

  const paint = useCallback(() => {
    const m = metrics();
    const virt = isVirtual();
    setRelative(virt);
    if (!m) {
      setVisible(false);
      return;
    }

    if (virt) {
      // 마우스 보고가 켜지고 꺼지면 한 칸이 뜻하는 줄 수가 3배쯤 달라진다 — 축척의 의미가
      // 바뀌므로 다시 배운다. xterm 에 모드 변경 이벤트가 없어 여기서 값을 본다(싼 getter 다).
      const mode = trackingMode(term);
      if (modeRef.current === null) modeRef.current = mode;
      else if (mode !== modeRef.current && !dragRef.current) {
        // 끄는 중이면 미뤄 둔다 — 손 안에서 축척이 초기화되면 손잡이가 튄다. 다음 칠 때 한다.
        modeRef.current = mode;
        reset(m);
      }
      // 창 크기·배율이 바뀌어도 축척이 제 범위에 있게 하고, 올라간 만큼 넓힌다.
      spanRef.current = growSpan(spanRef.current, posRef.current, m);
    }

    const t: Thumb = virt ? virtualThumb(posRef.current, spanRef.current, m) : thumbOf(m);
    setVisible(t.visible);
    const thumb = thumbRef.current;
    if (!thumb || !t.visible) return;
    thumb.style.height = `${t.sizePx}px`;
    // 절대 모드에서 끄는 중이면 자리는 포인터의 것이다. 가상 모드는 사상 하나로 그린다 —
    // 이득이 고정이라 그 식이 이미 포인터에 붙어 있고, 그래서 놓아도 자리가 튀지 않는다.
    const drag = dragRef.current;
    thumb.style.top = `${drag?.mode === 'absolute' ? drag.offsetPx : t.offsetPx}px`;
  }, [metrics, isVirtual, term, reset]);

  /** 대체 화면에서 `notches` 칸(위가 양수) 굴리고 추정치를 함께 옮긴다. */
  const nudge = useCallback(
    (notches: number) => {
      if (!notches) return;
      // 아래로는 추정치보다 더 보내도 좋다 — 적게 세고 있었더라도 진짜 바닥에 닿는다.
      senderRef.current?.by(notches);
      posRef.current = Math.max(0, posRef.current + notches);
      paint();
    },
    [paint],
  );

  // 손잡이는 보일 때만 붙으므로 붙은 직후 한 번 더 칠한다 — 첫 프레임이 비지 않게.
  useLayoutEffect(paint, [visible, paint]);

  const frame = useRef(0);
  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      paint();
    });
  }, [paint]);

  // 휠 손잡이의 수명은 터미널에 묶인다 — dispose 뒤에 떠 있는 드레인이 없게.
  useEffect(() => {
    const sender = createWheelSender(term);
    senderRef.current = sender;
    return () => {
      sender.cancel();
      senderRef.current = null;
    };
  }, [term]);

  useEffect(() => {
    schedule();
    const subs = [
      // onRender 가 주 신호다. 휠 스크롤은 xterm 이 onScroll 을 눌러 두므로(suppressScrollEvent)
      // 여기로만 들어오고, 출력으로 버퍼가 자라는 것도 렌더로 알 수 있다.
      term.onRender(schedule),
      term.onScroll(schedule),
      // 배율 변경(fontSize → fit.fit())과 창 크기 변경이 여기로 온다.
      term.onResize(schedule),
      // 대체 화면을 드나들면 추정치는 뜻을 잃는다.
      term.buffer.onBufferChange(() => {
        const m = metrics();
        if (m) reset(m);
        schedule();
      }),
    ];
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      subs.forEach((s) => s.dispose());
    };
  }, [term, schedule, metrics, reset]);

  // 본문에서 굴린 **진짜** 휠도 추정치에 접는다. 안 접으면 사용자가 화면에서 휠을 굴렸을 때
  // 프로그램만 움직이고 손잡이는 가만히 있어 막대가 거짓말을 한다. 우리가 만든 휠은 건너뛴다.
  useEffect(() => {
    const el = term.element;
    if (!el) return;
    const onRealWheel = (ev: WheelEvent) => {
      if (isSyntheticWheel(ev) || ev.ctrlKey || !isVirtual()) return;
      const n = wheelNotches(term, ev);
      if (!n) return;
      posRef.current = Math.max(0, posRef.current + n);
      schedule();
    };
    el.addEventListener('wheel', onRealWheel, { capture: true, passive: true });
    return () => el.removeEventListener('wheel', onRealWheel, { capture: true });
  }, [term, isVirtual, schedule]);

  // 끄는 동안은 막대 밖으로 나가도 좌표를 받아야 하므로 창 전체에 건다 (ResizeHandles 와 같은 방식).
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const track = trackRef.current;
      const thumb = thumbRef.current;
      const m = metrics();
      if (!drag || !track || !thumb || !m) return;

      if (drag.mode === 'virtual') {
        const pos = virtualTarget(drag.pos0, drag.startY - e.clientY, drag.gain);
        // 보내는 것은 정수 칸이지만 자리는 소수로 들고 있는다 — 그래야 손잡이가 포인터에 붙는다.
        const want = Math.round(pos) - Math.round(drag.pos0);
        senderRef.current?.by(want - drag.sent);
        drag.sent = want;
        posRef.current = pos;
        paint();
        return;
      }

      const step = dragStep(e.clientY - track.getBoundingClientRect().top, drag.grabPx, m);
      drag.offsetPx = step.offsetPx;
      // 프레임을 기다리지 않고 바로 옮긴다 — 손잡이가 커서에서 떨어지면 안 된다.
      thumb.style.top = `${step.offsetPx}px`;
      term.scrollToLine(step.top);
    };

    const onUp = () => {
      const drag = dragRef.current;
      const m = metrics();
      dragRef.current = null;
      setDragging(false);
      if (drag?.mode === 'virtual' && drag.pos0 > 0 && posRef.current <= 0 && m) {
        // 위에서 바닥까지 끌어내렸다 — 한 화면치를 더 내려 보내 **진짜 바닥**임을 확정한다.
        // 프로그램이 알아서 잘라 내므로 넘치게 보내도 무해하고, 이것이 추정치가 아래쪽으로
        // 어긋났을 때 스스로 낫는 유일한 길이다.
        //
        // 단 화살표 경로에서는 보내지 않는다. 마우스 보고를 켜지 않은 프로그램에게 그 휠은
        // ↓ 키다 — claude 의 입력창에서는 히스토리 탐색이고 fzf 에서는 선택 이동이다.
        if (wheelRequested(term)) senderRef.current?.by(-Math.max(1, m.rows));
        posRef.current = 0;
      }
      schedule();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, metrics, paint, schedule, term]);

  const onThumbDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const track = trackRef.current;
    const m = metrics();
    if (!track || !m) return;
    // 터미널이 포커스를 잃지 않게, 그리고 창 선택·병합 드래그가 함께 시작되지 않게 막는다.
    e.preventDefault();
    e.stopPropagation();
    if (isVirtual()) {
      dragRef.current = {
        mode: 'virtual',
        startY: e.clientY,
        // 이득은 여기서 한 번만 잰다 — 축척이 손 안에서 자라도 손맛이 변하지 않게.
        gain: virtualGain(spanRef.current, m),
        pos0: posRef.current,
        sent: 0,
      };
    } else {
      const thumbTop = e.currentTarget.getBoundingClientRect().top;
      dragRef.current = {
        mode: 'absolute',
        grabPx: e.clientY - thumbTop,
        offsetPx: thumbTop - track.getBoundingClientRect().top,
      };
    }
    setDragging(true);
  };

  const onTrackDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const m = metrics();
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    const pointerPx = e.clientY - e.currentTarget.getBoundingClientRect().top;
    if (isVirtual()) {
      // 한 화면 = `rows` 칸. `DELTA_PAGE` 한 번으로는 안 된다 — xterm 의 `deltaY × rows` 확장은
      // 화살표 경로에만 있고 SGR 보고에는 크기가 실리지 않아 한 칸만 간다.
      const side = sideOf(pointerPx, virtualThumb(posRef.current, spanRef.current, m));
      nudge(-side * Math.max(1, m.rows));
      return;
    }
    const dir = pageDirection(pointerPx, m);
    if (dir) term.scrollPages(dir);
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // 막대는 `.xterm` 밖이라 xterm 의 휠 처리기가 못 본다. 대신 굴려 준다.
    // 단 Ctrl+휠 은 창 확대다 — App 의 전역 처리기가 가져가도록 그대로 흘려보낸다.
    if (e.ctrlKey) return;
    const lines = Math.sign(e.deltaY) * WHEEL_LINES;
    if (isVirtual()) {
      nudge(-lines);
      return;
    }
    term.scrollLines(lines);
  };

  return (
    <div
      ref={trackRef}
      className={[
        'term-scrollbar',
        visible ? '' : 'term-scrollbar--off',
        // claude·codex 가 도는 창에서는 늘 또렷하게 — 거기서는 막대가 사실상 유일한 스크롤 수단이다.
        ai ? 'term-scrollbar--pinned' : '',
        relative ? 'term-scrollbar--relative' : '',
        dragging ? 'term-scrollbar--dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={
        relative
          ? '스크롤 — 끌어서 프로그램에 휠을 보낸다 · 자리는 추정치 · 빈 곳을 누르면 한 화면'
          : '스크롤 — 끌어서 이동 · 빈 곳을 누르면 한 화면'
      }
      onMouseDown={onTrackDown}
      onWheel={onWheel}
    >
      {visible && (
        <div ref={thumbRef} className="term-scrollbar__thumb" onMouseDown={onThumbDown} />
      )}
    </div>
  );
}

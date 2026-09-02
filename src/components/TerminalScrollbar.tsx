import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';

import { type BarMetrics, dragStep, pageDirection, thumbOf } from '../lib/scrollbar';
import type { AiKind } from '../state/types';

/** 막대 위에서 휠을 한 칸 굴렸을 때 넘길 줄 수. */
const WHEEL_LINES = 3;

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
 * 기하는 전부 `lib/scrollbar` 에 있고 여기서는 배선만 한다. 손잡이의 크기·위치는 리액트 상태가
 * 아니라 DOM 에 직접 쓴다 — claude 가 답하는 내내 프레임마다 불리는 자리라 상태로 두면
 * 그동안 리액트 렌더가 같이 돈다.
 */
export function TerminalScrollbar({ term, ai }: { term: Terminal; ai?: AiKind | null }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 끄는 중일 때만 채워진다. `offsetPx` 는 포인터가 정한 손잡이 자리다. */
  const dragRef = useRef<{ grabPx: number; offsetPx: number } | null>(null);

  /** 지금 터미널 상태. 대체 화면이거나 아직 배치 전이면 `null`. */
  const metrics = useCallback((): BarMetrics | null => {
    const track = trackRef.current;
    if (!track) return null;
    const buf = term.buffer.active;
    // vim·less·tmux 의 대체 화면에는 스크롤백이 없다 — 스크롤할 것이 없으니 막대도 없다.
    if (buf.type === 'alternate') return null;
    return {
      maxTop: buf.baseY,
      top: buf.viewportY,
      rows: term.rows,
      trackPx: track.getBoundingClientRect().height,
    };
  }, [term]);

  const paint = useCallback(() => {
    const m = metrics();
    const t = m ? thumbOf(m) : null;
    setVisible(!!t?.visible);
    const thumb = thumbRef.current;
    if (!thumb || !t?.visible) return;
    thumb.style.height = `${t.sizePx}px`;
    // 끄는 중이면 자리는 포인터의 것이다. 길이는 계속 따라가도 된다.
    thumb.style.top = `${dragRef.current ? dragRef.current.offsetPx : t.offsetPx}px`;
  }, [metrics]);

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

  useEffect(() => {
    schedule();
    const subs = [
      // onRender 가 주 신호다. 휠 스크롤은 xterm 이 onScroll 을 눌러 두므로(suppressScrollEvent)
      // 여기로만 들어오고, 출력으로 버퍼가 자라는 것도 렌더로 알 수 있다.
      term.onRender(schedule),
      term.onScroll(schedule),
      // 배율 변경(fontSize → fit.fit())과 창 크기 변경이 여기로 온다.
      term.onResize(schedule),
      term.buffer.onBufferChange(schedule),
    ];
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      subs.forEach((s) => s.dispose());
    };
  }, [term, schedule]);

  // 끄는 동안은 막대 밖으로 나가도 좌표를 받아야 하므로 창 전체에 건다 (ResizeHandles 와 같은 방식).
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const track = trackRef.current;
      const thumb = thumbRef.current;
      const m = metrics();
      if (!drag || !track || !thumb || !m) return;
      const step = dragStep(e.clientY - track.getBoundingClientRect().top, drag.grabPx, m);
      drag.offsetPx = step.offsetPx;
      // 프레임을 기다리지 않고 바로 옮긴다 — 손잡이가 커서에서 떨어지면 안 된다.
      thumb.style.top = `${step.offsetPx}px`;
      term.scrollToLine(step.top);
    };

    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      // 놓고 나면 다시 버퍼가 말하는 자리로 맞춘다.
      schedule();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, metrics, schedule, term]);

  const onThumbDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const track = trackRef.current;
    if (!track) return;
    // 터미널이 포커스를 잃지 않게, 그리고 창 선택·병합 드래그가 함께 시작되지 않게 막는다.
    e.preventDefault();
    e.stopPropagation();
    const trackTop = track.getBoundingClientRect().top;
    const thumbTop = e.currentTarget.getBoundingClientRect().top;
    dragRef.current = { grabPx: e.clientY - thumbTop, offsetPx: thumbTop - trackTop };
    setDragging(true);
  };

  const onTrackDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const m = metrics();
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = pageDirection(e.clientY - e.currentTarget.getBoundingClientRect().top, m);
    if (dir) term.scrollPages(dir);
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // 막대는 `.xterm` 밖이라 xterm 의 휠 처리기가 못 본다. 대신 굴려 준다.
    // 단 Ctrl+휠 은 창 확대다 — App 의 전역 처리기가 가져가도록 그대로 흘려보낸다.
    if (e.ctrlKey) return;
    term.scrollLines(Math.sign(e.deltaY) * WHEEL_LINES);
  };

  return (
    <div
      ref={trackRef}
      className={[
        'term-scrollbar',
        visible ? '' : 'term-scrollbar--off',
        // claude·codex 가 도는 창에서는 늘 또렷하게 — 거기서는 막대가 사실상 유일한 스크롤 수단이다.
        ai ? 'term-scrollbar--pinned' : '',
        dragging ? 'term-scrollbar--dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title="스크롤 — 끌어서 이동 · 빈 곳을 누르면 한 화면"
      onMouseDown={onTrackDown}
      onWheel={onWheel}
    >
      {visible && (
        <div ref={thumbRef} className="term-scrollbar__thumb" onMouseDown={onThumbDown} />
      )}
    </div>
  );
}

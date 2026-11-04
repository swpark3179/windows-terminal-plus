/**
 * 모션 공용 손잡이.
 *
 * 원칙은 하나다 — **입력을 기다리게 하는 모션은 두지 않는다.** 터미널 앱이라 사용자는 거의 늘
 * 다음 키를 치고 있다. 그래서 모션은 짧고(90~220ms), 위치·크기가 어디서 어디로 갔는지를 보여 주는
 * 데만 쓰고, 모션이 도는 동안에도 다음 조작은 곧바로 먹는다. 시간·곡선 값은 `app.css` 의
 * `--dur-*`·`--ease-*` 와 같은 값이다.
 */

import { type MutableRefObject, useCallback, useRef } from 'react';

/** `--dur-1` — 퇴장·작은 상태 변화. */
export const DUR_1 = 90;
/** `--dur-2` — 진입·배치 이동. */
export const DUR_2 = 160;
/** `--dur-3` — 큰 배치 변화(분할·병합·전체화면). */
export const DUR_3 = 220;
/** `--ease-out` — 빠르게 출발해 부드럽게 멈춘다. 들어오는 것, 옮겨 가는 것. */
export const EASE_OUT = 'cubic-bezier(.2, .8, .2, 1)';

/**
 * 지금 모션을 써도 되는가.
 *
 * 윈도우의 "애니메이션 효과" 를 끄면 웹뷰에 `prefers-reduced-motion: reduce` 가 걸린다. 판정할 수
 * 없는 환경(jsdom 등 `matchMedia` 가 없는 곳)에서도 모션을 건너뛴다 — 모션은 덤이라 없어도 무엇
 * 하나 깨지지 않아야 한다.
 */
export function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 퇴장 모션이 끝난 뒤 복제본을 걷어 내기까지의 여유. CSS 의 퇴장 시간(`--dur-1`)보다 길어야 한다. */
export const EXIT_MS = DUR_1 + 60;

/**
 * 방금 떼어 낸 노드의 모습을 복제해 그 자리에서 퇴장 모션을 돌린 뒤 지운다.
 *
 * 오버레이(메뉴·팔레트·모달·토스트)는 닫히는 순간 리액트가 노드를 지워 퇴장 모션을 돌릴 틈이 없다.
 * 컴포넌트마다 "닫는 중" 상태를 따로 들게 하면 닫힌 뒤에도 키·클릭 처리기가 살아 있는 구간이 생긴다.
 * 그래서 상태는 즉시 닫고(다음 조작은 곧바로 먹는다), **보이는 모습만** 복제해 잠깐 남긴다.
 *
 * 복제본은 리액트 밖의 정적 DOM 이라 처리기가 없고, `inert`·`pointer-events: none` 이라 클릭도
 * 포커스도 받지 않는다. 오버레이는 모두 `position: fixed` 라 `body` 에 붙여도 같은 자리에 선다.
 */
export function playExit(node: HTMLElement, ms = EXIT_MS): HTMLElement | null {
  if (!motionAllowed()) return null;
  const ghost = node.cloneNode(true) as HTMLElement;
  // `cloneNode` 는 입력칸의 **현재 값**(속성이 아니라 프로퍼티)을 옮기지 않는다 — 친 글자가 사라진 채
  // 빠지면 깜빡여 보인다.
  const from = node.querySelectorAll<HTMLInputElement>('input, textarea, select');
  const to = ghost.querySelectorAll<HTMLInputElement>('input, textarea, select');
  from.forEach((el, i) => {
    if (to[i]) to[i].value = el.value;
  });
  // 같은 id 가 둘이 되면 `label[for]` 나 `getElementById` 가 복제본을 가리킬 수 있다.
  ghost.removeAttribute('id');
  ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  ghost.setAttribute('data-exit', '');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  window.setTimeout(() => ghost.remove(), ms);
  return ghost;
}

/**
 * 오버레이의 뿌리 노드에 거는 ref. 그 노드가 사라지거나(닫힘) 다른 노드로 바뀌면(토스트가 새 글로
 * 갈아 끼워짐) 옛 노드로 퇴장 모션을 돌린다.
 *
 * `also` 에 ref 객체를 주면 같은 노드를 거기에도 적는다 — 크기를 재려고 이미 ref 를 쓰는 곳(메뉴)을
 * 위해서다. 콜백 ref 는 **같은 함수**여야 한다: 매 렌더 새 함수를 주면 리액트가 렌더마다 떼었다 붙여
 * 퇴장 모션이 렌더마다 돈다.
 */
export function useExitMotion<T extends HTMLElement>(
  also?: MutableRefObject<T | null>,
): (node: T | null) => void {
  const current = useRef<T | null>(null);
  return useCallback(
    (node: T | null) => {
      const prev = current.current;
      if (prev && prev !== node) playExit(prev);
      current.current = node;
      if (also) also.current = node;
    },
    [also],
  );
}

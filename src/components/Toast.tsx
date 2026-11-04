import { useExitMotion } from '../lib/motion';
import { useStore } from '../state/store';

/** 하단 가운데 토스트. 병합 차단처럼 "안 된다"만 알릴 때 쓰인다. */
export function Toast() {
  const toast = useStore((s) => s.toast);
  // 메시지마다 새 노드로 갈아 끼운다 — 같은 노드면 진입 모션이 다시 돌지 않아 새 글이 온 줄 모른다.
  const seq = useStore((s) => s.toastSeq);
  const exitRef = useExitMotion<HTMLDivElement>();
  if (!toast) return null;
  return (
    <div key={seq} ref={exitRef} className="toast" role="status">
      {toast}
    </div>
  );
}

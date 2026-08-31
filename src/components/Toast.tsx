import { useStore } from '../state/store';

/** 하단 가운데 토스트. 병합 차단처럼 "안 된다"만 알릴 때 쓰인다. */
export function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return <div className="toast">{toast}</div>;
}

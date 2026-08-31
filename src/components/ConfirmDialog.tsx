import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';

/**
 * 저장 · 버리고 진행 · 취소 3지선다.
 * 창을 닫거나 앱을 끝낼 때 저장하지 않은 편집이 있으면 여기서 한 번 잡는다.
 */
export function ConfirmDialog() {
  const request = useStore((s) => s.confirm);
  const setConfirm = useStore((s) => s.setConfirm);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 실수로 지나치지 않도록 기본 초점은 "취소" 에 둔다.
  useEffect(() => {
    if (request) cancelRef.current?.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setConfirm(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [request, setConfirm]);

  if (!request) return null;

  const run = (action: () => Promise<void> | void) => () => {
    setConfirm(null);
    void Promise.resolve(action()).catch(() => {});
  };

  return (
    <div className="scrim scrim--confirm">
      <div className="card confirm" role="alertdialog" aria-modal="true">
        <div className="confirm__body">
          <div className="confirm__mark">●</div>
          <div>
            <div className="confirm__title">{request.title}</div>
            <div className="confirm__message">{request.message}</div>
            {request.detail && <div className="confirm__detail">{request.detail}</div>}
          </div>
        </div>

        <div className="confirm__foot">
          <button className="ghost-btn confirm__discard" onClick={run(request.onDiscard)}>
            {request.discardLabel}
          </button>
          <div className="spacer" />
          <button className="ghost-btn" ref={cancelRef} onClick={() => setConfirm(null)}>
            취소
          </button>
          <button className="primary-btn" onClick={run(request.onSave)}>
            {request.saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

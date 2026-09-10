import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';

/**
 * 새 세션 · 이름 묻기.
 *
 * `＋` · `Ctrl+Shift+T` · 팔레트의 "새 세션" 은 모두 여기로 온다. **이름을 확정해야 세션이
 * 만들어진다** — 엔터나 `생성` 이 만들기, `닫기`(와 ✕ · Esc · 바깥 누르기)는 취소다.
 *
 * 값이 밖으로 나갔다 돌아오지 않는 창이라 `TextField` 대신 평범한 입력칸을 쓴다
 * (`NewFileDialog` 와 같은 이유). 조합 중의 엔터는 한글 확정이므로 만들기로 삼지 않는다.
 */
export function NewSessionDialog() {
  const open = useStore((s) => s.newSession);
  const snapshot = useStore((s) => s.snapshot);
  const home = useStore((s) => s.home);
  const close = useStore((s) => s.closeNewSession);
  const createSession = useStore((s) => s.createSession);

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  // 창이 열릴 때마다 다음 기본 이름을 채우고 통째로 골라 둔다 — 그대로 엔터를 쳐도 되고,
  // 바로 타자를 쳐도 덮어써진다. (열릴 때 한 번만 — 여는 도중 세션 수가 변할 일은 없다.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setName(defaultSessionName(snapshot?.sessions.length ?? 0));
    setBusy(false);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  if (!open) return null;

  const ready = !!name.trim() && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    // 실패하면 창을 닫지 않는다 — 이름을 고쳐 다시 누를 수 있게 (사유는 토스트로 나갔다).
    if (!(await createSession(name))) setBusy(false);
  };

  return (
    <div className="scrim" onMouseDown={close}>
      <div className="card newsession" onMouseDown={(e) => e.stopPropagation()}>
        <div className="picker__head">
          <div className="picker__title">새 세션</div>
          <div className="picker__cwd" title={home}>
            {home}
          </div>
          <div className="spacer" />
          <button className="close-x" title="취소" onClick={close}>
            ✕
          </button>
        </div>

        <div className="newsession__body">
          <label className="newsession__label" htmlFor="new-session-name">
            세션 이름
          </label>
          <input
            id="new-session-name"
            ref={inputRef}
            className="newsession__name"
            value={name}
            spellCheck={false}
            placeholder="예: rterm · main"
            onChange={(e) => setName(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                close();
              } else if (e.key === 'Enter' && !composing.current) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="newsession__note">
            {name.trim()
              ? `${home} 에서 터미널 하나로 시작합니다 · 셸 · 폴더 · 환경변수는 Ctrl+, 에서`
              : '세션 이름을 입력하세요'}
          </div>
        </div>

        <div className="picker__foot">
          <div className="picker__hint">엔터로도 만들어집니다 · 닫기는 취소</div>
          <div className="spacer" />
          <button className="ghost-btn" onClick={close}>
            닫기
          </button>
          <button className="primary-btn" disabled={!ready} onClick={() => void submit()}>
            생성
          </button>
        </div>
      </div>
    </div>
  );
}

/** 다음 세션에 붙을 기본 이름. Rust 의 `session_create` 와 같은 규칙(`새 세션 N`). */
export function defaultSessionName(sessionCount: number): string {
  return `새 세션 ${sessionCount + 1}`;
}

import { useEffect, useRef, useState } from 'react';
import { NEW_FILE_KINDS, nameProblem, previewName } from '../lib/newFile';
import { activeSession, useStore } from '../state/store';
import type { NewFileKind } from '../state/types';

/**
 * 빈 블럭에서 새 파일 만들기.
 *
 * 값이 밖으로 나갔다 돌아오지 않는 창이라 `TextField` 대신 평범한 입력칸을 쓴다 —
 * 되먹임이 없으면 IME 조합이 덮어써질 일도 없다. 다만 조합 중의 `Enter` 는 한글 확정이므로
 * 만들기로 삼지 않는다.
 */
export function NewFileDialog() {
  const newFile = useStore((s) => s.newFile);
  const snapshot = useStore((s) => s.snapshot);
  const close = useStore((s) => s.closeNewFile);
  const createFile = useStore((s) => s.createFile);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<NewFileKind>('md');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  const session = activeSession(snapshot);

  // 창이 열릴 때마다 빈 칸에서 시작한다.
  useEffect(() => {
    if (!newFile) return;
    setName('');
    setBusy(false);
    inputRef.current?.focus();
  }, [newFile]);

  if (!newFile || !session) return null;

  const problem = nameProblem(name);
  const preview = previewName(name, kind);
  const ready = !!name.trim() && !problem && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const ok = await createFile(newFile.paneId, name, kind);
    // 실패하면 창을 닫지 않는다 — 이름만 고쳐 다시 누를 수 있게 (사유는 토스트로 나갔다).
    if (!ok) setBusy(false);
  };

  return (
    <div className="scrim" onMouseDown={close}>
      <div className="card newfile" onMouseDown={(e) => e.stopPropagation()}>
        <div className="picker__head">
          <div className="picker__title">새 파일 만들기</div>
          <div className="picker__cwd" title={session.cwd}>
            {session.cwd}
          </div>
          <div className="spacer" />
          <button className="close-x" onClick={close}>
            ✕
          </button>
        </div>

        <div className="newfile__body">
          <div className="newfile__kinds">
            {NEW_FILE_KINDS.map((k) => (
              <button
                key={k.key}
                className={`newfile__kind${kind === k.key ? ' is-on' : ''}`}
                onClick={() => {
                  setKind(k.key);
                  inputRef.current?.focus();
                }}
              >
                <span className="newfile__kind-label">{k.label}</span>
                <span className="newfile__kind-ext">{k.ext}</span>
              </button>
            ))}
          </div>

          <input
            ref={inputRef}
            className="newfile__name"
            value={name}
            spellCheck={false}
            placeholder="파일 이름 · docs/메모 처럼 하위 폴더도 됩니다"
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

          <div className={`newfile__note${problem ? ' newfile__note--bad' : ''}`}>
            {problem ??
              (preview
                ? `${session.cwd} 아래에 ${preview} 를 만듭니다`
                : '확장자를 적지 않으면 고른 종류가 붙습니다')}
          </div>
        </div>

        <div className="picker__foot">
          <div className="picker__hint">
            마크다운은 파일 이름을 제목으로 넣고 에디터로, 텍스트는 빈 파일로 열립니다
          </div>
          <div className="spacer" />
          <button className="ghost-btn" onClick={close}>
            취소
          </button>
          <button className="primary-btn" disabled={!ready} onClick={() => void submit()}>
            만들기
          </button>
        </div>
      </div>
    </div>
  );
}

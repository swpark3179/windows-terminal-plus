import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { listFiles } from '../ipc/bridge';
import { activeSession, useStore } from '../state/store';
import type { FileEntry } from '../state/types';

/** 파일 열기 — 세션 작업 디렉터리를 한 단계 아래까지 훑어 보여 준다. */
export function FilePicker() {
  const picker = useStore((s) => s.picker);
  const snapshot = useStore((s) => s.snapshot);
  const closePicker = useStore((s) => s.closePicker);
  const openFile = useStore((s) => s.openFile);
  const flash = useStore((s) => s.flash);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const session = activeSession(snapshot);
  const cwd = session?.cwd ?? '';

  useEffect(() => {
    if (!picker || !cwd) return;
    setLoading(true);
    setError(null);
    listFiles(cwd)
      .then((list) => setFiles(list))
      .catch((e: unknown) => setError(typeof e === 'string' ? e : '목록을 읽을 수 없습니다'))
      .finally(() => setLoading(false));
  }, [picker, cwd]);

  if (!picker || !session) return null;

  const pick = (path: string) => {
    const paneId = picker.paneId;
    closePicker();
    void openFile(paneId, path);
  };

  const pickFromDisk = async () => {
    try {
      const chosen = await openDialog({ multiple: false, directory: false, defaultPath: cwd });
      if (typeof chosen === 'string') pick(chosen);
    } catch {
      flash('파일 선택 창을 열 수 없습니다');
    }
  };

  return (
    <div className="scrim" onMouseDown={closePicker}>
      <div className="card picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="picker__head">
          <div className="picker__title">파일 열기</div>
          <div className="picker__cwd" title={cwd}>
            {cwd}
          </div>
          <div className="spacer" />
          <button className="close-x" onClick={closePicker}>
            ✕
          </button>
        </div>

        <div className="picker__list">
          {loading && <div className="palette__empty">읽는 중…</div>}
          {error && <div className="palette__empty">{error}</div>}
          {!loading && !error && files.length === 0 && (
            <div className="palette__empty">열 수 있는 파일이 없습니다</div>
          )}
          {files.map((f) => (
            <button key={f.path} className="picker__row" onClick={() => pick(f.path)}>
              <span
                className="picker__ext"
                style={
                  f.isMarkdown
                    ? { color: '#a04f2e', borderColor: '#e8cfc4', background: '#fbf1ec' }
                    : f.isImage
                      ? { color: '#3f5fa8', borderColor: '#ccd6ea', background: '#f0f3fa' }
                      : { color: '#7a5232', borderColor: '#e6dcc8', background: '#f9f5ea' }
                }
              >
                {f.ext}
              </span>
              <span className="picker__name" title={f.path}>
                {f.name}
              </span>
              <span className="picker__size">{f.size}</span>
              <span className="picker__mode">
                {f.isMarkdown ? '마크다운 뷰어' : f.isImage ? '이미지 뷰어' : '텍스트 에디터'}
              </span>
            </button>
          ))}
        </div>

        <div className="picker__foot">
          <div className="picker__hint">
            md 는 마크다운 뷰어, 이미지는 이미지 뷰어, 나머지는 텍스트 에디터로 열립니다
          </div>
          <div className="spacer" />
          <button className="ghost-btn" onClick={() => void pickFromDisk()}>
            PC 에서 선택…
          </button>
        </div>
      </div>
    </div>
  );
}

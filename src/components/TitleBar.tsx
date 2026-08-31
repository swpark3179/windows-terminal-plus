import { getCurrentWindow } from '@tauri-apps/api/window';
import { activeSession, useStore } from '../state/store';

/** 프레임리스 창의 상단 34px 바. 드래그 영역과 창 버튼을 직접 그린다. */
export function TitleBar() {
  const snapshot = useStore((s) => s.snapshot);
  const openPalette = useStore((s) => s.openPalette);
  const session = activeSession(snapshot);

  const win = getCurrentWindow();
  const crumb = session ? `${session.cwd}  ·  ${session.shell}` : '';

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar__dot" />
      <div className="titlebar__name" data-tauri-drag-region>
        Terminal++
      </div>
      <div className="titlebar__tag" data-tauri-drag-region>
        통합 AI 터미널 · Rust
      </div>
      <div className="vline" style={{ height: 15 }} />
      <div className="titlebar__crumb" data-tauri-drag-region title={crumb}>
        {crumb}
      </div>
      <div className="spacer" data-tauri-drag-region />

      <button className="palette-hint" onClick={openPalette}>
        명령 팔레트 Ctrl+Shift+P
      </button>

      <div className="wincontrols">
        <button className="wincontrol" title="최소화" onClick={() => void win.minimize()}>
          ─
        </button>
        <button
          className="wincontrol"
          title="최대화"
          style={{ fontSize: 10 }}
          onClick={() => void win.toggleMaximize()}
        >
          ▢
        </button>
        <button
          className="wincontrol wincontrol--close"
          title="닫기"
          style={{ fontSize: 12 }}
          onClick={() => void win.close()}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

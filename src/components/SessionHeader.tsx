import { runAi } from '../ipc/bridge';
import { activeSession, useStore } from '../state/store';

/**
 * 세션 이름 · 작업 디렉터리 · AI 세션 칩 · 레이아웃 편집 토글.
 *
 * AI 칩을 누르면 저장해 둔 ID 로 `claude --resume` / `codex resume` 를 실행한다.
 * (디자인은 터미널 입력을 가로채 붙이는 방식이었지만, 그러면 readline 편집이 망가지므로
 *  명시적인 버튼으로 옮겼다.)
 */
export function SessionHeader() {
  const snapshot = useStore((s) => s.snapshot);
  const editMode = useStore((s) => s.editMode);
  const toggleEdit = useStore((s) => s.toggleEdit);
  const openSettings = useStore((s) => s.openSettings);
  const sel = useStore((s) => s.sel);
  const flash = useStore((s) => s.flash);
  const session = activeSession(snapshot);

  if (!session) return null;

  const runResume = (kind: 'claude' | 'codex') => async () => {
    const pane = session.panes.find((p) => p.id === sel && p.kind === 'term' && p.alive);
    const target = pane ?? session.panes.find((p) => p.kind === 'term' && p.alive);
    if (!target) {
      flash('실행 중인 터미널 창이 없습니다');
      return;
    }
    try {
      const cmd = await runAi(session.id, target.id, kind);
      flash(`${cmd} 실행`);
    } catch (e) {
      flash(typeof e === 'string' ? e : '이어붙이기에 실패했습니다');
    }
  };

  return (
    <div className="session-head">
      <div className="session-head__name">{session.name}</div>
      <div className="session-head__cwd" title={session.cwd}>
        {session.cwd}
      </div>

      {session.claude && (
        <button
          className="chip chip--claude"
          title="Claude 세션 이어붙이기 · claude --resume"
          onClick={() => void runResume('claude')()}
        >
          claude {session.claude.slice(0, 12)}
        </button>
      )}
      {session.codex && (
        <button
          className="chip chip--codex"
          title="Codex 세션 이어붙이기 · codex resume"
          onClick={() => void runResume('codex')()}
        >
          codex {session.codex.slice(0, 12)}
        </button>
      )}

      <div className="spacer" />

      <button
        className={`edit-toggle${editMode ? ' edit-toggle--on' : ''}`}
        onClick={toggleEdit}
        title="레이아웃 편집 · Ctrl+E"
      >
        ⊞ 레이아웃 편집
      </button>
      <button className="gear-btn" title="세션 설정 · Ctrl+," onClick={openSettings}>
        ⚙
      </button>
    </div>
  );
}

import { runAi } from '../ipc/bridge';
import { activeSession, useStore } from '../state/store';
import type { AiKind } from '../state/types';

/** 칩에 붙는 설명 — 무슨 명령이 실제로 실행되는지 그대로 보여 준다. */
const AI_HINT: Record<AiKind, string> = {
  claude: 'Claude 이어붙이기 · claude --continue',
  codex: 'Codex 이어붙이기 · codex resume --last',
};

/**
 * 세션 이름 · 작업 디렉터리 · AI 칩 · 레이아웃 편집 토글.
 *
 * AI 칩은 고른 창에서 `claude --continue` / `codex resume --last` 를 실행한다.
 * 세션 ID 를 손으로 넣을 필요가 없다 — 두 명령 모두 **그 창의 현재 폴더** 에서 가장 최근
 * 대화를 찾고, 창의 폴더는 앱이 기억했다가 복원하기 때문이다.
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

  const targetPane = () => {
    const picked = session.panes.find((p) => p.id === sel && p.kind === 'term' && p.alive);
    return picked ?? session.panes.find((p) => p.kind === 'term' && p.alive);
  };

  const runResume = (kind: AiKind) => async () => {
    const target = targetPane();
    if (!target) {
      flash('실행 중인 터미널 창이 없습니다');
      return;
    }
    try {
      const cmd = await runAi(target.id, kind);
      flash(`${cmd} 실행`);
    } catch (e) {
      flash(typeof e === 'string' ? e : '이어붙이기에 실패했습니다');
    }
  };

  const running = targetPane()?.ai;

  return (
    <div className="session-head">
      <div className="session-head__name">{session.name}</div>
      <div className="session-head__cwd" title={session.cwd}>
        {session.cwd}
      </div>

      {(['claude', 'codex'] as const).map((kind) => (
        <button
          key={kind}
          className={`chip chip--${kind}${running === kind ? ' chip--on' : ''}`}
          title={AI_HINT[kind]}
          onClick={() => void runResume(kind)()}
        >
          {kind}
        </button>
      ))}

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

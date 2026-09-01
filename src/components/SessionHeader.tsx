import { activeSession, fullPane, useStore } from '../state/store';

/**
 * 세션 이름 · 작업 디렉터리 · 전체화면·레이아웃 편집 토글.
 */
export function SessionHeader() {
  const snapshot = useStore((s) => s.snapshot);
  const editMode = useStore((s) => s.editMode);
  const toggleEdit = useStore((s) => s.toggleEdit);
  const openSettings = useStore((s) => s.openSettings);
  const toggleFull = useStore((s) => s.toggleFull);
  const session = activeSession(snapshot);

  if (!session) return null;
  // 전체화면에서는 고른 창이 세션 전체를 감싸야 한다 — 이 바까지 창 하나가 덮는 셈이라 숨긴다.
  // 빠져나가는 길(⤡)은 그 창의 제목줄에 그대로 남아 있고, Ctrl+Shift+F 도 여전히 듣는다.
  if (fullPane(session)) return null;

  return (
    <div className="session-head">
      <div className="session-head__name">{session.name}</div>
      <div className="session-head__cwd" title={session.cwd}>
        {session.cwd}
      </div>

      <div className="spacer" />

      <button
        className="edit-toggle"
        onClick={() => void toggleFull()}
        title="고른 창만 이 세션을 가득 채우기 · Ctrl+Shift+F"
      >
        ⤢ 전체화면
      </button>
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

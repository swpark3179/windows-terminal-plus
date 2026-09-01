import { formatSavedAt, useStore } from '../state/store';
import { DOT_COLORS } from '../state/types';

/** 세션 목록. 접히면 40px 레일로 바뀐다 (디자인의 두 가지 상태). */
export function Sidebar() {
  const snapshot = useStore((s) => s.snapshot);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const newSession = useStore((s) => s.newSession);
  const activate = useStore((s) => s.activateSession);
  const openContext = useStore((s) => s.openContext);

  if (!snapshot) return null;

  const q = query.trim().toLowerCase();
  const rows = snapshot.sessions.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q),
  );

  const onCtx = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    void activate(id);
    openContext({
      kind: 'session',
      id,
      x: Math.min(e.clientX, window.innerWidth - 224),
      y: Math.min(e.clientY, window.innerHeight - 210),
    });
  };

  if (!snapshot.sidebarOpen) {
    return (
      <div className="rail">
        <button className="rail__btn" title="사이드바 펼치기 · Ctrl+B" onClick={toggleSidebar}>
          ◨
        </button>
        <div className="rail__sep" />
        {rows.map((s) => (
          <button
            key={s.id}
            className={`rail__btn${s.id === snapshot.activeId ? ' rail__btn--active' : ''}`}
            title={s.name}
            onClick={() => void activate(s.id)}
            onContextMenu={onCtx(s.id)}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 2,
                background: DOT_COLORS[s.color % DOT_COLORS.length],
              }}
            />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar__head">
        <div className="sidebar__label">세션</div>
        <div className="sidebar__count">{snapshot.sessions.length}</div>
        <div className="spacer" />
        <button className="icon-btn icon-btn--accent" title="새 세션" onClick={() => void newSession()}>
          ＋
        </button>
        <button
          className="icon-btn"
          title="사이드바 접기 · Ctrl+B"
          style={{ fontSize: 11 }}
          onClick={toggleSidebar}
        >
          ◧
        </button>
      </div>

      <div className="sidebar__search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="세션 검색"
          spellCheck={false}
        />
      </div>

      <div className="sidebar__list">
        {rows.map((s) => {
          const open = s.panes.filter((p) => p.kind !== 'empty').length;
          return (
            <button
              key={s.id}
              className={`session-row${s.id === snapshot.activeId ? ' session-row--active' : ''}`}
              onClick={() => void activate(s.id)}
              onContextMenu={onCtx(s.id)}
            >
              <span
                className="session-row__dot"
                style={{ background: DOT_COLORS[s.color % DOT_COLORS.length] }}
              />
              <span className="session-row__body">
                <span className="session-row__name">{s.name}</span>
                <span className="session-row__meta">
                  {s.shell} · {open} 창 · {s.grid.cols}×{s.grid.rows}
                </span>
              </span>
              {s.panes.some((p) => p.ai) && (
                <span className="ai-badge" title="AI 실행 중">
                  AI
                </span>
              )}
            </button>
          );
        })}
        {rows.length === 0 && (
          <div style={{ padding: '10px 8px', fontSize: 11, color: '#a8a49a' }}>
            일치하는 세션이 없습니다
          </div>
        )}
      </div>

      <div className="sidebar__foot">
        <div>스냅샷 · {formatSavedAt(snapshot.savedAtEpoch)}</div>
        <div className="sidebar__foot-dim">세션 · 레이아웃 · 스크롤백 유지</div>
      </div>
    </div>
  );
}

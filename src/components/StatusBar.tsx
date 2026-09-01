import { activeSession, useStore } from '../state/store';

export function StatusBar() {
  const snapshot = useStore((s) => s.snapshot);
  const restored = useStore((s) => s.restored);
  const snapshotPath = useStore((s) => s.snapshotPath);
  const session = activeSession(snapshot);

  if (!session) return null;

  const open = session.panes.filter((p) => p.kind !== 'empty').length;
  const empty = session.panes.filter((p) => p.kind === 'empty').length;
  const full = !!session.fullPaneId;

  return (
    <div className="statusbar">
      <div className="statusbar__badge">{restored ? '● 복원됨' : '● 새 스냅샷'}</div>
      <div className="statusbar__left">
        {session.id} · 창 {open} · 빈 블럭 {empty} · grid {session.grid.cols}×{session.grid.rows}
        {full ? ' · 전체화면' : ''}
      </div>
      <div className="spacer" style={{ minWidth: 8 }} />
      <div className="statusbar__right" title={snapshotPath}>
        Ctrl+E 레이아웃 · Ctrl+Shift+F 전체화면 · Ctrl+B 사이드바 · Ctrl+휠 확대 · 종료 시 자동
        스냅샷
      </div>
    </div>
  );
}

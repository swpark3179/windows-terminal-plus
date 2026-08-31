//! 프론트엔드가 부르는 명령들. 상태 변경은 전부 여기를 거치고,
//! 매번 갱신된 스냅샷을 통째로 돌려줘 프론트엔드는 렌더만 하면 되게 한다.

pub mod files;
pub mod layout;
pub mod pty;
pub mod session;

use rterm_core::{Session, Snapshot};
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

/// 앱이 처음 뜰 때 한 번 내려가는 초기 상태.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Boot {
    pub snapshot: Snapshot,
    /// 기존 스냅샷에서 복원됐는지 — 상태바의 `● 복원됨` 배지.
    pub restored: bool,
    pub home: String,
    pub snapshot_path: String,
}

/// 세션 하나를 고쳐 쓰고, 저장한 뒤, 새 스냅샷을 돌려주는 공통 흐름.
pub fn mutate<F>(state: &AppState, session_id: &str, f: F) -> Result<Snapshot, String>
where
    F: FnOnce(&mut Session) -> Result<(), String>,
{
    {
        let mut snap = state.snapshot.lock();
        let session = snap
            .session_mut(session_id)
            .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;
        f(session)?;
        rterm_core::ensure_non_empty(session);
    }
    state.persist();
    Ok(read_snapshot(state))
}

/// 락을 짧게 잡고 스냅샷 사본을 뜬다. `alive` 는 실제 PTY 상태로 맞춰서 나간다.
pub fn read_snapshot(state: &AppState) -> Snapshot {
    state.sync_alive();
    state.snapshot.lock().clone()
}

#[tauri::command]
pub fn app_boot(state: State<'_, AppState>) -> Boot {
    let restored = state.snapshot.lock().restored;
    Boot {
        snapshot: read_snapshot(&state),
        restored,
        home: state.home.clone(),
        snapshot_path: state.snapshot_path().to_string_lossy().to_string(),
    }
}

/// 스크롤백까지 포함해 즉시 기록한다. 창을 닫기 직전과 주기적 저장에 쓰인다.
#[tauri::command]
pub fn snapshot_flush(state: State<'_, AppState>) -> u64 {
    state.flush()
}

/// 스냅샷을 버리고 초기 상태로 되돌린다 (팔레트의 `↺ 스냅샷 초기화`).
#[tauri::command]
pub fn snapshot_reset(state: State<'_, AppState>) -> Snapshot {
    state.kill_all();
    {
        let mut snap = state.snapshot.lock();
        *snap = Snapshot::seed(&state.home);
    }
    state.persist();
    read_snapshot(&state)
}

/// 사이드바 접힘 상태도 스냅샷에 남는다 (디자인의 `sidebarOpen`).
#[tauri::command]
pub fn set_sidebar_open(state: State<'_, AppState>, open: bool) -> u64 {
    state.snapshot.lock().sidebar_open = open;
    state.persist()
}

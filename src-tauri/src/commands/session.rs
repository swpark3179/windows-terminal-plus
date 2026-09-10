//! 세션 만들기 · 복제 · 삭제 · 설정 변경.

use rterm_core::{layout, EnvVar, Session, Shell, Snapshot};
use serde::Deserialize;
use tauri::State;

use super::{mutate, read_snapshot};
use crate::state::AppState;

/// 설정 모달이 보내는 부분 갱신. 보내지 않은 항목은 그대로 둔다.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPatch {
    pub name: Option<String>,
    pub cwd: Option<String>,
    pub shell: Option<Shell>,
    pub start: Option<String>,
    pub ssh_host: Option<String>,
    pub env: Option<Vec<EnvVar>>,
}

/// 세션을 만든다.
///
/// `name` 은 만들기 창에서 받은 이름이다. 비어 있거나 오지 않았으면 `새 세션 N` 으로 짓는다 —
/// 이름을 묻지 않는 길(첫 실행의 씨앗 세션 등)에서도 이름이 비지 않게.
#[tauri::command]
pub fn session_create(state: State<'_, AppState>, name: Option<String>) -> Snapshot {
    let (name, cwd, color) = {
        let snap = state.snapshot.lock();
        let n = snap.sessions.len();
        let given = name.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        (
            given.unwrap_or_else(|| format!("새 세션 {}", n + 1)),
            state.home.clone(),
            n,
        )
    };
    let mut session = Session::new(name, cwd, color);
    // 새 세션은 곧바로 쓸 수 있어야 한다 — 터미널 하나를 세션 전체화면으로 띄운 채 시작한다.
    layout::start_full_terminal(&mut session);
    let id = session.id.clone();
    {
        let mut snap = state.snapshot.lock();
        snap.sessions.push(session);
        snap.active_id = id;
    }
    state.persist();
    read_snapshot(&state)
}

#[tauri::command]
pub fn session_duplicate(state: State<'_, AppState>, session_id: String) -> Result<Snapshot, String> {
    {
        let mut snap = state.snapshot.lock();
        let source = snap
            .session(&session_id)
            .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;

        let mut copy = source.clone();
        copy.id = rterm_core::uid("ses_");
        copy.name = format!("{} 사본", source.name);
        // 창 배치는 그대로 두되 실행 중인 내용은 물려받지 않는다.
        // 창 id 를 새로 뽑으므로 전체화면 대상은 자리(인덱스)로 따라가게 한다.
        let full_at = copy
            .full_pane_id
            .as_ref()
            .and_then(|id| copy.panes.iter().position(|p| &p.id == id));
        for pane in &mut copy.panes {
            pane.id = rterm_core::uid("p");
            pane.scrollback = None;
            pane.alive = false;
            pane.cwd = None;
            pane.ai = None;
        }
        copy.full_pane_id = full_at.map(|i| copy.panes[i].id.clone());
        let new_id = copy.id.clone();
        snap.sessions.push(copy);
        snap.active_id = new_id;
    }
    state.persist();
    Ok(read_snapshot(&state))
}

#[tauri::command]
pub fn session_delete(state: State<'_, AppState>, session_id: String) -> Result<Snapshot, String> {
    {
        let snap = state.snapshot.lock();
        if snap.sessions.len() <= 1 {
            return Err("마지막 세션은 삭제할 수 없습니다".into());
        }
    }
    state.kill_session(&session_id);
    {
        let mut snap = state.snapshot.lock();
        snap.sessions.retain(|s| s.id != session_id);
        if !snap.sessions.iter().any(|s| s.id == snap.active_id) {
            snap.active_id = snap.sessions[0].id.clone();
        }
    }
    state.persist();
    Ok(read_snapshot(&state))
}

#[tauri::command]
pub fn session_activate(state: State<'_, AppState>, session_id: String) -> Result<Snapshot, String> {
    {
        let mut snap = state.snapshot.lock();
        if !snap.sessions.iter().any(|s| s.id == session_id) {
            return Err("세션을 찾을 수 없습니다".into());
        }
        snap.active_id = session_id;
    }
    state.persist();
    Ok(read_snapshot(&state))
}

#[tauri::command]
pub fn session_update(
    state: State<'_, AppState>,
    session_id: String,
    patch: SessionPatch,
) -> Result<Snapshot, String> {
    mutate(&state, &session_id, |s| {
        if let Some(v) = patch.name {
            s.name = v;
        }
        if let Some(v) = patch.cwd {
            s.cwd = v;
        }
        if let Some(v) = patch.shell {
            s.shell = v;
        }
        if let Some(v) = patch.start {
            s.start = v;
        }
        if let Some(v) = patch.ssh_host {
            s.ssh_host = v;
        }
        if let Some(v) = patch.env {
            s.env = v;
        }
        Ok(())
    })
}

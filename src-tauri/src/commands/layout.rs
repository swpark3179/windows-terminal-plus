//! 분할 · 병합 · 위치 교환 · 창 열기/닫기.
//!
//! 판정은 전부 `rterm-core` 가 한다. 프론트엔드는 드래그 중에도
//! `layout_merge_check` 를 불러 같은 규칙을 그대로 본다 — 규칙이 두 벌 존재하지 않는다.

use rterm_core::{layout, MergeVerdict, PaneKind, Snapshot, SplitDir, TrackAxis};
use serde::Serialize;
use tauri::State;

use super::{mutate, read_snapshot};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitResult {
    pub snapshot: Snapshot,
    /// 새로 생긴 빈 블럭 — 디자인처럼 곧바로 선택 상태로 만든다.
    pub new_pane_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub snapshot: Snapshot,
    /// 병합 후 남은 창. 이 창이 확장되어 나타난다.
    pub keep_id: String,
    /// 토스트 문구 — 예: "가로줄 3개 창 병합".
    pub message: String,
}

#[tauri::command]
pub fn layout_split(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
    dir: SplitDir,
) -> Result<SplitResult, String> {
    let new_pane_id = {
        let mut snap = state.snapshot.lock();
        let session = snap
            .session_mut(&session_id)
            .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;
        layout::split(session, &pane_id, dir).map_err(|e| e.to_string())?
    };
    state.persist();
    Ok(SplitResult {
        snapshot: read_snapshot(&state),
        new_pane_id,
    })
}

/// 드래그 중 매 hover 마다 호출된다. 상태를 바꾸지 않는 순수 판정.
#[tauri::command]
pub fn layout_merge_check(
    state: State<'_, AppState>,
    session_id: String,
    pane_ids: Vec<String>,
) -> Result<MergeVerdict, String> {
    let snap = state.snapshot.lock();
    let session = snap
        .session(&session_id)
        .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;
    Ok(layout::merge_check(session, &pane_ids))
}

/// 드래그를 놓았을 때. 거부되면 레이아웃은 손대지 않고 사유만 돌려준다.
#[tauri::command]
pub fn layout_merge(
    state: State<'_, AppState>,
    session_id: String,
    pane_ids: Vec<String>,
) -> Result<MergeResult, String> {
    let plan = {
        let mut snap = state.snapshot.lock();
        let session = snap
            .session_mut(&session_id)
            .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;
        layout::merge(session, &pane_ids).map_err(|r| r.message().to_string())?
    };

    // 병합으로 사라진 창은 정의상 빈 블럭이므로 PTY 가 딸려 있을 수 없다.
    // 그래도 혹시 남은 슬롯이 있으면 정리한다.
    for id in &pane_ids {
        if id != &plan.keep_id {
            state.kill_pane(id);
        }
    }

    state.persist();
    Ok(MergeResult {
        snapshot: read_snapshot(&state),
        keep_id: plan.keep_id.clone(),
        message: format!("{} {}개 창 병합", plan.axis.label(), plan.count),
    })
}

/// 창 경계를 끌어 만든 새 트랙 몫을 기록한다.
///
/// 드래그 중에는 프론트엔드가 화면만 먼저 바꾸고, 손을 뗄 때 한 번 여기로 보낸다.
/// 몫의 합은 그대로라 한 창이 커진 만큼 이웃이 작아진다.
#[tauri::command]
pub fn layout_set_weights(
    state: State<'_, AppState>,
    session_id: String,
    axis: TrackAxis,
    weights: Vec<f32>,
) -> Result<Snapshot, String> {
    mutate(&state, &session_id, |s| {
        layout::set_weights(s, axis, weights).map_err(|e| e.to_string())
    })
}

/// 모든 창을 다시 같은 크기로.
#[tauri::command]
pub fn layout_reset_weights(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Snapshot, String> {
    mutate(&state, &session_id, |s| {
        layout::reset_weights(s);
        Ok(())
    })
}

#[tauri::command]
pub fn layout_swap(
    state: State<'_, AppState>,
    session_id: String,
    a: String,
    b: String,
) -> Result<Snapshot, String> {
    mutate(&state, &session_id, |s| {
        layout::swap(s, &a, &b).map_err(|e| e.to_string())
    })
}

/// 창을 닫아 빈 블럭으로. 터미널이면 셸도 함께 종료한다.
#[tauri::command]
pub fn pane_close(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
) -> Result<Snapshot, String> {
    state.kill_pane(&pane_id);
    mutate(&state, &session_id, |s| {
        layout::close_pane(s, &pane_id).map(|_| ()).map_err(|e| e.to_string())
    })
}

/// 빈 블럭을 터미널 자리로 바꾼다. 실제 셸 스폰은 프론트엔드가 xterm 을
/// 띄운 뒤 `pty_spawn` 으로 이어서 한다 — ConPTY 가 곧바로 커서 위치를 묻기 때문에
/// 답해 줄 xterm 이 먼저 준비돼 있어야 한다.
#[tauri::command]
pub fn pane_open_terminal(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
) -> Result<Snapshot, String> {
    mutate(&state, &session_id, |s| {
        let shell_label = match s.shell {
            rterm_core::Shell::Pwsh => "pwsh",
            rterm_core::Shell::Cmd => "cmd",
            rterm_core::Shell::Wsl => "wsl",
            rterm_core::Shell::Ssh => "ssh",
        };
        let title = format!("{shell_label} · 새 터미널");
        let pane = s
            .pane_mut(&pane_id)
            .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
        if pane.kind != PaneKind::Empty {
            return Err("빈 블럭에만 열 수 있습니다".into());
        }
        pane.kind = PaneKind::Term;
        pane.title = title;
        pane.content = None;
        pane.path = None;
        pane.mode = None;
        pane.scrollback = None;
        pane.alive = false;
        Ok(())
    })
}

#[tauri::command]
pub fn pane_set_zoom(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
    zoom: u32,
) -> Result<Snapshot, String> {
    mutate(&state, &session_id, |s| {
        let pane = s
            .pane_mut(&pane_id)
            .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
        pane.zoom = zoom.clamp(9, 34);
        Ok(())
    })
}

#[tauri::command]
pub fn pane_set_md_mode(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
    mode: rterm_core::MdMode,
) -> Result<Snapshot, String> {
    mutate(&state, &session_id, |s| {
        let pane = s
            .pane_mut(&pane_id)
            .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
        pane.mode = Some(mode);
        Ok(())
    })
}

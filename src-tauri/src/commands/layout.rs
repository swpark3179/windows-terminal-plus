//! 분할 · 병합 · 위치 교환 · 창 열기/닫기.
//!
//! 판정은 전부 `rterm-core` 가 한다. 프론트엔드는 드래그 중에도
//! `layout_merge_check` 를 불러 같은 규칙을 그대로 본다 — 규칙이 두 벌 존재하지 않는다.

use rterm_core::{layout, MergeVerdict, PaneKind, Snapshot, SplitDir, SplitOrigin, TrackAxis};
use serde::Serialize;
use tauri::State;

use super::{mutate, read_snapshot, reveal};
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
    split_in(&state, &session_id, &pane_id, dir)
}

/// 분할 본체 — 명령 껍데기 없이 테스트에서 부를 수 있게 떼어 냈다.
///
/// 나눠 준 창이 터미널이면 새 빈 블럭에 **어디서 나왔는지**(`split_from`)를 적는다. 실제 폴더는
/// 그 블럭에 터미널을 열 때 다시 정한다(`open_terminal_in`) — 그 사이 `cd` 했으면 바뀐 폴더가 맞다.
/// 여기서 재 두는 폴더는 그 터미널이 그새 닫혔을 때만 쓰는 예비값이다.
fn split_in(
    state: &AppState,
    session_id: &str,
    pane_id: &str,
    dir: SplitDir,
) -> Result<SplitResult, String> {
    // 스냅샷 락을 잡기 **전에** 잰다 — `resolve_folder` 도 그 락을 잡는다.
    let origin_cwd = reveal::resolve_folder(state, pane_id, false).ok().map(|(_, d)| d);
    let new_pane_id = {
        let mut snap = state.snapshot.lock();
        let session = snap
            .session_mut(session_id)
            .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;
        let from_terminal = session.pane(pane_id).is_some_and(|p| p.kind == PaneKind::Term);
        let new_id = layout::split(session, pane_id, dir).map_err(|e| e.to_string())?;
        if from_terminal {
            if let Some(fresh) = session.pane_mut(&new_id) {
                fresh.split_from = Some(SplitOrigin {
                    pane_id: pane_id.to_string(),
                    cwd: origin_cwd,
                });
            }
        }
        new_id
    };
    state.persist();
    Ok(SplitResult {
        snapshot: read_snapshot(state),
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
/// 띄운 뒤 `pty_open` 으로 이어서 한다 — ConPTY 가 곧바로 커서 위치를 묻기 때문에
/// 답해 줄 xterm 이 먼저 준비돼 있어야 한다.
///
/// 터미널을 나눠 생긴 블럭이면 나눠 준 터미널이 **지금** 서 있는 폴더에서 뜬다 — 탐색기로 열기와
/// 같은 판정이다(셸이 지금 알려 주는 폴더 → 마지막으로 알던 폴더). 그 터미널이 그새 닫혔으면 나눌 때
/// 재 둔 폴더, 그것도 없거나 쓸 수 없으면(WSL 쪽 경로·사라진 폴더·네트워크 경로) 세션 설정의 폴더.
#[tauri::command]
pub fn pane_open_terminal(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
) -> Result<Snapshot, String> {
    open_terminal_in(&state, &session_id, &pane_id)
}

fn open_terminal_in(state: &AppState, session_id: &str, pane_id: &str) -> Result<Snapshot, String> {
    let origin = {
        let snap = state.snapshot.lock();
        snap.session(session_id)
            .and_then(|s| s.pane(pane_id))
            .and_then(|p| p.split_from.clone())
    };
    let cwd = origin.and_then(|o| inherited_folder(state, &o));
    mutate(state, session_id, |s| {
        layout::open_terminal(s, pane_id, cwd.as_deref()).map_err(|e| e.to_string())
    })
}

/// 나눠 준 터미널에게서 물려받을 폴더. 없으면 `None` — 세션 폴더에서 뜬다.
fn inherited_folder(state: &AppState, origin: &SplitOrigin) -> Option<String> {
    let source_alive = {
        let snap = state.snapshot.lock();
        snap.sessions
            .iter()
            .filter_map(|s| s.pane(&origin.pane_id))
            .any(|p| p.kind == PaneKind::Term)
    };
    if source_alive {
        if let Ok((_, dir)) = reveal::resolve_folder(state, &origin.pane_id, false) {
            return Some(dir);
        }
    }
    // 나눠 준 터미널이 닫혔거나 아무 폴더도 모른다 — 나눌 때 재 둔 폴더. 그새 지워졌을 수 있어 다시 본다.
    origin
        .cwd
        .as_deref()
        .and_then(|d| reveal::validate(d).ok())
        .map(str::to_string)
}

/// 창 하나만 세션 영역 가득 보여 준다 (전체화면). `pane_id` 가 `None` 이면 창 모드로 돌아간다.
///
/// 격자는 그대로 남으므로 창 모드로 돌아오면 나눠 두었던 배치가 그대로 살아난다.
#[tauri::command]
pub fn pane_set_full(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: Option<String>,
) -> Result<Snapshot, String> {
    mutate(&state, &session_id, |s| {
        layout::set_full(s, pane_id.as_deref()).map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 테스트마다 따로 쓰는 설정 폴더와, 터미널이 서 있을 진짜 폴더들.
    struct Fixture {
        root: PathBuf,
        state: AppState,
        session_id: String,
        term_id: String,
    }

    impl Fixture {
        /// 터미널 하나가 세션을 채운 처음 상태(`Snapshot::seed`). 그 터미널은 `a` 폴더에 서 있다.
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("rterm-split-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            for d in ["a", "b", "home"] {
                std::fs::create_dir_all(root.join(d)).unwrap();
            }
            let state = AppState::new(root.join("config"), root.join("home").to_string_lossy().into());
            let (session_id, term_id) = {
                let mut snap = state.snapshot.lock();
                let a = root.join("a").to_string_lossy().to_string();
                let session = &mut snap.sessions[0];
                let term = &mut session.panes[0];
                assert_eq!(term.kind, PaneKind::Term, "처음 세션은 터미널 하나로 연다");
                term.cwd = Some(a);
                (session.id.clone(), term.id.clone())
            };
            Fixture { root, state, session_id, term_id }
        }

        fn dir(&self, name: &str) -> String {
            self.root.join(name).to_string_lossy().to_string()
        }

        /// 셸이 `cd` 해서 다음 명령 때 스냅샷에 새 폴더가 실린 상황.
        fn cd(&self, pane_id: &str, dir: &str) {
            let mut snap = self.state.snapshot.lock();
            snap.sessions[0].pane_mut(pane_id).unwrap().cwd = Some(dir.to_string());
        }

        fn pane(&self, id: &str) -> rterm_core::Pane {
            self.state.snapshot.lock().sessions[0].pane(id).unwrap().clone()
        }

        fn split(&self) -> String {
            split_in(&self.state, &self.session_id, &self.term_id, SplitDir::LeftRight)
                .unwrap()
                .new_pane_id
        }

        fn open(&self, id: &str) -> Option<String> {
            open_terminal_in(&self.state, &self.session_id, id).unwrap();
            self.pane(id).cwd
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_block_split_from_a_terminal_remembers_where_it_came_from() {
        let f = Fixture::new("remember");
        let b = f.split();
        let origin = f.pane(&b).split_from.expect("나눠 준 터미널을 기억해야 한다");
        assert_eq!(origin.pane_id, f.term_id);
        assert_eq!(origin.cwd.as_deref(), Some(f.dir("a").as_str()), "나눌 때의 폴더를 예비값으로");
    }

    #[test]
    fn the_new_terminal_starts_where_the_source_terminal_is_now() {
        // 나눈 뒤 원래 터미널에서 `cd` 했다면 바뀐 폴더가 맞다 — 탐색기로 열기와 같은 판정이다.
        let f = Fixture::new("now");
        let b = f.split();
        f.cd(&f.term_id, &f.dir("b"));
        assert_eq!(f.open(&b).as_deref(), Some(f.dir("b").as_str()));
        assert_eq!(f.pane(&b).split_from, None, "물려받기는 한 번뿐이다");
    }

    #[test]
    fn other_layout_changes_in_between_do_not_lose_it() {
        // 예전에는 화면 상태라 경계를 끌어 크기만 바꿔도 잊었다.
        let f = Fixture::new("between");
        let b = f.split();
        mutate(&f.state, &f.session_id, |s| {
            layout::set_weights(s, rterm_core::TrackAxis::Col, vec![1.4, 0.6]).map_err(|e| e.to_string())
        })
        .unwrap();
        mutate(&f.state, &f.session_id, |s| {
            layout::swap(s, &f.term_id, &b).map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(f.open(&b).as_deref(), Some(f.dir("a").as_str()));
    }

    #[test]
    fn a_closed_source_falls_back_to_the_folder_seen_at_split_time() {
        let f = Fixture::new("closed");
        let b = f.split();
        mutate(&f.state, &f.session_id, |s| {
            layout::close_pane(s, &f.term_id).map(|_| ()).map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(f.open(&b).as_deref(), Some(f.dir("a").as_str()));
    }

    #[test]
    fn folders_that_cannot_be_used_fall_back_to_the_session_folder() {
        let f = Fixture::new("unusable");
        let b = f.split();
        // 나눈 뒤 원래 터미널이 WSL 쪽 경로로 갔고, 예비값 폴더도 지워졌다.
        f.cd(&f.term_id, "/home/me/project");
        std::fs::remove_dir_all(f.root.join("a")).unwrap();
        assert_eq!(f.open(&b), None, "세션 폴더(`pty_open` 의 기본값)에서 뜬다");
    }

    #[test]
    fn a_network_path_is_never_inherited() {
        // 존재 확인만으로도 그 호스트에 붙으러 가 인증 정보를 흘린다 — 탐색기로 열기와 같이 막는다.
        let f = Fixture::new("unc");
        f.cd(&f.term_id, "\\\\evil.tld\\share");
        let b = f.split();
        assert_eq!(f.pane(&b).split_from.unwrap().cwd, None);
        assert_eq!(f.open(&b), None);
    }

    #[test]
    fn a_block_split_from_something_else_inherits_nothing() {
        let f = Fixture::new("plain");
        let b = f.split();
        // 빈 블럭을 다시 나누면 — 나눠 준 것이 터미널이 아니다.
        let c = split_in(&f.state, &f.session_id, &b, SplitDir::TopBottom)
            .unwrap()
            .new_pane_id;
        assert_eq!(f.pane(&c).split_from, None);
        assert_eq!(f.open(&c), None);
    }
}

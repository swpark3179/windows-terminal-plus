//! rterm — Tauri 2 앱 진입점.

mod commands;
mod state;

use tauri::{Manager, RunEvent};

use crate::state::AppState;

/// 스냅샷 보관 위치. 디자인 설정 모달이 안내하는 `%APPDATA%\rterm\sessions` 와 맞춘다.
const APP_DIR: &str = "rterm";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let base = app.path().data_dir()?;
            let config_dir = base.join(APP_DIR);
            let home = app
                .path()
                .home_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string());

            app.manage(AppState::new(config_dir, home));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_boot,
            commands::snapshot_flush,
            commands::snapshot_reset,
            commands::set_sidebar_open,
            commands::session::session_create,
            commands::session::session_duplicate,
            commands::session::session_delete,
            commands::session::session_activate,
            commands::session::session_update,
            commands::layout::layout_split,
            commands::layout::layout_merge_check,
            commands::layout::layout_merge,
            commands::layout::layout_swap,
            commands::layout::layout_set_weights,
            commands::layout::layout_reset_weights,
            commands::layout::pane_close,
            commands::layout::pane_open_terminal,
            commands::layout::pane_set_zoom,
            commands::layout::pane_set_md_mode,
            commands::pty::pty_open,
            commands::pty::pty_detach,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_run_ai,
            commands::files::fs_list,
            commands::files::fs_read_image,
            commands::files::pane_set_image_zoom,
            commands::files::pane_open_file,
            commands::files::pane_set_content,
            commands::files::pane_save,
        ])
        .build(tauri::generate_context!())
        .expect("rterm 을 시작할 수 없습니다")
        // 정리는 창 이벤트가 아니라 실제 종료 시점에 한다.
        // 저장하지 않은 편집이 있으면 프론트엔드가 닫기를 되돌릴 수 있는데,
        // 창 이벤트에서 셸을 죽여 버리면 취소했는데도 터미널이 사라진다.
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.flush();
                    state.kill_all();
                }
            }
        });
}

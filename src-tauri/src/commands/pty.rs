//! 셸 스폰과 입출력 중계.
//!
//! 흐름: PTY → (rterm-term 코어에 반영) + (Channel 로 xterm.js 에 raw 전달)
//!       xterm.js → `pty_write` → PTY

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rterm_core::{PaneKind, Session, Shell, SCROLLBACK_LINES};
use rterm_pty::{PtyHandle, SpawnSpec};
use rterm_term::TermCore;
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, State};

use crate::state::{AppState, DataSink, TerminalSlot};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    /// 화면에 다시 그릴 내용(ANSI). 새로 연 터미널이면 비어 있다.
    pub restored: String,
    /// 복원됐음을 알리는 머리글 — 디자인의 "세션 복원 완료" 줄.
    pub banner: String,
    /// 이미 돌고 있던 셸에 화면만 다시 붙였는지. false 면 새로 띄운 것.
    pub attached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitEvent {
    pub pane_id: String,
    pub code: u32,
}

/// PATH 에 실행 파일이 있는지 본다. pwsh 가 없는 PC 에서 기본 powershell 로 물러나기 위함.
fn program_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

/// 세션 설정에서 실제 셸 명령을 만든다.
fn shell_spec(session: &Session, cols: u16, rows: u16) -> Result<SpawnSpec, String> {
    let mut spec = match session.shell {
        Shell::Pwsh => {
            if cfg!(windows) {
                // PowerShell 7 이 없으면 Windows 기본 powershell 로.
                let prog = if program_exists("pwsh.exe") {
                    "pwsh.exe"
                } else {
                    "powershell.exe"
                };
                SpawnSpec::new(prog).arg("-NoLogo")
            } else {
                SpawnSpec::new("pwsh")
            }
        }
        Shell::Cmd => {
            if cfg!(windows) {
                SpawnSpec::new("cmd.exe")
            } else {
                SpawnSpec::new("/bin/sh")
            }
        }
        Shell::Wsl => {
            if cfg!(windows) {
                SpawnSpec::new("wsl.exe")
            } else {
                SpawnSpec::new("/bin/bash")
            }
        }
        Shell::Ssh => {
            let host = session.ssh_host.trim();
            if host.is_empty() {
                return Err("SSH 호스트를 세션 설정에 입력하세요".into());
            }
            SpawnSpec::new("ssh").arg(host)
        }
    };

    spec = spec
        .cwd(&session.cwd)
        .size(cols, rows)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor");

    for e in &session.env {
        if !e.k.trim().is_empty() {
            spec = spec.env(e.k.trim(), &e.v);
        }
    }
    Ok(spec)
}

/// 터미널 화면을 연다 — 이미 돌고 있는 셸이면 다시 붙이고, 없으면 새로 띄운다.
///
/// 세션을 오가면 xterm 컴포넌트가 사라졌다 다시 생기지만 셸은 계속 살아 있어야 하므로,
/// 먼저 기존 슬롯을 찾아 출력 채널만 갈아 끼운다.
///
/// 새로 띄우는 경로에서는 xterm 이 이미 준비돼 있어야 한다 —
/// ConPTY 는 시작하자마자 커서 위치(DSR)를 묻고 답이 올 때까지 아무것도 내보내지 않는다.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
    cols: u16,
    rows: u16,
    on_data: Channel<Response>,
) -> Result<SpawnResult, String> {
    // 1) 재연결 — 살아 있는 셸이 있으면 화면만 다시 붙인다.
    {
        let terms = state.terminals.lock();
        if let Some(slot) = terms.get(&pane_id) {
            if slot.pty.is_alive() {
                *slot.sink.lock() = Some(on_data);
                let mut core = slot.core.lock();
                core.resize(cols as usize, rows as usize);
                let restored = core.serialize_scrollback(SCROLLBACK_LINES);
                drop(core);
                let _ = slot.pty.resize(cols, rows);
                return Ok(SpawnResult {
                    restored,
                    banner: String::new(),
                    attached: true,
                });
            }
        }
    }

    // 2) 죽은 슬롯이 남아 있으면 치우고 새로 띄운다.
    state.kill_pane(&pane_id);

    let (spec, start, restored) = {
        let mut snap = state.snapshot.lock();
        let session = snap
            .session_mut(&session_id)
            .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;
        let spec = shell_spec(session, cols, rows)?;
        let start = session.start.trim().to_string();
        // 스크롤백은 한 번 replay 하면 메모리에서 비운다 (flush 때 다시 채워진다).
        let restored = session
            .pane_mut(&pane_id)
            .and_then(|p| p.scrollback.take())
            .unwrap_or_default();
        (spec, start, restored)
    };

    let core = Arc::new(Mutex::new(TermCore::new(
        cols as usize,
        rows as usize,
        SCROLLBACK_LINES,
    )));

    // 복원 내용도 코어에 먼저 먹여 둬야 다음 flush 에서 이어진다.
    if !restored.is_empty() {
        core.lock().feed(restored.as_bytes());
    }

    let sink: DataSink = Arc::new(Mutex::new(Some(on_data)));
    let sink_for_read = sink.clone();
    let core_for_read = core.clone();
    let on_exit_app = app.clone();
    let on_exit_pane = pane_id.clone();

    let pty = PtyHandle::spawn(
        spec,
        move |chunk| {
            // 1) authoritative 버퍼 갱신
            core_for_read.lock().feed(chunk);
            // 2) 렌더용 raw 바이트를 웹뷰로 (붙어 있는 xterm 이 있을 때만)
            if let Some(channel) = sink_for_read.lock().as_ref() {
                let _ = channel.send(Response::new(chunk.to_vec()));
            }
        },
        move |code| {
            let _ = on_exit_app.emit(
                "pty://exit",
                ExitEvent {
                    pane_id: on_exit_pane,
                    code,
                },
            );
        },
    )
    .map_err(|e| e.to_string())?;
    let pty = Arc::new(pty);

    // 시작 명령은 셸 프롬프트가 뜬 뒤에 흘려보낸다.
    if !start.is_empty() {
        let pty_for_start = pty.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            let _ = pty_for_start.write(format!("{start}\r").as_bytes());
        });
    }

    state.terminals.lock().insert(
        pane_id.clone(),
        TerminalSlot {
            session_id: session_id.clone(),
            pty,
            core,
            sink,
        },
    );

    {
        let mut snap = state.snapshot.lock();
        if let Some(pane) = snap
            .session_mut(&session_id)
            .and_then(|s| s.pane_mut(&pane_id))
        {
            pane.kind = PaneKind::Term;
            pane.alive = true;
        }
    }

    let banner = if restored.is_empty() {
        String::new()
    } else {
        format!(
            "\u{1b}[32m세션 복원 완료 (스크롤백 {} 라인)\u{1b}[0m\r\n",
            restored.lines().count()
        )
    };

    Ok(SpawnResult {
        restored,
        banner,
        attached: false,
    })
}

/// xterm 이 사라질 때(세션 전환 등) 출력 채널만 떼어 놓는다. 셸은 계속 돈다.
#[tauri::command]
pub fn pty_detach(state: State<'_, AppState>, pane_id: String) {
    if let Some(slot) = state.terminals.lock().get(&pane_id) {
        *slot.sink.lock() = None;
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, pane_id: String, data: String) -> Result<(), String> {
    let terms = state.terminals.lock();
    let slot = terms
        .get(&pane_id)
        .ok_or_else(|| "터미널이 열려 있지 않습니다".to_string())?;
    slot.pty.write(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terms = state.terminals.lock();
    let slot = terms
        .get(&pane_id)
        .ok_or_else(|| "터미널이 열려 있지 않습니다".to_string())?;
    slot.core.lock().resize(cols as usize, rows as usize);
    slot.pty.resize(cols, rows).map_err(|e| e.to_string())
}

/// 세션에 저장해 둔 AI 세션 ID 로 이어붙이기 명령을 만들어 그대로 실행한다.
/// 디자인 설정 모달의 "claude --resume / codex resume 자동 이어붙임" 을 명시적 동작으로 옮긴 것.
#[tauri::command]
pub fn pty_run_ai(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
    kind: String,
) -> Result<String, String> {
    let command = {
        let snap = state.snapshot.lock();
        let session = snap
            .session(&session_id)
            .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;
        match kind.as_str() {
            "claude" => {
                let id = session.claude.trim();
                if id.is_empty() {
                    return Err("이 세션에 저장된 Claude 세션 ID 가 없습니다".into());
                }
                format!("claude --resume {id}")
            }
            "codex" => {
                let id = session.codex.trim();
                if id.is_empty() {
                    return Err("이 세션에 저장된 Codex 세션 ID 가 없습니다".into());
                }
                format!("codex resume --session {id}")
            }
            other => return Err(format!("알 수 없는 AI 종류: {other}")),
        }
    };

    let terms = state.terminals.lock();
    let slot = terms
        .get(&pane_id)
        .ok_or_else(|| "터미널 창을 먼저 선택하세요".to_string())?;
    slot.pty
        .write(format!("{command}\r").as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(command)
}

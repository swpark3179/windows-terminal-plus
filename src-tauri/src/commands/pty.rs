//! 셸 스폰과 입출력 중계.
//!
//! 흐름: PTY → (rterm-term 코어에 반영) + (Channel 로 xterm.js 에 raw 전달)
//!       xterm.js → `pty_write` → PTY

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rterm_core::{Pane, PaneKind, Session, Shell, SCROLLBACK_LINES};
use rterm_pty::{PtyHandle, SpawnSpec};
use rterm_term::TermCore;
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, State};

use crate::shellinit::{self, ShellInit};
use crate::state::{AppState, DataSink, ShellMeta, ShellMetaRef, TerminalSlot};

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

/// 이 창을 어느 폴더에서 띄울지 정한다.
///
/// 창이 기억하는 폴더(셸이 OSC 로 알려 준 마지막 위치)를 우선하고, 그 폴더가 사라졌으면
/// 세션 설정의 기본 폴더로 돌아간다.
///
/// `is_dir()` 검사를 **여기서** 해야 한다. `PtyHandle::spawn` 은 없는 폴더를 조용히 버리는데,
/// 그러면 셸이 세션 폴더가 아니라 **앱의 폴더** 에서 뜬다.
fn resolve_cwd(session: &Session, pane: Option<&Pane>) -> (String, bool) {
    let remembered = pane
        .and_then(|p| p.cwd.as_deref())
        .map(str::trim)
        .filter(|d| !d.is_empty());

    match remembered {
        Some(dir) if std::path::Path::new(dir).is_dir() => (dir.to_string(), false),
        // 기억은 하고 있었지만 폴더가 없어졌다 — 물러섰다는 사실을 배너로 알린다.
        Some(_) => (session.cwd.clone(), true),
        None => (session.cwd.clone(), false),
    }
}

/// 세션 설정 + 이 창이 기억하는 폴더로 실제 셸 명령을 만든다.
///
/// `restoring` 은 복원 스폰인지 — WSL 은 이때만 `--cd` 를 쓴다(아래 참조).
fn shell_spec(
    session: &Session,
    cwd: &str,
    restoring: bool,
    init: Option<ShellInit>,
    cols: u16,
    rows: u16,
) -> Result<SpawnSpec, String> {
    let init = init.unwrap_or_default();
    let mut set_cwd = true;

    let mut spec = match session.shell {
        Shell::Pwsh => {
            if cfg!(windows) {
                // PowerShell 7 이 없으면 Windows 기본 powershell 로.
                let prog = if program_exists("pwsh.exe") {
                    "pwsh.exe"
                } else {
                    "powershell.exe"
                };
                let mut spec = SpawnSpec::new(prog);
                if init.args.is_empty() {
                    spec = spec.arg("-NoLogo");
                } else {
                    // 셸 통합 인자에 -NoLogo 가 이미 들어 있다.
                    for a in &init.args {
                        spec = spec.arg(a);
                    }
                }
                spec
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
                let mut spec = SpawnSpec::new("wsl.exe");
                // WSL 안에서 기록된 폴더는 `/home/u/x` 꼴이라 윈도우 쪽 CommandBuilder::cwd()
                // 에 줄 수 없다. `--cd` 가 그 일을 대신한다. 최신 WSL 이 필요한 인자라
                // 복원할 때만 쓴다 — 평범한 새 창이 이 길로 들어가 실패하지 않도록.
                if restoring && cwd.starts_with('/') {
                    spec = spec.arg("--cd").arg(cwd);
                    set_cwd = false;
                }
                spec
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

    if set_cwd {
        spec = spec.cwd(cwd);
    }
    spec = spec
        .size(cols, rows)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor");

    // 셸 통합 환경변수를 먼저 얹는다 — 사용자가 설정 화면에서 같은 이름을 지정했다면
    // 그쪽이 이기는 것이 맞다.
    for (k, v) in &init.env {
        spec = spec.env(k, v);
    }

    for e in &session.env {
        if !e.k.trim().is_empty() {
            spec = spec.env(e.k.trim(), &e.v);
        }
    }
    Ok(spec)
}

/// 셸 통합 마커를 슬롯의 실시간 정보에 반영한다.
fn apply_shell_events(meta: &ShellMetaRef, events: &[rterm_term::ShellEvent]) {
    let mut m = meta.lock();
    for ev in events {
        match ev {
            rterm_term::ShellEvent::Cwd(path) => {
                m.integration = true;
                m.prompt_seq = m.prompt_seq.wrapping_add(1);
                m.cwd = Some(path.clone());
            }
        }
    }
}

/// 프롬프트가 한 번 더 돌아올 때까지 기다린다. 마커가 없는 셸에서도 반드시 시간 안에 풀린다.
fn wait_for_prompt(meta: &ShellMetaRef, deadline: Duration) {
    let start = std::time::Instant::now();
    let before = meta.lock().prompt_seq;
    while start.elapsed() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        if meta.lock().prompt_seq != before {
            return;
        }
    }
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

    let config_dir = state.config_dir.clone();

    let (spec, start, restored, restore_ai, cwd_fell_back) = {
        let mut snap = state.snapshot.lock();
        let session = snap
            .session_mut(&session_id)
            .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;

        // 스크롤백이 남아 있다는 것은 지난번 스냅샷에서 되살아나는 중이라는 뜻이다.
        let pane = session.pane(&pane_id).cloned();
        let restoring = pane.as_ref().is_some_and(|p| p.scrollback.is_some());
        let (cwd, cwd_fell_back) = resolve_cwd(session, pane.as_ref());
        let init = if shellinit::is_disabled(&session.env) {
            None
        } else {
            shellinit::for_shell(&config_dir, session.shell)
        };
        let spec = shell_spec(session, &cwd, restoring, init, cols, rows)?;
        let start = session.start.trim().to_string();

        // 스크롤백과 AI 표시는 한 번 쓰면 비운다 —
        // 복원 도중 셸이 죽어 다시 열려도 이어붙이기가 두 번 나가지 않는다.
        let mut pane_mut = session.pane_mut(&pane_id);
        let restored = pane_mut
            .as_deref_mut()
            .and_then(|p| p.scrollback.take())
            .unwrap_or_default();
        let restore_ai = pane_mut.and_then(|p| p.ai.take());
        (spec, start, restored, restore_ai, cwd_fell_back)
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
    let meta: ShellMetaRef = Arc::new(Mutex::new(ShellMeta::default()));
    let sink_for_read = sink.clone();
    let core_for_read = core.clone();
    let meta_for_read = meta.clone();
    let on_exit_app = app.clone();
    let on_exit_pane = pane_id.clone();
    let meta_for_exit = meta.clone();

    let pty = PtyHandle::spawn(
        spec,
        move |chunk| {
            // 1) authoritative 버퍼 갱신 + 셸 통합 마커 수집
            let events = {
                let mut core = core_for_read.lock();
                core.feed(chunk);
                core.take_shell_events()
            };
            if !events.is_empty() {
                apply_shell_events(&meta_for_read, &events);
            }
            // 2) 렌더용 raw 바이트를 웹뷰로 (붙어 있는 xterm 이 있을 때만)
            if let Some(channel) = sink_for_read.lock().as_ref() {
                let _ = channel.send(Response::new(chunk.to_vec()));
            }
        },
        move |code| {
            // 셸이 끝나면 그 창에 대해 우리가 아는 것도 더 이상 유효하지 않다.
            meta_for_exit.lock().integration = false;
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

    // 시작 명령과 AI 이어붙이기를 순서대로 흘려보낸다.
    // 첫 줄은 프롬프트가 뜰 시간을 준 뒤(400ms), 다음 줄은 프롬프트 마커를 기다렸다 보낸다.
    let mut boot: Vec<String> = Vec::new();
    if !start.is_empty() {
        boot.push(start);
    }
    if let Some(kind) = restore_ai {
        boot.push(kind.resume_command().to_string());
    }
    if !boot.is_empty() {
        let pty_for_boot = pty.clone();
        let meta_for_boot = meta.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            for (i, line) in boot.iter().enumerate() {
                if i > 0 {
                    wait_for_prompt(&meta_for_boot, Duration::from_secs(3));
                }
                let _ = pty_for_boot.write(format!("{line}\r").as_bytes());
            }
        });
    }

    state.terminals.lock().insert(
        pane_id.clone(),
        TerminalSlot {
            session_id: session_id.clone(),
            pty,
            core,
            sink,
            meta,
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
        // 우리가 대신 쳐 준 것과 물러선 것을 함께 알린다 — 그래야 오류가 떠도 뜬금없지 않다.
        let ai_note = restore_ai
            .map(|k| format!(" · {} 재실행", k.resume_command()))
            .unwrap_or_default();
        let cwd_note = if cwd_fell_back {
            " · 이전 폴더가 없어 세션 기본 폴더로 시작"
        } else {
            ""
        };
        format!(
            "\u{1b}[32m세션 복원 완료 (스크롤백 {} 라인){ai_note}{cwd_note}\u{1b}[0m\r\n",
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

#[cfg(test)]
mod tests {
    use super::*;
    use rterm_core::{EnvVar, Session};

    fn session(cwd: &str) -> Session {
        Session::new("테스트", cwd, 0)
    }

    fn term_pane(cwd: Option<&str>) -> Pane {
        let mut p = Pane::empty(1, 1, 1, 1);
        p.kind = PaneKind::Term;
        p.cwd = cwd.map(str::to_string);
        p
    }

    #[test]
    fn resolve_cwd_prefers_the_folder_the_pane_remembers() {
        let tmp = std::env::temp_dir();
        let dir = tmp.to_string_lossy().to_string();
        let s = session("/definitely/not/here");
        let (cwd, fell_back) = resolve_cwd(&s, Some(&term_pane(Some(&dir))));
        assert_eq!(cwd, dir);
        assert!(!fell_back);
    }

    #[test]
    fn resolve_cwd_falls_back_when_the_remembered_folder_is_gone() {
        // 워크트리를 지웠다거나 드라이브가 빠진 경우. 세션 기본 폴더로 물러서고 그 사실을 알린다.
        let s = session("/tmp");
        let (cwd, fell_back) = resolve_cwd(&s, Some(&term_pane(Some("/definitely/not/here"))));
        assert_eq!(cwd, "/tmp");
        assert!(fell_back, "물러섰다는 것을 배너로 알려야 한다");
    }

    #[test]
    fn resolve_cwd_uses_the_session_folder_for_a_fresh_pane() {
        let s = session("/tmp");
        let (cwd, fell_back) = resolve_cwd(&s, Some(&term_pane(None)));
        assert_eq!(cwd, "/tmp");
        assert!(!fell_back);
        let (cwd, _) = resolve_cwd(&s, None);
        assert_eq!(cwd, "/tmp");
    }

    #[test]
    fn shell_integration_env_is_carried_into_the_spawn() {
        let s = session("/tmp");
        let init = shellinit::for_shell(std::path::Path::new("/tmp/rterm"), Shell::Wsl);
        let spec = shell_spec(&s, "/tmp", false, init, 80, 24).expect("spec");
        assert!(
            spec.env.iter().any(|(k, _)| k == "PROMPT_COMMAND"),
            "셸이 폴더를 알리게 하는 환경변수가 실려야 한다: {:?}",
            spec.env
        );
        assert_eq!(spec.cwd.as_deref(), Some("/tmp"));
    }

    #[test]
    fn a_user_env_var_beats_the_shell_integration_one() {
        // 설정 화면에서 직접 PROMPT_COMMAND 를 지정했다면 그쪽이 이겨야 한다.
        let mut s = session("/tmp");
        s.env = vec![EnvVar {
            k: "PROMPT_COMMAND".into(),
            v: "내 것".into(),
        }];
        let init = shellinit::for_shell(std::path::Path::new("/tmp/rterm"), Shell::Wsl);
        let spec = shell_spec(&s, "/tmp", false, init, 80, 24).expect("spec");
        let last = spec
            .env
            .iter()
            .filter(|(k, _)| k == "PROMPT_COMMAND")
            .last()
            .expect("있어야 한다");
        assert_eq!(last.1, "내 것", "나중에 얹힌 값이 이긴다");
    }

    #[test]
    fn ssh_without_a_host_is_rejected_before_spawning() {
        let mut s = session("/tmp");
        s.shell = Shell::Ssh;
        assert!(shell_spec(&s, "/tmp", false, None, 80, 24).is_err());
    }

    #[test]
    fn shell_events_update_the_slot_meta() {
        let meta: ShellMetaRef = Arc::new(Mutex::new(ShellMeta::default()));
        assert!(!meta.lock().integration);

        apply_shell_events(
            &meta,
            &[rterm_term::ShellEvent::Cwd("/tmp/work".into())],
        );
        let m = meta.lock();
        assert!(m.integration, "마커를 봤으면 통합이 켜진다");
        assert_eq!(m.cwd.as_deref(), Some("/tmp/work"));
        assert_eq!(m.prompt_seq, 1, "프롬프트가 한 번 돌았다");
    }

    #[test]
    fn wait_for_prompt_gives_up_instead_of_hanging() {
        // 셸 통합이 없는 환경(ssh 등)에서도 부트 스레드가 영원히 붙잡혀 있으면 안 된다.
        let meta: ShellMetaRef = Arc::new(Mutex::new(ShellMeta::default()));
        let start = std::time::Instant::now();
        wait_for_prompt(&meta, Duration::from_millis(150));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}

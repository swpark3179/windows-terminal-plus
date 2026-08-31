//! 앱이 실제로 쓰는 터미널 경로를 통째로 확인한다.
//!
//! PTY(ConPTY) → `rterm-term` 코어 → 스크롤백 직렬화 → 새 코어로 재주입.
//! 앱에서는 xterm.js 가 ConPTY 의 커서 위치 질의(DSR)에 답하지만,
//! 테스트에는 xterm 이 없으므로 여기서 직접 답한다.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rterm_pty::{PtyHandle, SpawnSpec};
use rterm_term::TermCore;

const MARKER: &str = "rterm-pipeline-ok";

/// 셸을 띄우고, 코어에 먹이면서, 마커가 화면에 나타날 때까지 기다린다.
fn run_shell_into_core() -> Option<Arc<Mutex<TermCore>>> {
    let core = Arc::new(Mutex::new(TermCore::new(80, 24, 512)));
    let core_for_read = core.clone();
    let (tx, rx) = mpsc::channel::<Vec<u8>>();

    let spec = if cfg!(windows) {
        SpawnSpec::new("cmd.exe").arg("/c").arg(format!("echo {MARKER}"))
    } else {
        SpawnSpec::new("/bin/sh").arg("-c").arg(format!("echo {MARKER}"))
    }
    .size(80, 24);

    let pty = PtyHandle::spawn(
        spec,
        move |chunk| {
            // 앱과 똑같이 authoritative 버퍼부터 갱신한다.
            core_for_read.lock().unwrap().feed(chunk);
            let _ = tx.send(chunk.to_vec());
        },
        |_| {},
    )
    .ok()?;

    let deadline = Instant::now() + Duration::from_secs(25);
    let mut seen: Vec<u8> = Vec::new();
    let mut answered = false;

    while Instant::now() < deadline {
        if core.lock().unwrap().plain_lines().iter().any(|l| l.contains(MARKER)) {
            return Some(core);
        }
        match rx.recv_timeout(Duration::from_millis(400)) {
            Ok(chunk) => {
                seen.extend_from_slice(&chunk);
                if !answered && seen.windows(4).any(|w| w == b"\x1b[6n") {
                    answered = true;
                    pty.write(b"\x1b[1;1R").ok()?;
                }
            }
            Err(_) => continue,
        }
    }
    None
}

#[test]
fn shell_output_reaches_the_core_and_survives_a_restore() {
    let Some(core) = run_shell_into_core() else {
        panic!("셸 출력이 코어에 도달하지 않았습니다 (DSR 응답 또는 스폰 확인 필요)");
    };

    // 1) 코어가 실제 셸 출력을 들고 있다.
    let lines = core.lock().unwrap().plain_lines();
    assert!(
        lines.iter().any(|l| l.contains(MARKER)),
        "코어 버퍼 = {lines:?}"
    );

    // 2) 스냅샷용 직렬화에도 남는다.
    let dump = core.lock().unwrap().serialize_scrollback(8192);
    assert!(dump.contains(MARKER), "직렬화 결과 = {dump:?}");

    // 3) 복원 경로: 새 코어에 그대로 재주입하면 같은 화면이 돌아온다.
    let mut restored = TermCore::new(80, 24, 512);
    restored.feed(dump.as_bytes());
    assert!(
        restored.plain_lines().iter().any(|l| l.contains(MARKER)),
        "복원 버퍼 = {:?}",
        restored.plain_lines()
    );

    // 4) 스크롤백 검색은 Rust 버퍼 기준으로 동작한다.
    assert!(!core.lock().unwrap().search(MARKER).is_empty());
}

//! rterm-pty — ConPTY(및 unix pty) 위의 셸 프로세스 관리.
//!
//! Windows Terminal 이 conhost 의 ConPTY 로 하던 일을 `portable-pty` 로 옮겼다.
//! 읽기 스레드가 PTY 출력을 한 번 읽어 콜백으로 흘려보내면, 호출부는 그것을
//! (1) `rterm-term` 코어와 (2) 웹뷰의 xterm.js 양쪽에 나눠 준다.

use std::io::{Read, Write};
use std::sync::Arc;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// 읽기 스레드가 한 번에 퍼 올리는 크기.
const READ_CHUNK: usize = 8 * 1024;

/// 셸 하나를 띄우는 데 필요한 전부.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

impl SpawnSpec {
    pub fn new(program: impl Into<String>) -> Self {
        SpawnSpec {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            cols: 80,
            rows: 24,
        }
    }

    pub fn arg(mut self, a: impl Into<String>) -> Self {
        self.args.push(a.into());
        self
    }

    pub fn cwd(mut self, dir: impl Into<String>) -> Self {
        self.cwd = Some(dir.into());
        self
    }

    pub fn env(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.env.push((k.into(), v.into()));
        self
    }

    pub fn size(mut self, cols: u16, rows: u16) -> Self {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self
    }
}

/// 살아있는 PTY 한 개.
/// Tauri 관리 상태에 들어가려면 `Sync` 여야 해서 master 도 잠금 뒤에 둔다.
pub struct PtyHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    alive: Arc<Mutex<bool>>,
    /// 셸 프로세스 id. 이 셸의 자손 중에 AI CLI 가 돌고 있는지 훑을 때 뿌리가 된다.
    pid: Option<u32>,
}

impl PtyHandle {
    /// 셸을 띄우고 읽기 스레드를 건다.
    ///
    /// * `on_data` — PTY 출력 덩어리마다 호출된다 (읽기 스레드 컨텍스트).
    /// * `on_exit` — 자식이 끝나면 종료 코드와 함께 한 번 호출된다.
    pub fn spawn<D, E>(spec: SpawnSpec, mut on_data: D, on_exit: E) -> Result<Self>
    where
        D: FnMut(&[u8]) + Send + 'static,
        E: FnOnce(u32) + Send + 'static,
    {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("PTY 를 열 수 없습니다")?;

        let mut cmd = CommandBuilder::new(&spec.program);
        for a in &spec.args {
            cmd.arg(a);
        }
        if let Some(dir) = &spec.cwd {
            // 존재하지 않는 디렉터리를 주면 스폰 자체가 실패하므로 미리 걸러 낸다.
            if std::path::Path::new(dir).is_dir() {
                cmd.cwd(dir);
            }
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("셸을 실행할 수 없습니다: {}", spec.program))?;
        let killer = child.clone_killer();
        // child 는 곧 대기 스레드로 넘어간다. pid 는 그 전에 붙잡아 둬야 한다.
        let pid = child.process_id();

        // slave 를 손에서 놓아야 자식 종료 시 reader 가 EOF 를 본다.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .context("PTY 출력을 읽을 수 없습니다")?;
        let writer = pair
            .master
            .take_writer()
            .context("PTY 입력을 쓸 수 없습니다")?;

        let alive = Arc::new(Mutex::new(true));

        // 읽기 스레드 — 출력만 퍼 나른다.
        //
        // ConPTY 는 자식이 끝나도 master 파이프를 곧바로 닫지 않으므로 여기서 EOF 를
        // 기다려 종료를 판단하면 안 된다. 이 루프는 `PtyHandle` 이 drop 되어 master 가
        // 닫힐 때 함께 끝난다.
        std::thread::Builder::new()
            .name(format!("rterm-pty-read-{}", spec.program))
            .spawn(move || {
                let mut reader = reader;
                let mut buf = vec![0u8; READ_CHUNK];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => on_data(&buf[..n]),
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            })
            .context("PTY 읽기 스레드를 만들 수 없습니다")?;

        // 대기 스레드 — 종료 감지는 파이프가 아니라 자식 프로세스에서 직접 받는다.
        let alive_for_waiter = alive.clone();
        std::thread::Builder::new()
            .name(format!("rterm-pty-wait-{}", spec.program))
            .spawn(move || {
                let code = child.wait().map(|s| s.exit_code()).unwrap_or(0);
                *alive_for_waiter.lock() = false;
                on_exit(code);
            })
            .context("PTY 대기 스레드를 만들 수 없습니다")?;

        Ok(PtyHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            alive,
            pid,
        })
    }

    /// 키 입력을 셸로 보낸다.
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    /// 패널 크기가 바뀌면 ConPTY 에도 알려 줘야 프롬프트가 따라온다.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("PTY 크기를 바꿀 수 없습니다")
    }

    pub fn is_alive(&self) -> bool {
        *self.alive.lock()
    }

    /// 셸 프로세스 id. 플랫폼이 알려 주지 않으면 `None`.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// 자식 프로세스를 종료한다. 이미 죽었으면 조용히 넘어간다.
    pub fn kill(&self) {
        let _ = self.killer.lock().kill();
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// 어느 플랫폼에서든 있는 최소한의 셸로 한 줄 찍어 보고 종료까지 확인한다.
    #[test]
    fn spawns_reads_and_exits() {
        let spec = if cfg!(windows) {
            SpawnSpec::new("cmd.exe").arg("/c").arg("echo rterm-ok")
        } else {
            SpawnSpec::new("/bin/sh").arg("-c").arg("echo rterm-ok")
        }
        .size(80, 24);

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (done_tx, done_rx) = mpsc::channel::<u32>();

        let pty = PtyHandle::spawn(
            spec,
            move |chunk| {
                let _ = tx.send(chunk.to_vec());
            },
            move |code| {
                let _ = done_tx.send(code);
            },
        )
        .expect("spawn ok");

        // ConPTY 는 시작하자마자 커서 위치를 묻고(DSR, `ESC[6n`) 답이 올 때까지 출력을
        // 내보내지 않는다. 실제 앱에서는 xterm.js 가 자동으로 답하지만 여기서는 직접 답해야 한다.
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut seen = Vec::new();
        let mut answered = false;
        while std::time::Instant::now() < deadline {
            if String::from_utf8_lossy(&seen).contains("rterm-ok") {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(chunk) => {
                    seen.extend_from_slice(&chunk);
                    if !answered && seen.windows(4).any(|w| w == b"\x1b[6n") {
                        answered = true;
                        pty.write(b"\x1b[1;1R").expect("DSR 응답");
                    }
                }
                Err(_) => continue,
            }
        }
        let text = String::from_utf8_lossy(&seen);
        assert!(text.contains("rterm-ok"), "PTY 출력 = {text:?}");

        let code = done_rx
            .recv_timeout(Duration::from_secs(20))
            .expect("자식이 끝나야 한다");
        assert_eq!(code, 0);
        assert!(!pty.is_alive(), "종료 후에는 alive 가 꺼져야 한다");
    }

    #[test]
    fn resize_is_accepted_while_running() {
        let spec = if cfg!(windows) {
            SpawnSpec::new("cmd.exe")
        } else {
            SpawnSpec::new("/bin/sh")
        }
        .size(80, 24);

        let pty = PtyHandle::spawn(spec, |_| {}, |_| {}).expect("spawn ok");
        // 자손을 훑으려면 셸 pid 를 알아야 한다.
        assert!(pty.pid().is_some(), "셸 pid 를 알 수 있어야 한다");
        pty.resize(120, 40).expect("resize ok");
        pty.write(b"exit\r").expect("write ok");
        pty.kill();
    }

    #[test]
    fn missing_program_reports_an_error_instead_of_panicking() {
        let spec = SpawnSpec::new("이런프로그램은없다.exe");
        assert!(PtyHandle::spawn(spec, |_| {}, |_| {}).is_err());
    }
}

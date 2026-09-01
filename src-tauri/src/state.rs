//! 앱 전역 상태 — 스냅샷 한 벌과 살아있는 PTY 목록.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use rterm_core::{PaneKind, Snapshot, SCROLLBACK_LINES};
use rterm_pty::PtyHandle;
use rterm_term::TermCore;
use tauri::ipc::{Channel, Response};

/// PTY 출력이 흘러가는 웹뷰 채널. 세션을 오가며 xterm 이 새로 만들어질 때마다 갈아 끼운다.
/// 읽기 스레드는 이 자리를 매번 들여다보므로 PTY 를 다시 띄우지 않고도 화면만 다시 붙일 수 있다.
pub type DataSink = Arc<Mutex<Option<Channel<Response>>>>;

/// 셸이 스스로 알려 준 실시간 정보.
///
/// 프롬프트가 뜰 때마다 갱신되지만 디스크로 내려가지는 않는다 — 스크롤백과 똑같이
/// flush 때만 스냅샷으로 옮겨 담는다. 그래서 프롬프트마다 파일을 쓰는 일이 없다.
#[derive(Debug, Default)]
pub struct ShellMeta {
    /// 마지막 OSC 9;9 로 받은 실제 작업 폴더.
    pub cwd: Option<String>,
    /// 셸 통합 마커를 한 번이라도 봤는지. 못 봤으면 cwd 를 믿지 않는다.
    pub integration: bool,
    /// 프롬프트가 돌아온 횟수. 복원 명령을 언제 흘려보낼지 정하는 데 쓴다.
    pub prompt_seq: u64,
}

pub type ShellMetaRef = Arc<Mutex<ShellMeta>>;

/// 터미널 패널 하나에 딸린 런타임 자원.
pub struct TerminalSlot {
    pub session_id: String,
    pub pty: Arc<PtyHandle>,
    /// Rust 쪽 authoritative 버퍼. 스크롤백·검색·스냅샷의 근거가 된다.
    pub core: Arc<Mutex<TermCore>>,
    pub sink: DataSink,
    /// 셸 통합으로 알아낸 것들. 읽기 스레드가 갱신한다.
    pub meta: ShellMetaRef,
}

pub struct AppState {
    pub snapshot: Mutex<Snapshot>,
    /// pane id → 터미널 슬롯.
    pub terminals: Mutex<HashMap<String, TerminalSlot>>,
    pub config_dir: PathBuf,
    pub home: String,
}

impl AppState {
    pub fn new(config_dir: PathBuf, home: String) -> Self {
        let path = Snapshot::path_in(&config_dir);
        let snapshot = Snapshot::load(&path).unwrap_or_else(|| Snapshot::seed(&home));
        AppState {
            snapshot: Mutex::new(snapshot),
            terminals: Mutex::new(HashMap::new()),
            config_dir,
            home,
        }
    }

    pub fn snapshot_path(&self) -> PathBuf {
        Snapshot::path_in(&self.config_dir)
    }

    /// 현재 스냅샷을 디스크에 기록하고 기록 시각(UNIX 초)을 돌려준다.
    /// 레이아웃 변경마다 불려도 부담 없도록 스크롤백은 건드리지 않는다.
    pub fn persist(&self) -> u64 {
        let path = self.snapshot_path();
        let mut snap = self.snapshot.lock();
        match snap.save(&path) {
            Ok(at) => at,
            Err(e) => {
                eprintln!("[rterm] 스냅샷 저장 실패: {e}");
                0
            }
        }
    }

    /// 셸이 알려 준 작업 폴더를 스냅샷으로 옮긴다. 값 복사뿐이라 매 명령마다 불려도 된다.
    ///
    /// 셸 통합 마커를 한 번도 못 본 창은 건드리지 않는다 — 그 창의 폴더에 대해
    /// 우리가 아는 것이 없으므로, 예전 값을 지우지도 새로 지어내지도 않는다.
    fn pull_cwd(&self) {
        let seen: Vec<(String, String, String)> = {
            let terms = self.terminals.lock();
            terms
                .iter()
                .filter_map(|(pane_id, slot)| {
                    let meta = slot.meta.lock();
                    if !meta.integration {
                        return None;
                    }
                    meta.cwd
                        .clone()
                        .map(|cwd| (slot.session_id.clone(), pane_id.clone(), cwd))
                })
                .collect()
        };

        let mut snap = self.snapshot.lock();
        for (session_id, pane_id, cwd) in seen {
            if let Some(pane) = snap
                .session_mut(&session_id)
                .and_then(|s| s.pane_mut(&pane_id))
            {
                pane.cwd = Some(cwd);
            }
        }
    }

    /// 창마다 지금 돌고 있는 AI CLI 를 스냅샷에 적어 둔다.
    ///
    /// 프로세스 목록을 한 번 훑으므로 flush 에서만 부른다. 종료 시점의 flush 는
    /// `kill_all()` 보다 먼저라 그때도 자식들이 아직 살아 있다.
    fn capture_ai(&self) {
        let shells: Vec<(String, u32)> = {
            let terms = self.terminals.lock();
            terms
                .iter()
                .filter(|(_, slot)| slot.pty.is_alive())
                .filter_map(|(pane_id, slot)| slot.pty.pid().map(|pid| (pane_id.clone(), pid)))
                .collect()
        };
        let running = crate::aiscan::detect(&shells);

        let owners: Vec<(String, String)> = {
            let terms = self.terminals.lock();
            terms
                .iter()
                .map(|(pane_id, slot)| (slot.session_id.clone(), pane_id.clone()))
                .collect()
        };

        let mut snap = self.snapshot.lock();
        for (session_id, pane_id) in owners {
            if let Some(pane) = snap
                .session_mut(&session_id)
                .and_then(|s| s.pane_mut(&pane_id))
            {
                // 살아 있는 창은 훑은 결과가 곧 진실이다 — 끝난 AI 는 여기서 지워진다.
                pane.ai = running.get(&pane_id).copied();
            }
        }
    }

    /// 살아있는 모든 터미널의 스크롤백을 스냅샷에 밀어 넣는다.
    /// 비용이 있으므로 종료 직전과 명시적 flush 에서만 부른다.
    pub fn capture_scrollback(&self) {
        let dumps: Vec<(String, String, String)> = {
            let terms = self.terminals.lock();
            terms
                .iter()
                .map(|(pane_id, slot)| {
                    let text = slot.core.lock().serialize_scrollback(SCROLLBACK_LINES);
                    (slot.session_id.clone(), pane_id.clone(), text)
                })
                .collect()
        };

        let mut snap = self.snapshot.lock();
        for (session_id, pane_id, text) in dumps {
            if let Some(session) = snap.session_mut(&session_id) {
                if let Some(pane) = session.pane_mut(&pane_id) {
                    pane.scrollback = if text.is_empty() { None } else { Some(text) };
                }
            }
        }
    }

    /// 스크롤백 · 작업 폴더 · 실행 중인 AI 까지 갱신한 뒤 저장. 창을 닫을 때 쓴다.
    pub fn flush(&self) -> u64 {
        self.capture_scrollback();
        self.pull_cwd();
        self.capture_ai();
        self.persist()
    }

    /// 패널에 붙어 있던 PTY 를 정리한다. 터미널이 아니면 아무 일도 하지 않는다.
    pub fn kill_pane(&self, pane_id: &str) {
        if let Some(slot) = self.terminals.lock().remove(pane_id) {
            slot.pty.kill();
        }
    }

    /// 세션이 통째로 사라질 때 딸린 PTY 를 모두 정리한다.
    pub fn kill_session(&self, session_id: &str) {
        let mut terms = self.terminals.lock();
        let doomed: Vec<String> = terms
            .iter()
            .filter(|(_, s)| s.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in doomed {
            if let Some(slot) = terms.remove(&id) {
                slot.pty.kill();
            }
        }
    }

    pub fn kill_all(&self) {
        let mut terms = self.terminals.lock();
        for (_, slot) in terms.drain() {
            slot.pty.kill();
        }
    }

    /// 스냅샷의 런타임 표시를 실제 상태에 맞춘다 — `alive` 와 셸이 알려 준 작업 폴더.
    /// 프론트엔드는 이 값으로 "셸이 끝난 터미널" 을 흐리게 보여 준다.
    pub fn sync_runtime(&self) {
        self.sync_alive();
        self.pull_cwd();
    }

    fn sync_alive(&self) {
        let alive: HashMap<String, bool> = {
            let terms = self.terminals.lock();
            terms
                .iter()
                .map(|(id, slot)| (id.clone(), slot.pty.is_alive()))
                .collect()
        };
        let mut snap = self.snapshot.lock();
        for session in &mut snap.sessions {
            for pane in &mut session.panes {
                if pane.kind == PaneKind::Term {
                    pane.alive = alive.get(&pane.id).copied().unwrap_or(false);
                }
            }
        }
    }
}

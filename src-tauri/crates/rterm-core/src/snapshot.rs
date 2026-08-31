//! 종료 후 복원용 스냅샷 — 세션 · 레이아웃 · 스크롤백 · 확대 배율 · 뷰 모드.
//!
//! 디자인의 localStorage 스냅샷을 대체한다. 저장 위치는 앱 설정 디렉터리의
//! `sessions/snapshot.json` 으로, 디자인 설정 모달의 `RTERM_SNAPSHOT` 안내와 일치한다.

use crate::model::Session;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SNAPSHOT_VERSION: u32 = 1;

/// 터미널 패널이 보존하는 스크롤백 라인 수. 디자인 문구 "8,192 라인"과 맞춘다.
pub const SCROLLBACK_LINES: usize = 8192;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default = "default_version")]
    pub version: u32,
    pub sessions: Vec<Session>,
    pub active_id: String,
    #[serde(default = "default_true")]
    pub sidebar_open: bool,
    /// 마지막 기록 시각(UNIX 초). 표시 형식은 프론트엔드가 로컬 시간대로 정한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_at_epoch: Option<u64>,
    /// 이번 실행이 기존 스냅샷에서 복원된 것인지 — 상태바의 `● 복원됨` 배지에 쓰인다.
    #[serde(default, skip_serializing)]
    pub restored: bool,
}

fn default_version() -> u32 {
    SNAPSHOT_VERSION
}

fn default_true() -> bool {
    true
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Snapshot {
    /// 스냅샷이 없을 때의 초기 상태 — 홈 디렉터리 기준 세션 하나 + 빈 블럭 하나.
    pub fn seed(cwd: &str) -> Self {
        let name = Path::new(cwd)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("rterm")
            .to_string();
        let session = Session::new(name, cwd, 0);
        Snapshot {
            version: SNAPSHOT_VERSION,
            active_id: session.id.clone(),
            sessions: vec![session],
            sidebar_open: true,
            saved_at_epoch: None,
            restored: false,
        }
    }

    /// 스냅샷 파일 경로. 부모 디렉터리는 호출부가 만든다.
    pub fn path_in(config_dir: &Path) -> PathBuf {
        config_dir.join("sessions").join("snapshot.json")
    }

    /// 읽기. 파일이 없거나 깨졌으면 `None` — 호출부가 `seed()` 로 넘어간다.
    pub fn load(path: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(path).ok()?;
        let mut snap: Snapshot = serde_json::from_str(&raw).ok()?;
        if snap.sessions.is_empty() {
            return None;
        }
        // 활성 세션이 사라졌을 수 있으니 되살린다.
        if !snap.sessions.iter().any(|s| s.id == snap.active_id) {
            snap.active_id = snap.sessions[0].id.clone();
        }
        for s in &mut snap.sessions {
            crate::layout::ensure_non_empty(s);
            // PTY 는 재스폰되므로 살아있음 표시는 항상 꺼진 상태로 시작한다.
            for p in &mut s.panes {
                p.alive = false;
            }
        }
        snap.restored = true;
        Some(snap)
    }

    /// tmp 에 쓴 뒤 rename 하는 원자적 저장. 중간에 죽어도 이전 스냅샷이 남는다.
    pub fn save(&mut self, path: &Path) -> io::Result<u64> {
        let at = now_epoch();
        self.saved_at_epoch = Some(at);
        self.version = SNAPSHOT_VERSION;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_vec_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &body)?;
        // Windows 는 대상이 있으면 rename 이 실패하므로 먼저 치운다.
        let _ = std::fs::remove_file(path);
        std::fs::rename(&tmp, path)?;
        Ok(at)
    }

    pub fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }

    pub fn session_mut(&mut self, id: &str) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|s| s.id == id)
    }

    pub fn active(&self) -> Option<&Session> {
        self.session(&self.active_id)
    }

    pub fn active_mut(&mut self) -> Option<&mut Session> {
        let id = self.active_id.clone();
        self.session_mut(&id)
    }
}

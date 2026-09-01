//! 세션 · 패널 모델. 디자인(`AI Terminal.dc.html`)의 상태 형태를 그대로 옮겼다.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 디자인의 `uid(prefix)` 대응. 시간 기반이라 스냅샷을 넘나들어도 충돌하지 않는다.
pub fn uid(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{:x}{:x}", nanos & 0xffff_ffff, n & 0xfff)
}

/// 디자인 설정 모달의 셸 select 값.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    #[default]
    Pwsh,
    Cmd,
    Wsl,
    Ssh,
}

/// 창에 들어갈 수 있는 것. 디자인의 empty/term/md/text 에 이미지 뷰어를 더했다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneKind {
    Empty,
    Term,
    Md,
    Text,
    Image,
}

impl PaneKind {
    /// "프로그램이 열려 있는가" — 병합 차단 규칙의 판정 기준.
    pub fn is_occupied(self) -> bool {
        !matches!(self, PaneKind::Empty)
    }
}

/// 마크다운 패널의 뷰어/에디터 토글.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MdMode {
    #[default]
    View,
    Edit,
}

/// 터미널 창에서 돌고 있는 AI CLI.
///
/// 앱을 끌 때 무엇이 돌고 있었는지 기억해 두었다가, 다시 켜면 같은 폴더에서 이어붙인다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiKind {
    Claude,
    Codex,
}

impl AiKind {
    /// 저장해 둔 세션 ID 없이 "이 폴더의 가장 최근 대화" 를 잇는 명령.
    ///
    /// 두 CLI 모두 현재 작업 폴더를 기준으로 최근 세션을 찾으므로, 창의 폴더만 제대로
    /// 복원되면 ID 를 손으로 넣을 이유가 없다.
    pub fn resume_command(self) -> &'static str {
        match self {
            AiKind::Claude => "claude --continue",
            AiKind::Codex => "codex resume --last",
        }
    }

    /// 사이드바·헤더 칩이 쓰는 이름.
    pub fn label(self) -> &'static str {
        match self {
            AiKind::Claude => "claude",
            AiKind::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvVar {
    pub k: String,
    pub v: String,
}

/// 트랙 하나가 가질 수 있는 가장 작은 몫. 경계를 끝까지 끌어도 창이 사라지지 않게 한다.
pub const MIN_TRACK_WEIGHT: f32 = 0.04;

/// CSS grid 좌표계. 디자인과 동일하게 1-기반 트랙 인덱스를 쓴다.
///
/// 트랙마다 몫(`*_weights`)을 들고 있어 `grid-template-columns: 1.4fr 0.6fr` 처럼 펼쳐진다.
/// 경계를 끌면 이웃한 두 트랙이 몫을 주고받으므로 전체 합은 변하지 않는다 —
/// 한 창이 커지면 반대쪽이 정확히 그만큼 작아진다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grid {
    pub cols: u32,
    pub rows: u32,
    /// 길이는 `cols` 와 같다. 옛 스냅샷에는 없어서 비어 있으면 균등하게 채운다.
    #[serde(default)]
    pub col_weights: Vec<f32>,
    #[serde(default)]
    pub row_weights: Vec<f32>,
}

impl Default for Grid {
    fn default() -> Self {
        Grid::new(1, 1)
    }
}

impl Grid {
    pub fn new(cols: u32, rows: u32) -> Self {
        Grid {
            cols,
            rows,
            col_weights: vec![1.0; cols as usize],
            row_weights: vec![1.0; rows as usize],
        }
    }

    /// 몫 배열을 트랙 수에 맞추고 이상한 값을 걸러 낸다.
    /// 트랙 수를 바꾼 뒤에는 반드시 부른다.
    pub fn fix(&mut self) {
        fix_weights(&mut self.col_weights, self.cols as usize);
        fix_weights(&mut self.row_weights, self.rows as usize);
    }
}

fn fix_weights(weights: &mut Vec<f32>, len: usize) {
    weights.truncate(len);
    while weights.len() < len {
        weights.push(1.0);
    }
    for w in weights.iter_mut() {
        if !w.is_finite() || *w < MIN_TRACK_WEIGHT {
            *w = MIN_TRACK_WEIGHT;
        }
    }
    // 평균이 1이 되게 다시 재운다. 비율만 의미가 있으므로 화면은 그대로이고,
    // 나누고 합치기를 반복해도 값이 0 쪽으로 흘러가지 않는다.
    let sum: f32 = weights.iter().sum();
    if len > 0 && sum > 0.0 {
        let scale = len as f32 / sum;
        for w in weights.iter_mut() {
            *w = (*w * scale).max(MIN_TRACK_WEIGHT);
        }
    }
}

/// 하나의 창(블럭). `r/c/rs/cs` 는 `grid-area: r / c / span rs / span cs` 와 1:1 대응.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub id: String,
    pub kind: PaneKind,
    pub title: String,
    pub r: u32,
    pub c: u32,
    pub rs: u32,
    pub cs: u32,
    /// 폰트 px. 디자인 기준 14 = 100%, 범위 9~34.
    pub zoom: u32,

    /// 터미널 패널: 종료 시 기록해 둔 ANSI 직렬화 스크롤백.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scrollback: Option<String>,
    /// 터미널 패널: 셸 프로세스가 살아있는지 (런타임 전용, 스냅샷에는 남기지 않는다).
    #[serde(default, skip_serializing)]
    pub alive: bool,

    /// 터미널 패널: 셸이 OSC 9;9 로 알려 준 마지막 작업 폴더.
    /// 다음에 이 창을 열 때의 시작 위치가 된다. 세션 설정의 `cwd` 보다 우선한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 터미널 패널: 스냅샷을 찍을 때 이 창에서 돌고 있던 AI CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiKind>,

    /// 파일 패널: 원본 경로.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 파일 패널: md 는 원문 마크다운, text 는 리치 텍스트 HTML.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// md 패널 전용 뷰어/에디터 모드.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<MdMode>,
    /// 이미지 패널의 확대 배율(%). `None` 이면 창에 맞춤.
    /// 글자 크기인 `zoom` 과 뜻이 달라 따로 둔다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_zoom: Option<u32>,
    /// 저장되지 않은 편집이 있는지.
    #[serde(default)]
    pub dirty: bool,
}

impl Pane {
    pub fn empty(r: u32, c: u32, rs: u32, cs: u32) -> Self {
        Pane {
            id: uid("p"),
            kind: PaneKind::Empty,
            title: "빈 블럭".into(),
            r,
            c,
            rs,
            cs,
            zoom: 14,
            scrollback: None,
            alive: false,
            cwd: None,
            ai: None,
            path: None,
            content: None,
            mode: None,
            image_zoom: None,
            dirty: false,
        }
    }

    /// 좌표/크기는 그대로 두고 내용만 비운다 — 디자인의 "창 닫기 · 빈 블럭으로".
    pub fn cleared(&self) -> Self {
        Pane::empty(self.r, self.c, self.rs, self.cs)
    }

    pub fn area(&self) -> u32 {
        self.rs * self.cs
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub shell: Shell,
    /// 스폰 직후 stdin 으로 흘려보낼 시작 명령.
    #[serde(default)]
    pub start: String,
    /// `ssh` 셸일 때의 접속 대상. 비어 있으면 스폰하지 않는다.
    #[serde(default)]
    pub ssh_host: String,
    /// 사이드바 색상 dot 인덱스.
    #[serde(default)]
    pub color: usize,
    #[serde(default)]
    pub env: Vec<EnvVar>,
    pub grid: Grid,
    pub panes: Vec<Pane>,
    /// 지금 이 세션을 혼자 채우고 있는 창. `None` 이면 평소의 격자 배치.
    ///
    /// 창 하나만 세션 영역 가득 보여 주는 "전체화면" 상태다. 격자는 그대로 남아 있어서
    /// 창 모드로 돌아오면 배치가 그대로 살아난다. 뷰 모드지만 사이드바 접힘이나 마크다운
    /// 뷰어/에디터처럼 스냅샷에 남겨 다음 실행에서도 이어지게 한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_pane_id: Option<String>,
}

impl Session {
    /// 디자인의 `newSession()` — 1×1 그리드에 빈 블럭 하나로 시작.
    pub fn new(name: impl Into<String>, cwd: impl Into<String>, color: usize) -> Self {
        Session {
            id: uid("ses_"),
            name: name.into(),
            cwd: cwd.into(),
            shell: Shell::default(),
            start: String::new(),
            ssh_host: String::new(),
            color,
            env: Vec::new(),
            grid: Grid::default(),
            panes: vec![Pane::empty(1, 1, 1, 1)],
            full_pane_id: None,
        }
    }

    pub fn pane(&self, id: &str) -> Option<&Pane> {
        self.panes.iter().find(|p| p.id == id)
    }

    pub fn pane_mut(&mut self, id: &str) -> Option<&mut Pane> {
        self.panes.iter_mut().find(|p| p.id == id)
    }

    pub fn first_empty(&self) -> Option<&Pane> {
        self.panes.iter().find(|p| p.kind == PaneKind::Empty)
    }

    pub fn occupied_count(&self) -> usize {
        self.panes.iter().filter(|p| p.kind.is_occupied()).count()
    }
}

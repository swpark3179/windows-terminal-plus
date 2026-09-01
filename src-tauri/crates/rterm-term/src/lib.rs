//! rterm-term — Rust 측 터미널 코어.
//!
//! Windows Terminal 의 `TerminalCore`(VT 파서 + 셀 버퍼 + 스크롤백)에 해당하는 부분을
//! `alacritty_terminal` 위에 올렸다. PTY 에서 나온 바이트는 두 곳으로 간다:
//!
//! * 여기 — 그리드·스크롤백·검색·스냅샷 직렬화의 **단일 진실 공급원**
//! * 웹뷰의 xterm.js — 화면 렌더와 키 입력
//!
//! 중요: 이 코어는 **수동 미러**다. `Event::PtyWrite`(DA 응답 등)는 xterm.js 가 이미
//! 돌려주므로 여기서는 절대 PTY 로 되돌려 쓰지 않는다. 그랬다간 응답이 두 번 가서
//! 입력 스트림이 깨진다. 여기서 건지는 것은 창 제목뿐이다.

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor};

pub mod osc;
pub use osc::{OscScanner, ShellEvent};

/// 스냅샷에 남기는 기본 스크롤백 라인 수 — 디자인 문구 "8,192 라인".
pub const DEFAULT_SCROLLBACK: usize = 8192;

/// `Dimensions` 구현체. alacritty 는 크기를 트레이트로 받는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermSize {
    pub columns: usize,
    pub screen_lines: usize,
}

impl TermSize {
    pub fn new(columns: usize, screen_lines: usize) -> Self {
        TermSize {
            columns: columns.max(1),
            screen_lines: screen_lines.max(1),
        }
    }
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }
    fn screen_lines(&self) -> usize {
        self.screen_lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

/// 창 제목만 건져 올리는 이벤트 리스너. 나머지 이벤트는 의도적으로 버린다.
#[derive(Debug, Clone, Default)]
pub struct TitleSink(Arc<Mutex<Option<String>>>);

impl TitleSink {
    pub fn take(&self) -> Option<String> {
        self.0.lock().ok().and_then(|mut g| g.take())
    }
}

impl EventListener for TitleSink {
    fn send_event(&self, event: Event) {
        match event {
            Event::Title(t) => {
                if let Ok(mut g) = self.0.lock() {
                    *g = Some(t);
                }
            }
            Event::ResetTitle => {
                if let Ok(mut g) = self.0.lock() {
                    *g = None;
                }
            }
            // PtyWrite 는 xterm.js 가, OSC 52(ClipboardStore/Load) 는 웹뷰의 ClipboardAddon 이
            // 처리한다. 여기서 응답하면 중복이 된다.
            _ => {}
        }
    }
}

/// PTY 한 개에 대응하는 터미널 코어.
pub struct TermCore {
    term: Term<TitleSink>,
    parser: Processor,
    size: TermSize,
    titles: TitleSink,
    /// 셸 통합 마커 전용 스캐너. alacritty 파서가 버리는 OSC 7 · 9;9 를 여기서 건진다.
    osc: OscScanner,
    shell_events: Vec<ShellEvent>,
}

impl TermCore {
    pub fn new(columns: usize, screen_lines: usize, scrollback: usize) -> Self {
        let size = TermSize::new(columns, screen_lines);
        let config = Config {
            scrolling_history: scrollback,
            ..Config::default()
        };
        let titles = TitleSink::default();
        let term = Term::new(config, &size, titles.clone());
        TermCore {
            term,
            parser: Processor::new(),
            size,
            titles,
            osc: OscScanner::new(),
            shell_events: Vec::new(),
        }
    }

    /// PTY 바이트를 그리드에 반영한다.
    ///
    /// 같은 바이트를 셸 통합 스캐너에도 흘린다. 시그니처를 그대로 둔 덕에 호출부는 바뀌지 않는다.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        self.shell_events.extend(self.osc.feed(bytes));
    }

    /// 마지막으로 꺼내 간 뒤 쌓인 셸 통합 마커를 가져간다 (읽으면 비워진다).
    pub fn take_shell_events(&mut self) -> Vec<ShellEvent> {
        std::mem::take(&mut self.shell_events)
    }

    /// 셸이 OSC 로 설정한 창 제목을 한 번 꺼내 간다 (읽으면 비워진다).
    pub fn take_title(&self) -> Option<String> {
        self.titles.take()
    }

    pub fn size(&self) -> TermSize {
        self.size
    }

    pub fn resize(&mut self, columns: usize, screen_lines: usize) {
        let next = TermSize::new(columns, screen_lines);
        if next == self.size {
            return;
        }
        self.size = next;
        self.term.resize(next);
    }

    /// 스크롤백을 포함한 전체 버퍼를 서식 없는 줄 목록으로 돌려준다.
    pub fn plain_lines(&self) -> Vec<String> {
        let grid = self.term.grid();
        let mut out = Vec::new();
        for i in grid.topmost_line().0..=grid.bottommost_line().0 {
            let row = &grid[Line(i)];
            let mut line = String::new();
            for col in 0..grid.columns() {
                let cell = &row[Column(col)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                line.push(cell.c);
            }
            out.push(line.trim_end().to_string());
        }
        out
    }

    /// 스크롤백 검색. 매칭된 줄의 (버퍼 내 0-기반 인덱스, 줄 내용)을 돌려준다.
    /// 버퍼가 authoritative 이므로 xterm.js 가 이미 버린 오래된 줄도 찾을 수 있다.
    pub fn search(&self, needle: &str) -> Vec<(usize, String)> {
        if needle.is_empty() {
            return Vec::new();
        }
        self.plain_lines()
            .into_iter()
            .enumerate()
            .filter(|(_, line)| line.contains(needle))
            .collect()
    }

    /// 스크롤백을 ANSI 로 다시 인코딩한다. 복원 시 xterm.js 에 그대로 흘려 넣으면
    /// 색·굵기까지 살아난 채로 이전 화면이 되살아난다.
    pub fn serialize_scrollback(&self, max_lines: usize) -> String {
        let grid = self.term.grid();
        let top = grid.topmost_line().0;
        let bottom = grid.bottommost_line().0;

        // 뒤쪽 빈 줄은 버린다 — 복원 직후 셸이 새 프롬프트를 그리므로 공백만 남으면 지저분하다.
        let mut last = top - 1;
        for i in top..=bottom {
            let row = &grid[Line(i)];
            let has_content = (0..grid.columns()).any(|c| {
                let cell = &row[Column(c)];
                cell.c != ' ' && cell.c != '\0'
            });
            if has_content {
                last = i;
            }
        }
        if last < top {
            return String::new();
        }

        let first = if (last - top + 1) as usize > max_lines {
            last - max_lines as i32 + 1
        } else {
            top
        };

        let mut out = String::new();
        for i in first..=last {
            let row = &grid[Line(i)];
            // 줄 끝 공백은 잘라 낸다.
            let mut width = 0usize;
            for c in 0..grid.columns() {
                let cell = &row[Column(c)];
                if cell.c != ' ' && cell.c != '\0' {
                    width = c + 1;
                }
            }

            // 기본 서식으로 시작한다고 보면, 평범한 줄에는 SGR 을 한 글자도 넣지 않는다.
            let mut style = DEFAULT_STYLE;
            for c in 0..width {
                let cell = &row[Column(c)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                // WIDE_CHAR 처럼 서식과 무관한 플래그는 비교에서 뺀다.
                let want = (cell.fg, cell.bg, cell.flags & STYLE_MASK);
                if style != want {
                    out.push_str(&sgr_for(want.0, want.1, want.2));
                    style = want;
                }
                out.push(if cell.c == '\0' { ' ' } else { cell.c });
            }
            if style != DEFAULT_STYLE {
                out.push_str("\u{1b}[0m");
            }
            out.push_str("\r\n");
        }
        out
    }
}

/// 실제로 SGR 로 표현되는 플래그만 추린 마스크. WIDE_CHAR·WRAPLINE 등은 서식이 아니다.
const STYLE_MASK: Flags = Flags::BOLD
    .union(Flags::DIM)
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::INVERSE)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT);

/// 셀이 아무 서식도 갖지 않은 상태.
const DEFAULT_STYLE: (Color, Color, Flags) = (
    Color::Named(NamedColor::Foreground),
    Color::Named(NamedColor::Background),
    Flags::empty(),
);

/// 셀 하나의 속성을 통째로 다시 세우는 SGR 시퀀스. 항상 reset 으로 시작해 상태가 새지 않는다.
fn sgr_for(fg: Color, bg: Color, flags: Flags) -> String {
    let mut parts: Vec<String> = vec!["0".into()];

    if flags.contains(Flags::BOLD) {
        parts.push("1".into());
    }
    if flags.contains(Flags::DIM) {
        parts.push("2".into());
    }
    if flags.contains(Flags::ITALIC) {
        parts.push("3".into());
    }
    if flags.intersects(Flags::ALL_UNDERLINES) {
        parts.push("4".into());
    }
    if flags.contains(Flags::INVERSE) {
        parts.push("7".into());
    }
    if flags.contains(Flags::HIDDEN) {
        parts.push("8".into());
    }
    if flags.contains(Flags::STRIKEOUT) {
        parts.push("9".into());
    }

    if let Some(code) = color_code(fg, false) {
        parts.push(code);
    }
    if let Some(code) = color_code(bg, true) {
        parts.push(code);
    }

    format!("\u{1b}[{}m", parts.join(";"))
}

/// 색 하나를 SGR 파라미터로. 기본 색이면 `None`(reset 상태 그대로 둔다).
fn color_code(color: Color, background: bool) -> Option<String> {
    let base = if background { 40 } else { 30 };
    match color {
        Color::Named(NamedColor::Foreground) | Color::Named(NamedColor::Background) => None,
        Color::Named(named) => {
            let idx = named as usize;
            if idx < 8 {
                Some((base + idx).to_string())
            } else if idx < 16 {
                Some((base + 60 + (idx - 8)).to_string())
            } else {
                // Dim*/Bright* 같은 확장 이름은 256색 인덱스로 떨어뜨린다.
                Some(format!("{};5;{}", base + 8, (idx % 256) as u8))
            }
        }
        Color::Indexed(i) => Some(format!("{};5;{}", base + 8, i)),
        Color::Spec(rgb) => Some(format!("{};2;{};{};{}", base + 8, rgb.r, rgb.g, rgb.b)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core() -> TermCore {
        TermCore::new(20, 4, 100)
    }

    #[test]
    fn plain_text_reflects_written_bytes() {
        let mut t = core();
        t.feed(b"hello");
        let lines = t.plain_lines();
        assert_eq!(lines.last().map(String::as_str), Some(""));
        assert!(lines.iter().any(|l| l == "hello"), "lines = {lines:?}");
    }

    #[test]
    fn korean_wide_chars_survive_the_round_trip() {
        let mut t = core();
        t.feed("한글 터미널".as_bytes());
        assert!(
            t.plain_lines().iter().any(|l| l == "한글 터미널"),
            "wide char cells must not duplicate or drop"
        );
    }

    #[test]
    fn resize_reflows_without_losing_content() {
        let mut t = core();
        t.feed(b"abc");
        t.resize(40, 8);
        assert_eq!(t.size(), TermSize::new(40, 8));
        assert!(t.plain_lines().iter().any(|l| l.starts_with("abc")));
    }

    #[test]
    fn serialize_preserves_sgr_colour() {
        let mut t = core();
        // 초록 글자로 ok 를 찍는다.
        t.feed(b"\x1b[32mok\x1b[0m");
        let dump = t.serialize_scrollback(100);
        assert!(dump.contains("ok"), "dump = {dump:?}");
        assert!(dump.contains("32"), "초록 SGR 이 살아 있어야 한다: {dump:?}");
        assert!(dump.ends_with("\r\n"));
    }

    #[test]
    fn serialize_round_trips_back_into_a_fresh_core() {
        let mut a = core();
        a.feed(b"\x1b[31mred\x1b[0m plain");
        let dump = a.serialize_scrollback(100);

        let mut b = core();
        b.feed(dump.as_bytes());

        assert!(
            b.plain_lines().iter().any(|l| l == "red plain"),
            "재주입 결과 = {:?}",
            b.plain_lines()
        );
    }

    #[test]
    fn serialize_drops_trailing_blank_lines() {
        let mut t = core();
        t.feed(b"one\r\n");
        let dump = t.serialize_scrollback(100);
        assert_eq!(dump, "one\r\n", "빈 줄까지 끌고 오면 복원 화면이 지저분해진다");
    }

    #[test]
    fn serialize_honours_the_line_budget() {
        let mut t = TermCore::new(20, 2, 100);
        for i in 0..40 {
            t.feed(format!("line{i}\r\n").as_bytes());
        }
        let dump = t.serialize_scrollback(10);
        assert_eq!(dump.lines().count(), 10);
        assert!(dump.contains("line39"), "최근 줄이 남아야 한다: {dump:?}");
        assert!(!dump.contains("line10"), "오래된 줄은 잘려야 한다");
    }

    #[test]
    fn scrollback_beyond_capacity_is_discarded() {
        let mut t = TermCore::new(20, 2, 10);
        for i in 0..60 {
            t.feed(format!("l{i}\r\n").as_bytes());
        }
        // 스크롤백 10 + 화면 2 를 크게 넘지 않아야 한다.
        assert!(t.plain_lines().len() <= 14, "len = {}", t.plain_lines().len());
    }

    #[test]
    fn search_finds_lines_in_scrollback() {
        let mut t = TermCore::new(20, 2, 100);
        for i in 0..30 {
            t.feed(format!("row{i}\r\n").as_bytes());
        }
        let hits = t.search("row7");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].1, "row7");
        assert!(t.search("없는문자열").is_empty());
    }

    #[test]
    fn osc_title_is_captured_once() {
        let mut t = core();
        t.feed(b"\x1b]0;my title\x07");
        assert_eq!(t.take_title().as_deref(), Some("my title"));
        assert_eq!(t.take_title(), None, "읽고 나면 비워진다");
    }

    #[test]
    fn shell_events_are_drained_once() {
        let mut t = core();
        t.feed(b"\x1b]9;9;C:\\work\x07prompt> ");
        assert_eq!(
            t.take_shell_events(),
            vec![ShellEvent::Cwd("C:\\work".into())]
        );
        assert!(t.take_shell_events().is_empty(), "읽고 나면 비워진다");
    }

    #[test]
    fn osc_52_is_ignored_by_the_mirror() {
        // 클립보드는 웹뷰가 다룬다. 코어는 조용히 넘기고 화면만 그대로 남겨야 한다.
        let mut t = core();
        t.feed(b"\x1b]52;c;aGk=\x07hello");
        assert!(t.take_shell_events().is_empty());
        assert!(t.plain_lines().iter().any(|l| l.contains("hello")));
    }

    #[test]
    fn serialize_scrollback_never_emits_osc() {
        // 복원 때 스크롤백을 다시 먹이므로, 여기서 OSC 가 새어 나오면 화면에 찍힌 글자가
        // 가짜 작업 폴더를 만들어 낼 수 있다. 직렬화는 SGR 과 글자만 내보내야 한다.
        let mut t = core();
        t.feed(b"\x1b]9;9;C:\\evil\x07");
        t.feed("사용자가 친 글자 \u{1b}]9;9;C:\\also-evil\u{7}".as_bytes());
        let dump = t.serialize_scrollback(100);
        assert!(!dump.contains("]9;9;"), "직렬화에 OSC 가 들어갔다: {dump:?}");

        let mut fresh = core();
        fresh.feed(dump.as_bytes());
        assert!(fresh.take_shell_events().is_empty());
    }
}

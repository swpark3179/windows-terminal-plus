//! 셸 통합 마커(OSC)만 골라 내는 스캐너.
//!
//! `alacritty_terminal` 의 `EventListener` 로는 창 제목(OSC 0/2)밖에 올라오지 않는다.
//! 작업 폴더를 알려 주는 OSC 7 · OSC 9;9 는 파서 안에서 조용히 버려지므로, 같은 바이트를
//! 한 번 더 훑어 여기서 건진다. `TermCore::feed` 가 이미 모든 바이트를 받으니 배선은 그것뿐이다.
//!
//! 윈도우에서는 남의 프로세스 작업 폴더를 밖에서 읽을 수 없다. 윈도우 터미널이 그러듯
//! **셸이 프롬프트마다 스스로 알려 주게** 하는 것이 유일한 길이다.

/// 셸이 프롬프트마다 알려 주는 것.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEvent {
    /// `OSC 9;9;<path> ST` 또는 `OSC 7;file://<host>/<path> ST`.
    Cwd(String),
}

/// OSC 페이로드 상한. 넘으면 통째로 버린다.
///
/// OSC 52(클립보드)는 base64 덩어리가 얼마든지 커질 수 있다. 우리가 쓰지도 않을 것을
/// 모으느라 메모리를 내주면 안 된다.
const MAX_OSC: usize = 4096;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    /// `ESC` 를 봤다.
    Esc,
    /// `ESC ]` 를 봤다 — 페이로드를 모으는 중.
    Osc,
    /// 페이로드 안에서 `ESC` 를 봤다. 다음이 `\` 면 종결(ST)이다.
    OscEsc,
}

/// PTY 바이트 흐름에서 OSC 만 건져 내는 상태 기계.
///
/// 읽기 덩어리 경계에 시퀀스가 잘려 들어와도 상태가 남아 이어 붙는다.
#[derive(Debug, Default)]
pub struct OscScanner {
    state: State,
    buf: Vec<u8>,
}

impl OscScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// 덩어리 하나를 먹이고 이번에 완성된 마커들을 돌려준다.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ShellEvent> {
        let mut out = Vec::new();
        for &b in bytes {
            match self.state {
                State::Ground => {
                    if b == 0x1b {
                        self.state = State::Esc;
                    }
                }
                State::Esc => {
                    self.state = if b == b']' {
                        self.buf.clear();
                        State::Osc
                    } else if b == 0x1b {
                        // 연달아 온 ESC — 방금 것은 버리고 이것을 시작으로 본다.
                        State::Esc
                    } else {
                        State::Ground
                    };
                }
                State::Osc => match b {
                    // BEL 종결.
                    0x07 => {
                        self.finish(&mut out);
                    }
                    // 8비트 ST.
                    0x9c => {
                        self.finish(&mut out);
                    }
                    0x1b => self.state = State::OscEsc,
                    _ => {
                        if self.buf.len() >= MAX_OSC {
                            // 상한을 넘긴 페이로드는 되살릴 방법이 없다. 버리고 처음으로.
                            self.reset();
                        } else {
                            self.buf.push(b);
                        }
                    }
                },
                State::OscEsc => {
                    if b == b'\\' {
                        // `ESC \` = ST 종결.
                        self.finish(&mut out);
                    } else if b == 0x1b {
                        self.state = State::Esc;
                        self.buf.clear();
                    } else {
                        // OSC 안의 ESC 가 종결이 아니었다 — 이 시퀀스는 우리 것이 아니다.
                        self.reset();
                    }
                }
            }
        }
        out
    }

    fn finish(&mut self, out: &mut Vec<ShellEvent>) {
        if let Some(ev) = parse(&self.buf) {
            out.push(ev);
        }
        self.reset();
    }

    fn reset(&mut self) {
        self.state = State::Ground;
        self.buf.clear();
    }
}

/// 모은 페이로드에서 마커를 읽어 낸다. 우리 것이 아니면 `None`.
fn parse(payload: &[u8]) -> Option<ShellEvent> {
    let text = std::str::from_utf8(payload).ok()?;
    if let Some(rest) = text.strip_prefix("9;9;") {
        return sanitize(rest.trim_matches('"')).map(ShellEvent::Cwd);
    }
    if let Some(rest) = text.strip_prefix("7;") {
        return sanitize(&from_file_url(rest)?).map(ShellEvent::Cwd);
    }
    None
}

/// `file://host/C:/work` → `C:/work`, `file:///home/u` → `/home/u`.
fn from_file_url(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("file://")?;
    // 호스트 부분은 쓰지 않는다 (원격 경로를 우리 쪽에서 열 수는 없다).
    let path = match rest.find('/') {
        Some(i) => &rest[i..],
        None => return None,
    };
    let decoded = percent_decode(path)?;
    // 윈도우 경로는 `/C:/...` 꼴로 온다. 앞 슬래시를 떼야 실제 경로가 된다.
    let bytes = decoded.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        return Some(decoded[1..].to_string());
    }
    Some(decoded)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = *bytes.get(i + 1)?;
            let lo = *bytes.get(i + 2)?;
            let v = (hex(hi)? << 4) | hex(lo)?;
            out.push(v);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 경로로 받아들일 만한 값인지 본다.
///
/// **이 값은 공격자가 찍을 수 있다** — `cat evil.bin` 한 번이면 아무 OSC 나 흘러나온다.
/// 실제로 쓰이는 곳은 `CommandBuilder::cwd()` 의 단일 인자뿐이라 셸 명령줄에 섞이지 않지만,
/// 제어문자가 든 경로를 스냅샷에 남겨 두면 나중에 어디선가 새어 나온다. 여기서 막는다.
fn sanitize(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_OSC {
        return None;
    }
    if trimmed.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(chunks: &[&[u8]]) -> Vec<ShellEvent> {
        let mut s = OscScanner::new();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(s.feed(c));
        }
        out
    }

    #[test]
    fn osc_9_9_reports_the_working_directory() {
        assert_eq!(
            scan(&[b"\x1b]9;9;C:\\work\\rterm\x1b\\"]),
            vec![ShellEvent::Cwd("C:\\work\\rterm".into())]
        );
    }

    #[test]
    fn bel_also_terminates() {
        assert_eq!(
            scan(&[b"\x1b]9;9;/home/u\x07"]),
            vec![ShellEvent::Cwd("/home/u".into())]
        );
    }

    #[test]
    fn quotes_around_the_path_are_stripped() {
        assert_eq!(
            scan(&[b"\x1b]9;9;\"C:\\my dir\"\x07"]),
            vec![ShellEvent::Cwd("C:\\my dir".into())]
        );
    }

    #[test]
    fn a_sequence_split_across_chunks_is_still_parsed() {
        // 읽기 스레드는 8 KiB 씩 퍼 올리므로 시퀀스가 덩어리 경계에서 잘리는 일이 실제로 있다.
        let got = scan(&[b"\x1b]9;", b"9;C:\\wo", b"rk\x1b", b"\\"]);
        assert_eq!(got, vec![ShellEvent::Cwd("C:\\work".into())]);
    }

    #[test]
    fn osc_7_file_url_is_decoded() {
        assert_eq!(
            scan(&[b"\x1b]7;file://host/C:/work/my%20dir\x1b\\"]),
            vec![ShellEvent::Cwd("C:/work/my dir".into())]
        );
        assert_eq!(
            scan(&[b"\x1b]7;file:///home/u/%ED%95%9C\x07"]),
            vec![ShellEvent::Cwd("/home/u/한".into())]
        );
    }

    #[test]
    fn plain_output_and_other_osc_produce_nothing() {
        assert!(scan(&[b"hello \x1b[32mworld\x1b[0m\r\n"]).is_empty());
        // 창 제목(OSC 0/2)과 클립보드(OSC 52)는 우리 것이 아니다.
        assert!(scan(&[b"\x1b]0;pwsh\x07\x1b]52;c;aGk=\x07"]).is_empty());
    }

    #[test]
    fn a_control_char_in_the_path_is_rejected() {
        assert!(scan(&[b"\x1b]9;9;C:\\a\rrm -rf\x07"]).is_empty());
    }

    #[test]
    fn an_unterminated_osc_does_not_grow_without_bound() {
        let mut s = OscScanner::new();
        s.feed(b"\x1b]9;9;");
        for _ in 0..64 {
            s.feed(&vec![b'x'; 1024]);
            assert!(s.buf.len() <= MAX_OSC, "버퍼가 상한을 넘었다");
        }
        // 상한을 넘겨 버린 뒤에도 다음 정상 시퀀스는 그대로 읽힌다.
        assert_eq!(
            s.feed(b"\x1b]9;9;/tmp\x07"),
            vec![ShellEvent::Cwd("/tmp".into())]
        );
    }
}

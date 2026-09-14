//! 터미널이 서 있는 폴더를 파일 탐색기로 연다 (창 메뉴의 `탐색기로 열기`).
//!
//! **폴더 문자열은 화면 속 프로그램이 정할 수 있다.** 창별 작업 폴더는 셸이 프롬프트마다
//! `OSC 9;9;<경로>` 로 스스로 알린 값인데(`셸 통합`), 그 바이트를 찍을 수 있는 것은 셸만이
//! 아니다 — `cat evil.bin` 한 번이면 아무 경로나 실린다. 그래서 하이퍼링크를 열 때와 같은
//! 자세로 막는다(`commands/link.rs`).
//!
//! 1. **폴더만** 넘긴다. `explorer.exe <파일>` 은 그 파일을 기본 처리기로 여는 것이라
//!    `.exe`·`.lnk` 하나면 그대로 실행이다. `/select,…` 같은 탐색기 스위치도 폴더가 아니라
//!    여기서 함께 걸린다.
//! 2. **네트워크 경로(UNC)는 열지 않는다.** `\\evil.tld\share` 는 윈도우가 그 호스트에 붙으며
//!    NTLM 을 흘린다. 파일 시스템을 만지기 **전에** 걸러야 한다 — 존재 확인만으로도 붙으러 간다.
//! 3. 셸을 거치지 않는다. `explorer.exe` 에 평범한 argv 하나로 넘긴다 (`cmd /C start` 는 인자
//!    규칙이 달라 표준 라이브러리의 이스케이프가 통하지 않는다).

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

/// 경로 길이 상한. 윈도우의 긴 경로(32k)를 다 받아 줄 이유가 없다.
const MAX_PATH: usize = 1024;

/// 연 폴더를 어디서 알아냈는지. 화면에 무엇이라고 알릴지가 이것으로 갈린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CwdSource {
    /// 셸이 지금 알려 주고 있는 폴더. 이것이 곧 그 터미널의 `pwd` 다.
    Live,
    /// 셸 통합이 없거나 셸이 끝나서, 창에 마지막으로 적힌 폴더로 물러난 것.
    Last,
    /// 그것마저 없어 세션 설정의 폴더로 물러난 것.
    Session,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revealed {
    /// 실제로 연 폴더.
    pub path: String,
    pub source: CwdSource,
}

/// 탐색기에 넘겨도 되는 폴더인지 본다. 통과하면 다듬은 경로, 아니면 사용자에게 보일 사유.
///
/// 순수 함수라 프로세스를 띄우지 않고 표로 검증할 수 있다.
pub fn validate(raw: &str) -> Result<&str, String> {
    let path = raw.trim();
    if path.is_empty() {
        return Err("이 창의 폴더를 알 수 없습니다".into());
    }
    if path.len() > MAX_PATH {
        return Err("경로가 너무 깁니다".into());
    }
    // 제어문자와 눈에 보이지 않는 방향 전환 문자. 앞의 것은 명령줄을 자르고, 뒤의 것은
    // 토스트에 뜨는 경로를 거꾸로 보이게 한다 (`lib/termText.ts` 와 같은 이유).
    if path.chars().any(|c| {
        c.is_control()
            || matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    }) {
        return Err("경로에 쓸 수 없는 문자가 있습니다".into());
    }
    if path.contains('"') {
        return Err("경로에 쓸 수 없는 문자가 있습니다".into());
    }
    // 네트워크 경로. **파일 시스템을 만지기 전에** 걸러야 한다 — `is_dir()` 만으로도
    // 윈도우가 그 호스트에 붙으러 가서 인증 정보를 흘린다.
    if path.starts_with("\\\\") || path.starts_with("//") {
        return Err("네트워크 경로는 열지 않습니다".into());
    }

    let p = Path::new(path);
    // 상대 경로는 무엇을 기준으로 하는지가 앱의 작업 폴더에 달려 있어 뜻이 흔들린다.
    // 윈도우에서는 WSL 쪽 경로(`/home/…`)도 여기서 걸린다 — 드라이브가 없어 절대 경로가 아니다.
    if !p.is_absolute() {
        return Err("이 셸의 폴더는 탐색기로 열 수 없습니다".into());
    }
    // 폴더만. 파일을 넘기면 탐색기가 그 파일을 **실행**한다.
    if !p.is_dir() {
        return Err("폴더를 찾을 수 없습니다".into());
    }
    Ok(path)
}

/// 이 창의 폴더 후보를 아는 순서대로. 앞에서부터 열 수 있는 것을 쓴다.
///
/// 스냅샷의 `pane.cwd` 는 명령이 오갈 때만 갱신돼 그 사이의 `cd` 를 놓치므로, 셸이 지금
/// 알려 주고 있는 값(`live_cwd`)을 먼저 본다 — 나눈 자리의 터미널이 폴더를 물려받을 때와
/// 같은 판정이다(`commands/layout.rs` 의 `pane_open_terminal`).
fn candidates(state: &AppState, pane_id: &str) -> Vec<(CwdSource, String)> {
    let mut out = Vec::new();
    if let Some(cwd) = state.live_cwd(pane_id) {
        out.push((CwdSource::Live, cwd));
    }
    let snap = state.snapshot.lock();
    if let Some(session) = snap.sessions.iter().find(|s| s.pane(pane_id).is_some()) {
        if let Some(cwd) = session.pane(pane_id).and_then(|p| p.cwd.clone()) {
            out.push((CwdSource::Last, cwd));
        }
        out.push((CwdSource::Session, session.cwd.clone()));
    }
    out
}

/// 이 터미널이 서 있는 폴더를 파일 탐색기로 연다.
///
/// 앞선 후보를 열 수 없으면(WSL 쪽 경로였다, 그새 지워졌다…) 다음 후보로 물러난다.
/// 어디를 열었는지는 돌려주는 `source` 로 알 수 있고, 화면은 그대로 토스트에 적어 준다.
#[tauri::command]
pub fn pane_reveal_cwd(state: State<'_, AppState>, pane_id: String) -> Result<Revealed, String> {
    let mut refused: Option<String> = None;
    for (source, dir) in candidates(&state, &pane_id) {
        match validate(&dir) {
            Ok(dir) => {
                open_folder(dir)?;
                return Ok(Revealed { path: dir.to_string(), source });
            }
            Err(e) => refused = Some(e),
        }
    }
    Err(refused.unwrap_or_else(|| "이 창의 폴더를 알 수 없습니다".to_string()))
}

/// 폴더 하나를 OS 의 파일 관리자로 연다.
fn open_folder(dir: &str) -> Result<(), String> {
    // explorer.exe 는 성공해도 0 이 아닌 코드를 돌려주는 일이 있어 종료 코드는 보지 않는다
    // (`commands/link.rs` 와 같다). 띄우는 데 실패한 것만 사용자에게 알린다.
    let spawned = if cfg!(windows) {
        Command::new("explorer.exe").arg(dir).spawn()
    } else {
        // 개발용 — 리눅스·맥에서 `pnpm tauri dev` 로 돌릴 때.
        Command::new("xdg-open").arg(dir).spawn()
    };

    spawned
        .map(|_| ())
        .map_err(|e| format!("탐색기를 열 수 없습니다: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 이 테스트만 쓰는 임시 폴더. 이름이 겹치지 않게 호출부가 꼬리표를 준다.
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rterm-reveal-{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_existing_folder_passes() {
        let dir = temp_dir("ok");
        let path = dir.to_string_lossy().to_string();
        assert_eq!(validate(&path), Ok(path.as_str()));
        // 앞뒤 공백은 다듬는다.
        let padded = format!("  {path}  ");
        assert_eq!(validate(&padded), Ok(path.as_str()));
    }

    #[test]
    fn a_file_is_refused() {
        // `explorer.exe <파일>` 은 그 파일을 기본 처리기로 여는 것이다 — `.exe` 하나면 실행이다.
        let file = temp_dir("file").join("note.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate(&file.to_string_lossy()).is_err());
    }

    #[test]
    fn a_missing_folder_is_refused() {
        let gone = temp_dir("gone").join("사라진-폴더");
        assert!(validate(&gone.to_string_lossy()).is_err());
    }

    #[test]
    fn network_paths_are_refused() {
        // 존재 확인만으로도 그 호스트에 붙으러 간다 — 그래서 파일 시스템보다 먼저 본다.
        assert!(validate("\\\\evil.tld\\share").is_err());
        assert!(validate("//evil.tld/share").is_err());
    }

    #[test]
    fn switches_and_relative_paths_are_refused() {
        // 탐색기 스위치. 폴더가 아니므로 여기서 걸린다.
        assert!(validate("/select,C:\\Windows\\System32\\calc.exe").is_err());
        assert!(validate("shell:startup").is_err());
        // 기준이 앱의 작업 폴더에 달린 경로.
        assert!(validate("src").is_err());
        assert!(validate(".").is_err());
        assert!(validate("").is_err());
        assert!(validate("   ").is_err());
    }

    #[test]
    fn control_characters_and_bidi_overrides_are_refused() {
        let dir = temp_dir("odd");
        let path = dir.to_string_lossy().to_string();
        // 줄바꿈을 끼워 명령줄을 끊으려는 시도. (끝에 붙은 공백은 그냥 다듬어 낸다.)
        assert!(validate(&format!("{path}\r\nX")).is_err());
        assert!(validate(&format!("{path}\u{0}")).is_err());
        assert!(validate(&format!("{path}\u{202e}")).is_err());
        assert!(validate(&format!("{path}\"")).is_err());
    }

    #[test]
    fn an_absurdly_long_path_is_refused() {
        let long = format!("C:\\{}", "a".repeat(MAX_PATH));
        assert!(validate(&long).is_err());
    }
}

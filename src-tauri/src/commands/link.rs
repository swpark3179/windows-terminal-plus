//! 터미널이 그린 하이퍼링크를 바깥 브라우저로 넘긴다.
//!
//! **터미널 출력은 공격자가 정할 수 있다.** `cat evil.bin` 한 번이면 아무 OSC 8 하이퍼링크나
//! 흘러나오고, 화면에 보이는 글자와 실제 주소가 다를 수도 있다(OSC 8 은 둘을 따로 싣는다).
//! 그래서 두 겹으로 막는다.
//!
//! 1. 화면 쪽 — Ctrl 을 누른 채 클릭해야 열리고, 마우스를 올리면 **실제 주소**를 띄운다.
//! 2. 여기 — `http`·`https` 만 통과시킨다. 그 밖의 스킴은 윈도우의 임의 처리기로 이어진다
//!    (`ms-msdt:` · `search-ms:` · `shell:` · `file:` · UNC 경로는 NTLM 을 흘린다).
//!
//! 셸을 거치지 않는 것도 중요하다. `cmd /C start` 는 인자 규칙이 달라 표준 라이브러리의
//! 이스케이프가 통하지 않고, `start` 는 따옴표로 감싼 첫 토큰을 창 제목으로 읽는다.
//! `explorer.exe <url>` 은 평범한 argv 하나로 기본 브라우저를 띄운다.

use std::process::Command;

/// 주소 길이 상한. 이보다 긴 것은 링크가 아니라 붙여넣기 사고다.
const MAX_URL: usize = 2048;

/// 열어 줄 만한 주소인지 본다. 통과하면 그대로, 아니면 사용자에게 보일 사유를 돌려준다.
///
/// 순수 함수라 프로세스를 띄우지 않고 표로 검증할 수 있다.
pub fn validate(raw: &str) -> Result<&str, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("주소가 비어 있습니다".into());
    }
    if url.len() > MAX_URL {
        return Err("주소가 너무 깁니다".into());
    }
    // 한 덩어리의 평범한 ASCII 토큰만 받는다 — 공백·따옴표·제어문자가 끼면 명령줄에서
    // 어디까지가 주소인지 모호해진다. 한글 도메인 등은 브라우저 대신 셸이 퍼센트 인코딩해 준다.
    if url.chars().any(|c| !c.is_ascii() || c.is_ascii_control() || c.is_ascii_whitespace()) {
        return Err("주소에 쓸 수 없는 문자가 있습니다".into());
    }
    if url.contains('"') || url.contains('\'') || url.contains('`') || url.contains('\\') {
        return Err("주소에 쓸 수 없는 문자가 있습니다".into());
    }

    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(|| "http · https 주소만 열 수 있습니다".to_string())?;

    // 호스트만 따로 본다. `@` 가 있으면 `https://github.com@evil.tld` 처럼 눈속임이 된다.
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return Err("주소에 호스트가 없습니다".into());
    }
    if host.contains('@') {
        return Err("사용자 정보가 붙은 주소는 열지 않습니다".into());
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return Err("호스트에 쓸 수 없는 문자가 있습니다".into());
    }

    Ok(url)
}

/// OS 기본 브라우저로 주소를 연다.
#[tauri::command]
pub fn link_open(url: String) -> Result<(), String> {
    let url = validate(&url)?;

    // explorer.exe 는 성공해도 0 이 아닌 코드를 돌려주는 일이 있어 종료 코드는 보지 않는다.
    // 띄우는 데 실패한 것(파일 없음 등)만 사용자에게 알린다.
    let spawned = if cfg!(windows) {
        Command::new("explorer.exe").arg(url).spawn()
    } else {
        // 개발용 — 리눅스·맥에서 `pnpm tauri dev` 로 돌릴 때.
        Command::new("xdg-open").arg(url).spawn()
    };

    spawned
        .map(|_| ())
        .map_err(|e| format!("브라우저를 열 수 없습니다: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_http_and_https_pass() {
        assert_eq!(validate("https://github.com/anthropics"), Ok("https://github.com/anthropics"));
        assert_eq!(validate("http://localhost:1420/x?a=1&b=2#c"), Ok("http://localhost:1420/x?a=1&b=2#c"));
        // 대소문자가 섞인 스킴도 같은 스킴이다.
        assert!(validate("HTTPS://example.com").is_ok());
        // 앞뒤 공백은 다듬는다.
        assert_eq!(validate("  https://example.com  "), Ok("https://example.com"));
    }

    #[test]
    fn other_schemes_are_refused() {
        // 이들은 모두 윈도우의 임의 처리기로 이어진다.
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "ms-msdt:/id PCWDiagnostic",
            "search-ms:query=x",
            "shell:startup",
            "javascript:alert(1)",
            "data:text/html,<script>",
            "vscode://x",
            "//evil.tld/share",
            "\\\\evil.tld\\share",
            "example.com",
        ] {
            assert!(validate(url).is_err(), "{url} 은 막아야 한다");
        }
    }

    #[test]
    fn user_info_in_the_authority_is_refused() {
        // 보이는 것은 github.com 인데 실제로는 evil.tld 로 간다.
        assert!(validate("https://github.com@evil.tld/").is_err());
        assert!(validate("https://user:pw@evil.tld/").is_err());
    }

    #[test]
    fn a_missing_or_odd_host_is_refused() {
        assert!(validate("https://").is_err());
        assert!(validate("https:///path").is_err());
        assert!(validate("https://ex ample.com").is_err());
        assert!(validate("https://exa\"mple.com").is_err());
    }

    #[test]
    fn control_characters_and_newlines_are_refused() {
        assert!(validate("https://example.com/\r\nX").is_err());
        assert!(validate("https://example.com/\u{0}").is_err());
        // 눈에 보이지 않는 방향 전환 문자로 주소를 뒤집는 수법도 여기서 걸린다 (ASCII 가 아니다).
        assert!(validate("https://example.com/\u{202e}gnp.exe").is_err());
    }

    #[test]
    fn an_absurdly_long_url_is_refused() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL));
        assert!(validate(&long).is_err());
    }

    #[test]
    fn ipv6_and_ports_are_allowed() {
        assert!(validate("http://[::1]:8080/").is_ok());
        assert!(validate("https://127.0.0.1:443").is_ok());
    }
}

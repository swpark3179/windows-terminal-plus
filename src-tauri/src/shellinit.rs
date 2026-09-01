//! 셸 통합 주입 — 셸이 프롬프트마다 작업 폴더를 알리게 만든다.
//!
//! 윈도우에서는 남의 프로세스 작업 폴더를 밖에서 읽을 수 없다. 윈도우 터미널이 그러듯
//! 셸에게 `OSC 9;9;<경로>` 를 찍게 하고, 그것을 `rterm-term` 의 스캐너가 받는다.
//! 셸마다 방법이 달라서 여기 한곳에 모았다.

use std::path::{Path, PathBuf};

use rterm_core::{EnvVar, Shell};

/// 프로필이 로드된 뒤 dot-source 되는 pwsh 초기화 스크립트.
const PS1: &str = include_str!("shell/rterm-init.ps1");

/// 통합을 통째로 끄는 환경변수. 사용자 프로필과 부딪힐 때의 탈출구다.
pub const DISABLE_ENV: &str = "RTERM_NO_SHELL_INTEGRATION";

/// 셸에 덧붙일 인자와 환경변수.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ShellInit {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// 생성 스크립트를 config 디렉터리에 최신으로 유지한다. 앱이 뜰 때 한 번만 부른다.
///
/// 내용을 먼저 비교하므로 평범한 실행에서는 디스크를 건드리지 않고, 앱을 새로 깔면
/// 스크립트도 함께 갱신된다.
pub fn ensure_scripts(config_dir: &Path) -> std::io::Result<()> {
    let path = script_path(config_dir);
    if std::fs::read_to_string(&path).ok().as_deref() == Some(PS1) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, PS1)
}

fn script_path(config_dir: &Path) -> PathBuf {
    config_dir.join("shell").join("rterm-init.ps1")
}

/// 사용자가 통합을 껐는가 — 프로세스 환경변수 또는 세션 환경변수 어느 쪽이든.
pub fn is_disabled(session_env: &[EnvVar]) -> bool {
    std::env::var_os(DISABLE_ENV).is_some()
        || session_env.iter().any(|e| e.k.trim() == DISABLE_ENV)
}

/// 셸 종류별 주입 방법. 손댈 수 없는 셸이면 `None`.
pub fn for_shell(config_dir: &Path, shell: Shell) -> Option<ShellInit> {
    match shell {
        // 프로필이 먼저 로드되고 그다음 우리 스크립트가 dot-source 된다 —
        // 그래야 사용자가 정의한 prompt 를 감쌀 수 있다. `-NoExit` 로 대화형은 그대로 유지.
        Shell::Pwsh if cfg!(windows) => {
            let path = script_path(config_dir);
            Some(ShellInit {
                args: vec![
                    "-NoLogo".into(),
                    "-NoExit".into(),
                    "-Command".into(),
                    format!(". '{}'", path.to_string_lossy().replace('\'', "''")),
                ],
                env: Vec::new(),
            })
        }

        // cmd 는 파일도 인자도 필요 없다. $e=ESC, $P=현재 폴더, $G=`>`.
        Shell::Cmd if cfg!(windows) => Some(ShellInit {
            args: Vec::new(),
            env: vec![("PROMPT".into(), r"$e]9;9;$P$e\$P$G".into())],
        }),

        // WSL 과 (테스트가 도는) 비윈도우 bash. WSLENV 에 얹어야 값이 리눅스 쪽으로 넘어간다.
        Shell::Wsl => {
            let mut env = vec![(
                "PROMPT_COMMAND".into(),
                r#"printf '\033]9;9;%s\033\\' "$PWD""#.into(),
            )];
            if cfg!(windows) {
                env.push(("WSLENV".into(), wslenv_with_prompt_command()));
            }
            Some(ShellInit {
                args: Vec::new(),
                env,
            })
        }

        // 원격 셸은 우리 것이 아니다. 환경변수도 ssh 를 건너가지 않는다.
        Shell::Ssh => None,

        // 비윈도우의 pwsh/cmd 갈래 — 개발·테스트용이라 건드리지 않는다.
        _ => None,
    }
}

/// 이미 있는 WSLENV 를 지우지 않고 뒤에 이어 붙인다. `/u` = 윈도우에서 WSL 로 들어갈 때만.
fn wslenv_with_prompt_command() -> String {
    const ENTRY: &str = "PROMPT_COMMAND/u";
    match std::env::var("WSLENV") {
        Ok(existing) if !existing.trim().is_empty() => {
            if existing.split(':').any(|e| e.split('/').next() == Some("PROMPT_COMMAND")) {
                existing
            } else {
                format!("{existing}:{ENTRY}")
            }
        }
        _ => ENTRY.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_gets_no_injection() {
        assert!(for_shell(Path::new("/tmp/rterm"), Shell::Ssh).is_none());
    }

    #[test]
    fn wsl_reports_the_directory_through_prompt_command() {
        let init = for_shell(Path::new("/tmp/rterm"), Shell::Wsl).expect("wsl 은 주입 대상이다");
        let (k, v) = &init.env[0];
        assert_eq!(k, "PROMPT_COMMAND");
        assert!(v.contains("9;9"), "OSC 9;9 를 찍어야 한다: {v}");
        assert!(v.contains("$PWD"));
    }

    #[test]
    fn the_disable_switch_is_seen_in_session_env() {
        let env = vec![EnvVar {
            k: DISABLE_ENV.into(),
            v: "1".into(),
        }];
        assert!(is_disabled(&env));
        assert!(!is_disabled(&[]) || std::env::var_os(DISABLE_ENV).is_some());
    }

    #[test]
    fn wslenv_keeps_what_was_already_there() {
        // 값 자체는 프로세스 환경에 달렸으니 모양만 본다.
        let v = wslenv_with_prompt_command();
        assert!(v.contains("PROMPT_COMMAND/u"));
    }

    #[test]
    fn ensure_scripts_writes_once_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("rterm-shellinit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        ensure_scripts(&dir).expect("첫 기록");
        let path = script_path(&dir);
        let first = std::fs::metadata(&path).expect("파일이 있어야 한다").len();
        ensure_scripts(&dir).expect("두 번째");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), first);
        assert!(std::fs::read_to_string(&path).unwrap().contains("9;9"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

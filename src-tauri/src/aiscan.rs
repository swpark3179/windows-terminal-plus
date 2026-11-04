//! 창마다 지금 어떤 AI CLI 가 돌고 있는지 알아낸다.
//!
//! 셸 pid 의 자손을 훑는다. 사용자가 `claude` 를 어떻게 띄웠는지 — 직접 쳤든, ↑ 로 불러왔든,
//! 탭 완성으로 채웠든, 스크립트가 실행했든 — 상관없이 같은 답이 나온다.
//!
//! 훑기는 **스냅샷을 저장할 때만** 한다(2분 주기 · 종료 직전). 알아야 하는 것은
//! "스냅샷을 찍는 순간 돌고 있었는가" 뿐이라 따로 폴링할 이유가 없다.
//!
//! 한계: WSL 안에서 띄운 프로그램은 가상머신 안에 있어 보이지 않고, ssh 는 아예 남의 기계다.
//! 그 두 셸에서는 폴더만 복원되고 AI 는 복원되지 않는다.

use std::collections::HashMap;

use std::path::Path;

use rterm_core::AiKind;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// 실행 파일 이름 하나를 우리가 찾는 AI 로 읽는다. 경로·확장자·대소문자는 상관없다.
///
/// 윈도우의 프로세스 이름은 **확장자까지** 붙어 온다(`claude.exe`). 예전에는 그것을 `"claude"` 와
/// 곧바로 비교해서 네이티브로 설치한 claude 가 한 번도 잡히지 않았다 — 그래서 복원 때 이어붙이기가
/// 나가지 않고 셸 프롬프트만 남았다.
fn program_kind(name: &str) -> Option<AiKind> {
    let leaf = name.trim().rsplit(['/', '\\']).next().unwrap_or("");
    let stem = Path::new(leaf)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match stem.as_str() {
        "claude" => Some(AiKind::Claude),
        "codex" => Some(AiKind::Codex),
        _ => None,
    }
}

/// 프로세스 하나가 우리가 찾는 AI 인지 본다.
///
/// 윈도우의 `claude` 는 네이티브 `claude.exe` 일 수도, npm 설치라
/// `node.exe …\@anthropic-ai\claude-code\cli.js` 일 수도 있다. 그래서 실행 파일 이름과
/// 명령줄을 함께 본다. `codex` 는 네이티브 실행 파일이다.
///
/// `exe_name` 은 실행 파일 경로나 이름 — 확장자가 붙어 있어도 된다.
///
/// 순수 함수라 프로세스 목록 없이 표로 검증할 수 있다.
pub fn classify(exe_name: &str, argv: &[String]) -> Option<AiKind> {
    if let Some(kind) = program_kind(exe_name) {
        return Some(kind);
    }
    // 실행 파일 정보를 못 읽었을 때의 두 번째 그물 — argv[0] 은 대개 그 프로그램 자신이다.
    if let Some(kind) = argv.first().and_then(|a| program_kind(a)) {
        return Some(kind);
    }

    // 런처를 거쳐 뜬 경우 — 인자에서 실제 프로그램을 찾는다.
    // 첫 인자는 런처 자신이므로 건너뛴다.
    for arg in argv.iter().skip(1) {
        let lower = arg.to_ascii_lowercase();
        if lower.starts_with('-') {
            continue;
        }
        let leaf = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
        if lower.contains("claude-code") || leaf == "claude" || leaf == "claude.js" {
            return Some(AiKind::Claude);
        }
        if lower.contains("codex-cli") || leaf == "codex" || leaf == "codex.js" {
            return Some(AiKind::Codex);
        }
    }
    None
}

/// 셸 pid 마다 그 자손 중에 돌고 있는 AI 를 찾는다.
///
/// `shells` 는 `(창 id, 셸 pid)`. 돌려주는 맵에는 찾은 창만 담긴다.
pub fn detect(shells: &[(String, u32)]) -> HashMap<String, AiKind> {
    let mut found = HashMap::new();
    if shells.is_empty() {
        return found;
    }

    let mut sys = System::new();
    // 실행 파일 경로는 **따로 청해야** 채워진다(`with_exe`). 청하지 않으면 `exe()` 가 비어
    // 프로세스 이름으로 물러나는데, 그 이름은 윈도우에서 `claude.exe` 처럼 확장자가 붙어 온다.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::Always)
            .with_exe(UpdateKind::OnlyIfNotSet),
    );

    // 부모 → 자식 목록. 자손을 훑으려면 반대 방향이 필요하다.
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        if let Some(parent) = proc_.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }

    for (pane_id, shell_pid) in shells {
        let root = Pid::from_u32(*shell_pid);
        // 셸 자신은 건너뛰고 자손만 본다.
        let mut stack: Vec<Pid> = children.get(&root).cloned().unwrap_or_default();
        let mut seen = 0usize;
        while let Some(pid) = stack.pop() {
            // 부모 pid 가 순환하는 병리적 경우에도 멈추도록 상한을 둔다.
            seen += 1;
            if seen > 4096 {
                break;
            }
            let Some(proc_) = sys.process(pid) else {
                continue;
            };
            let name = proc_
                .exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| proc_.name().to_string_lossy().to_string());
            let argv: Vec<String> = proc_
                .cmd()
                .iter()
                .map(|a| a.to_string_lossy().to_string())
                .collect();
            if let Some(kind) = classify(&name, &argv) {
                found.insert(pane_id.clone(), kind);
                break;
            }
            if let Some(next) = children.get(&pid) {
                stack.extend(next.iter().copied());
            }
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn native_executables_are_recognised() {
        assert_eq!(
            classify("claude", &argv(&["C:\\Users\\me\\.local\\bin\\claude.exe"])),
            Some(AiKind::Claude)
        );
        assert_eq!(classify("codex", &argv(&["codex"])), Some(AiKind::Codex));
        // 대소문자는 상관없다.
        assert_eq!(classify("Claude", &argv(&["Claude.exe"])), Some(AiKind::Claude));
    }

    #[test]
    fn the_windows_process_name_carries_its_extension() {
        // 윈도우의 프로세스 이름은 `claude.exe` 다. 실행 파일 경로를 못 읽어 이름으로 물러났을 때도
        // 잡혀야 한다 — 예전에는 여기서 놓쳐 네이티브 claude 가 복원되지 않았다.
        assert_eq!(
            classify("claude.exe", &argv(&["claude", "--continue"])),
            Some(AiKind::Claude)
        );
        assert_eq!(
            classify(
                "C:\\Users\\me\\.local\\bin\\claude.exe",
                &argv(&["C:\\Users\\me\\.local\\bin\\claude.exe", "--dangerously-skip-permissions"])
            ),
            Some(AiKind::Claude)
        );
        assert_eq!(classify("CODEX.EXE", &argv(&["codex.exe", "resume"])), Some(AiKind::Codex));
    }

    #[test]
    fn argv0_is_a_second_net_when_the_executable_is_unknown() {
        // 남의 프로세스 실행 파일 경로는 권한에 따라 비어 올 수 있다.
        assert_eq!(
            classify("", &argv(&["C:\\Users\\me\\.local\\bin\\claude.exe", "-c"])),
            Some(AiKind::Claude)
        );
        assert_eq!(classify("", &argv(&["/usr/local/bin/codex"])), Some(AiKind::Codex));
        assert_eq!(classify("", &argv(&[])), None);
    }

    #[test]
    fn look_alike_names_with_extensions_are_not_ai() {
        assert_eq!(classify("claudia.exe", &argv(&["claudia.exe"])), None);
        assert_eq!(classify("claude-helper.exe", &argv(&["claude-helper.exe"])), None);
        assert_eq!(classify("pwsh.exe", &argv(&["pwsh.exe", "-NoLogo"])), None);
    }

    #[test]
    fn an_npm_install_shows_up_as_node() {
        assert_eq!(
            classify(
                "node",
                &argv(&[
                    "C:\\Program Files\\nodejs\\node.exe",
                    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
                ])
            ),
            Some(AiKind::Claude)
        );
    }

    #[test]
    fn ordinary_shells_and_tools_are_not_ai() {
        assert_eq!(classify("pwsh", &argv(&["pwsh.exe", "-NoLogo"])), None);
        assert_eq!(classify("node", &argv(&["node", "server.js"])), None);
        assert_eq!(classify("git", &argv(&["git", "status"])), None);
        // 이름이 비슷할 뿐인 것에 걸리면 안 된다.
        assert_eq!(classify("claudia", &argv(&["claudia"])), None);
    }

    #[test]
    fn flags_are_skipped_when_looking_for_the_real_program() {
        assert_eq!(
            classify("node", &argv(&["node", "--enable-source-maps", "/opt/claude-code/cli.js"])),
            Some(AiKind::Claude)
        );
    }

    #[test]
    fn detect_finds_nothing_for_an_unknown_pid() {
        // 실제 프로세스 트리에 없는 pid — 비어 있어야 한다.
        let out = detect(&[("p1".to_string(), u32::MAX)]);
        assert!(out.is_empty());
    }

    #[test]
    fn detect_short_circuits_on_an_empty_list() {
        assert!(detect(&[]).is_empty());
    }
}

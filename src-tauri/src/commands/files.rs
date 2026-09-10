//! 파일 목록 · 읽기 · 저장.
//!
//! 디자인의 목 데이터(`FILES` 상수)를 실제 디스크로 바꾼 부분이다.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rterm_core::{MdMode, PaneKind, Snapshot};
use serde::Serialize;
use tauri::State;

use super::mutate;
use crate::state::AppState;

/// 목록에서 통째로 건너뛰는 디렉터리.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    ".git",
    ".vite",
    "__pycache__",
];

/// 피커에 올리는 최대 개수. 디자인의 목록은 짧으므로 넉넉히 잡아도 충분하다.
const MAX_ENTRIES: usize = 300;

/// 한 번에 열지 않을 텍스트 파일 크기 (8 MiB).
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

/// 이미지는 base64 로 웹뷰에 실어 보내므로 조금 더 넉넉히, 대신 상한을 둔다 (32 MiB).
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// 새로 만들 수 있는 파일 종류. 디자인의 "빈 블럭" 은 여는 자리였고, 여기에 만드는 자리를 더한다.
const NEW_FILE_KINDS: &[(&str, &str)] = &[("md", "md"), ("txt", "txt")];

/// 윈도우가 파일 이름에 쓰지 못하게 막는 글자.
const BAD_NAME_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

/// 윈도우 예약 장치 이름 — 이 이름으로는 파일을 만들 수 없다.
const RESERVED_STEMS: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// 이미지 뷰어로 여는 확장자와 MIME.
const IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("avif", "image/avif"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// cwd 기준 상대 경로 — 디자인처럼 `docs/layout.md` 형태로 보인다.
    pub name: String,
    pub path: String,
    /// 대문자 확장자 배지 (MD · TOML · RS …).
    pub ext: String,
    /// "4.1 KB" 처럼 사람이 읽는 크기.
    pub size: String,
    pub is_markdown: bool,
    pub is_image: bool,
}

#[derive(Debug, Clone)]
pub struct FileDoc {
    pub name: String,
    pub path: String,
    pub is_markdown: bool,
    /// md 는 원문 마크다운, 그 외는 리치 텍스트 에디터용 HTML.
    pub content: String,
}

fn human_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// 확장자로 이미지 MIME 을 고른다. 이미지가 아니면 `None`.
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_TYPES
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, mime)| *mime)
}

fn is_image(path: &Path) -> bool {
    image_mime(path).is_some()
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

fn ext_badge(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_uppercase())
        .unwrap_or_else(|| "FILE".into())
}

fn hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// HTML 을 안전한 텍스트로 이스케이프한다 (디자인의 `esc`).
fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 평문을 리치 텍스트 에디터가 다루는 줄 단위 div 로 감싼다.
fn text_to_html(raw: &str) -> String {
    raw.lines()
        .map(|line| {
            if line.trim().is_empty() {
                "<div><br></div>".to_string()
            } else {
                format!("<div>{}</div>", esc(line))
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

/// 줄바꿈을 만드는 블록 태그.
fn is_block_tag(name: &str) -> bool {
    matches!(name, "div" | "p" | "tr" | "li" | "h1" | "h2" | "h3" | "h4")
}

/// 리치 텍스트 HTML 을 다시 평문으로. 저장 시 소스 파일에 마크업이 새지 않게 한다.
///
/// 빈 줄(`<div><br></div>`)을 잃지 않도록 줄 단위로 모은다. `<br>` 이 이미 줄을 끊었으면
/// 뒤따르는 블록 닫힘은 다시 끊지 않는다 — 그러지 않으면 빈 줄이 두 배로 늘어난다.
fn html_to_text(html: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut tag = String::new();
    let mut in_tag = false;
    let mut just_broke = false;

    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let raw = tag.trim();
                let closing = raw.starts_with('/');
                let name = raw
                    .trim_start_matches('/')
                    .split(|ch: char| ch.is_whitespace() || ch == '/')
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();

                if name == "br" {
                    lines.push(std::mem::take(&mut cur));
                    just_broke = true;
                } else if is_block_tag(&name) {
                    if closing {
                        if !just_broke {
                            lines.push(std::mem::take(&mut cur));
                        }
                        just_broke = true;
                    } else if !cur.is_empty() {
                        // 여는 블록 앞에 글자가 남아 있으면 그것도 한 줄이다.
                        lines.push(std::mem::take(&mut cur));
                    }
                }
            }
            _ if in_tag => tag.push(c),
            _ => {
                cur.push(c);
                just_broke = false;
            }
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }

    let text = lines.join("\n");
    // `&amp;` 는 마지막에 풀어야 `&amp;lt;` 가 `<` 로 잘못 바뀌지 않는다.
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
        .trim_end()
        .to_string()
}

fn collect(dir: &Path, base: &Path, depth: usize, out: &mut Vec<FileEntry>) {
    if out.len() >= MAX_ENTRIES || depth > 1 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if hidden(name) || SKIP_DIRS.contains(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };

        if meta.is_dir() {
            dirs.push(path);
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(FileEntry {
                name: rel,
                path: path.to_string_lossy().to_string(),
                ext: ext_badge(&path),
                size: human_size(meta.len()),
                is_markdown: is_markdown(&path),
                is_image: is_image(&path),
            });
        }
    }

    // 한 단계 아래까지만 훑는다 — 디자인 목록의 `docs/layout.md` 형태를 재현.
    for d in dirs {
        collect(&d, base, depth + 1, out);
    }
}

#[tauri::command]
pub fn fs_list(cwd: String) -> Result<Vec<FileEntry>, String> {
    let base = PathBuf::from(&cwd);
    if !base.is_dir() {
        return Err(format!("디렉터리를 찾을 수 없습니다: {cwd}"));
    }
    let mut out = Vec::new();
    collect(&base, &base, 0, &mut out);
    out.sort_by_key(|e| e.name.to_lowercase());
    Ok(out)
}

/// 파일 하나를 읽어 패널에 넣을 모양으로 만든다.
/// IPC 로 직접 노출하지 않고 `pane_open_file` 이 안에서 쓴다.
fn fs_read(path: String) -> Result<FileDoc, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("열 수 없습니다: {e}"))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "파일이 너무 큽니다 ({}). 8 MB 이하만 열 수 있습니다",
            human_size(meta.len())
        ));
    }

    let raw = std::fs::read(&p).map_err(|e| format!("읽을 수 없습니다: {e}"))?;
    // 바이너리는 거절한다 — 리치 텍스트 에디터에 넣어 봐야 의미가 없다.
    if raw.contains(&0) {
        return Err("바이너리 파일은 열 수 없습니다".into());
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let md = is_markdown(&p);

    Ok(FileDoc {
        name: p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("untitled")
            .to_string(),
        path: p.to_string_lossy().to_string(),
        is_markdown: md,
        content: if md { text } else { text_to_html(&text) },
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDoc {
    /// `data:image/png;base64,...` — CSP 의 `img-src data:` 로 그대로 그린다.
    pub data_url: String,
    pub mime: String,
    pub bytes: usize,
}

/// 이미지 한 장을 data URL 로 읽어 온다.
///
/// 스냅샷에는 경로만 남기고 화면을 열 때마다 여기서 다시 읽는다 —
/// base64 를 스냅샷에 넣으면 파일이 수십 MB 로 부풀기 때문이다.
#[tauri::command]
pub fn fs_read_image(path: String) -> Result<ImageDoc, String> {
    let p = PathBuf::from(&path);
    let mime = image_mime(&p).ok_or_else(|| "이미지 파일이 아닙니다".to_string())?;

    let meta = std::fs::metadata(&p).map_err(|e| format!("열 수 없습니다: {e}"))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "이미지가 너무 큽니다 ({}). 32 MB 이하만 열 수 있습니다",
            human_size(meta.len())
        ));
    }

    let raw = std::fs::read(&p).map_err(|e| format!("읽을 수 없습니다: {e}"))?;
    let bytes = raw.len();
    let data_url = format!("data:{mime};base64,{}", STANDARD.encode(&raw));

    Ok(ImageDoc {
        data_url,
        mime: mime.to_string(),
        bytes,
    })
}

/// 이미지 패널의 확대 배율(%)을 기록한다. `None` 이면 창에 맞춤.
#[tauri::command]
pub fn pane_set_image_zoom(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
    zoom: Option<u32>,
) -> Result<(), String> {
    let mut snap = state.snapshot.lock();
    let pane = snap
        .session_mut(&session_id)
        .and_then(|s| s.pane_mut(&pane_id))
        .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
    pane.image_zoom = zoom.map(|z| z.clamp(10, 1600));
    Ok(())
}

/// 새 파일 이름을 세션 폴더 기준의 실제 경로로 바꾼다.
///
/// 이름은 **세션 폴더 아래**로만 간다 — 절대 경로도, `..` 도 받지 않는다. 빈 블럭에서
/// 파일을 만드는 자리는 언제나 그 세션의 작업 폴더이므로, 거기서 벗어나는 길은 실수일 뿐이다.
/// 확장자를 적지 않았으면 고른 종류(`md` · `txt`)를 붙인다.
fn resolve_new_path(cwd: &Path, name: &str, kind: &str) -> Result<PathBuf, String> {
    let ext = NEW_FILE_KINDS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, e)| *e)
        .ok_or_else(|| "만들 수 없는 파일 종류입니다".to_string())?;

    let raw = name.trim();
    if raw.is_empty() {
        return Err("파일 이름을 적어 주세요".into());
    }
    if raw.contains(BAD_NAME_CHARS) || raw.chars().any(|c| c.is_control()) {
        return Err(r#"이름에 < > : " | ? * 는 쓸 수 없습니다"#.into());
    }
    // 절대 경로(`C:\...` · `/...` · `\\서버\...`)는 여기서 걸러진다 — `:` 는 위에서 이미 막혔다.
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err("세션 폴더 아래의 이름만 쓸 수 있습니다".into());
    }

    let mut path = cwd.to_path_buf();
    let parts: Vec<&str> = raw.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err("파일 이름을 적어 주세요".into());
    }
    for part in &parts {
        if *part == ".." || *part == "." {
            return Err("세션 폴더 밖으로는 만들 수 없습니다".into());
        }
        // 윈도우는 이름 끝의 점·공백을 조용히 지운다 — 뜻하지 않은 파일이 생기지 않게 막는다.
        if part.ends_with('.') || part.ends_with(' ') {
            return Err("이름 끝에 점이나 공백을 둘 수 없습니다".into());
        }
        path.push(part);
    }

    let last = parts[parts.len() - 1];
    // 확장자가 없으면 고른 종류를 붙인다. `note.` 같은 꼴은 위에서 이미 걸러졌다.
    if !last.contains('.') {
        path.set_extension(ext);
    }

    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if RESERVED_STEMS.contains(&stem.as_str()) {
        return Err(format!("`{stem}` 은 윈도우 예약 이름입니다"));
    }

    Ok(path)
}

/// 새로 만든 파일에 넣어 둘 내용.
///
/// 마크다운은 제목 한 줄로 시작한다 — 빈 문서를 열어 놓고 무엇부터 쓸지 고민하는 것보다,
/// 파일 이름이 그대로 제목이 되어 있는 편이 이어 쓰기 쉽다. 평문은 손대지 않는다.
fn seed_content(path: &Path) -> String {
    if !is_markdown(path) {
        return String::new();
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("문서");
    format!("# {stem}\n\n")
}

/// 빈 블럭에 새 파일을 만들어 곧바로 연다.
///
/// 만드는 것과 여는 것을 한 명령으로 묶는다 — 둘로 나누면 파일만 생기고 창은 비어 있는
/// 중간 상태가 생기고, 그 사이에 다른 조작이 끼어들 수 있다.
#[tauri::command]
pub fn pane_create_file(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
    name: String,
    kind: String,
) -> Result<Snapshot, String> {
    let cwd = {
        let snap = state.snapshot.lock();
        let session = snap
            .session(&session_id)
            .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())?;
        PathBuf::from(&session.cwd)
    };
    if !cwd.is_dir() {
        return Err(format!("세션 폴더를 찾을 수 없습니다: {}", cwd.display()));
    }

    let path = resolve_new_path(&cwd, &name, &kind)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("폴더를 만들 수 없습니다: {e}"))?;
    }

    let body = seed_content(&path);
    // `create_new` 라야 이미 있는 파일을 덮어쓰지 않는다 — 먼저 `exists()` 로 보고 쓰면
    // 그 사이에 생긴 파일을 날릴 수 있다.
    {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => "이미 있는 파일입니다".to_string(),
                _ => format!("파일을 만들 수 없습니다: {e}"),
            })?;
        file.write_all(body.as_bytes())
            .map_err(|e| format!("파일을 쓸 수 없습니다: {e}"))?;
    }

    let md = is_markdown(&path);
    let title = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("untitled")
        .to_string();
    let full = path.to_string_lossy().to_string();

    mutate(&state, &session_id, |s| {
        let pane = s
            .pane_mut(&pane_id)
            .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
        if pane.kind != PaneKind::Empty {
            return Err("빈 블럭에만 열 수 있습니다".into());
        }
        pane.kind = if md { PaneKind::Md } else { PaneKind::Text };
        pane.title = title.clone();
        pane.path = Some(full.clone());
        pane.content = Some(if md { body.clone() } else { text_to_html(&body) });
        // 방금 만든 빈 문서는 읽을 것이 없다 — 곧바로 쓸 수 있게 에디터로 연다.
        pane.mode = md.then_some(MdMode::Edit);
        pane.image_zoom = None;
        pane.dirty = false;
        Ok(())
    })
}

/// 파일을 빈 블럭에 연다. md 는 뷰어로, 이미지는 이미지 뷰어로,
/// 나머지는 텍스트 에디터로 — 디자인 규칙에 이미지만 더했다.
#[tauri::command]
pub fn pane_open_file(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
    path: String,
) -> Result<Snapshot, String> {
    let as_path = PathBuf::from(&path);

    // 이미지는 내용을 스냅샷에 담지 않는다 — 경로만 두고 열 때마다 다시 읽는다.
    if is_image(&as_path) {
        // 실제로 읽을 수 있는지 먼저 확인해 빈 창이 생기지 않게 한다.
        let doc = fs_read_image(path.clone())?;
        let name = as_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image")
            .to_string();
        return mutate(&state, &session_id, |s| {
            let pane = s
                .pane_mut(&pane_id)
                .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
            if pane.kind != PaneKind::Empty {
                return Err("빈 블럭에만 열 수 있습니다".into());
            }
            pane.kind = PaneKind::Image;
            pane.title = name;
            pane.path = Some(path.clone());
            pane.content = None;
            pane.mode = None;
            pane.image_zoom = None;
            pane.dirty = false;
            let _ = doc.bytes;
            Ok(())
        });
    }

    let doc = fs_read(path)?;
    mutate(&state, &session_id, |s| {
        let pane = s
            .pane_mut(&pane_id)
            .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
        if pane.kind != PaneKind::Empty {
            return Err("빈 블럭에만 열 수 있습니다".into());
        }
        pane.kind = if doc.is_markdown {
            PaneKind::Md
        } else {
            PaneKind::Text
        };
        pane.title = doc.name.clone();
        pane.path = Some(doc.path.clone());
        pane.content = Some(doc.content.clone());
        pane.mode = doc.is_markdown.then_some(MdMode::View);
        pane.image_zoom = None;
        pane.dirty = false;
        Ok(())
    })
}

/// 편집 내용을 메모리에 반영한다 (디스크 저장은 Ctrl+S).
#[tauri::command]
pub fn pane_set_content(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
    content: String,
) -> Result<(), String> {
    let mut snap = state.snapshot.lock();
    let pane = snap
        .session_mut(&session_id)
        .and_then(|s| s.pane_mut(&pane_id))
        .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
    pane.content = Some(content);
    pane.dirty = true;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub bytes: usize,
    pub snapshot: Snapshot,
}

/// 편집 중인 패널을 디스크에 쓴다.
///
/// md 는 원문 그대로, 리치 텍스트는 평문으로 되돌려 저장한다 —
/// 소스 파일에 서식 마크업을 남기지 않기 위한 의도적인 선택.
#[tauri::command]
pub fn pane_save(
    state: State<'_, AppState>,
    session_id: String,
    pane_id: String,
) -> Result<SaveResult, String> {
    let (path, body) = {
        let snap = state.snapshot.lock();
        let pane = snap
            .session(&session_id)
            .and_then(|s| s.pane(&pane_id))
            .ok_or_else(|| "창을 찾을 수 없습니다".to_string())?;
        let path = pane
            .path
            .clone()
            .ok_or_else(|| "저장할 경로가 없습니다".to_string())?;
        let content = pane.content.clone().unwrap_or_default();
        let body = match pane.kind {
            PaneKind::Md => content,
            PaneKind::Text => html_to_text(&content),
            _ => return Err("저장할 수 있는 창이 아닙니다".into()),
        };
        (path, body)
    };

    std::fs::write(&path, body.as_bytes()).map_err(|e| format!("저장할 수 없습니다: {e}"))?;

    {
        let mut snap = state.snapshot.lock();
        if let Some(pane) = snap
            .session_mut(&session_id)
            .and_then(|s| s.pane_mut(&pane_id))
        {
            pane.dirty = false;
        }
    }
    state.persist();

    Ok(SaveResult {
        path,
        bytes: body.len(),
        snapshot: super::read_snapshot(&state),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_round_trips_through_the_rich_editor_shape() {
        let src = "line one\n\nline <three>";
        let html = text_to_html(src);
        assert!(html.contains("&lt;three&gt;"), "꺾쇠는 이스케이프된다");
        assert_eq!(html_to_text(&html), "line one\n\nline <three>");
    }

    #[test]
    fn saving_rich_text_strips_markup() {
        let html = "<div><b>bold</b> text</div><div>second</div>";
        assert_eq!(html_to_text(html), "bold text\nsecond");
    }

    #[test]
    fn blank_lines_are_preserved_when_saving() {
        // 빈 줄이 사라지면 저장할 때마다 문서가 조금씩 뭉개진다.
        let src = "a


b";
        assert_eq!(html_to_text(&text_to_html(src)), src);
    }

    #[test]
    fn a_br_inside_a_block_does_not_double_the_break() {
        assert_eq!(html_to_text("<div>a</div><div><br></div><div>b</div>"), "a

b");
    }

    #[test]
    fn escaped_ampersands_survive_the_round_trip() {
        let src = "a &amp; b <tag>";
        assert_eq!(html_to_text(&text_to_html(src)), src);
    }

    #[test]
    fn table_rows_become_separate_lines() {
        assert_eq!(
            html_to_text("<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>"),
            "ab
c"
        );
    }

    #[test]
    fn human_size_matches_the_design_labels() {
        assert_eq!(human_size(812), "812 B");
        assert_eq!(human_size(4198), "4.1 KB");
    }

    fn temp_file(name: &str, body: &[u8]) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("rterm-files-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn images_come_back_as_data_urls() {
        let path = temp_file("dot.png", &[0x89, b'P', b'N', b'G', 1, 2, 3]);

        let doc = fs_read_image(path.to_string_lossy().to_string()).expect("read ok");

        assert_eq!(doc.mime, "image/png");
        assert_eq!(doc.bytes, 7);
        assert!(doc.data_url.starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn non_images_are_refused_by_the_image_reader() {
        let path = temp_file("notes.txt", b"hello");
        assert!(fs_read_image(path.to_string_lossy().to_string()).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_missing_image_reports_an_error() {
        assert!(fs_read_image("C:/없는경로/none.png".into()).is_err());
    }

    #[test]
    fn image_extensions_map_to_mime_types() {
        assert_eq!(image_mime(Path::new("logo.PNG")), Some("image/png"));
        assert_eq!(image_mime(Path::new("shot.jpeg")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("icon.svg")), Some("image/svg+xml"));
        assert_eq!(image_mime(Path::new("notes.txt")), None);
        assert_eq!(image_mime(Path::new("no-extension")), None);
    }

    #[test]
    fn images_are_not_treated_as_markdown_or_text() {
        assert!(is_image(Path::new("a.webp")));
        assert!(!is_markdown(Path::new("a.webp")));
        assert!(!is_image(Path::new("README.md")));
    }

    #[test]
    fn a_new_name_without_an_extension_gets_the_chosen_one() {
        let cwd = Path::new("/work");
        assert_eq!(
            resolve_new_path(cwd, "메모", "md").unwrap(),
            Path::new("/work/메모.md")
        );
        assert_eq!(
            resolve_new_path(cwd, "메모", "txt").unwrap(),
            Path::new("/work/메모.txt")
        );
    }

    #[test]
    fn a_name_that_already_has_an_extension_is_left_alone() {
        let cwd = Path::new("/work");
        assert_eq!(
            resolve_new_path(cwd, "readme.markdown", "md").unwrap(),
            Path::new("/work/readme.markdown")
        );
        // 종류와 확장자가 어긋나도 적은 이름이 이긴다 — 여는 모습은 확장자가 정한다.
        assert_eq!(
            resolve_new_path(cwd, "notes.txt", "md").unwrap(),
            Path::new("/work/notes.txt")
        );
    }

    #[test]
    fn a_relative_subfolder_is_allowed() {
        assert_eq!(
            resolve_new_path(Path::new("/work"), "docs\\layout", "md").unwrap(),
            Path::new("/work/docs/layout.md")
        );
    }

    #[test]
    fn new_names_cannot_escape_the_session_folder() {
        let cwd = Path::new("/work");
        assert!(resolve_new_path(cwd, "../secret.md", "md").is_err());
        assert!(resolve_new_path(cwd, "docs/../../secret.md", "md").is_err());
        assert!(resolve_new_path(cwd, "/etc/passwd", "txt").is_err());
        assert!(resolve_new_path(cwd, "\\\\server\\share\\a.md", "md").is_err());
        // `:` 은 금지 글자라 드라이브 문자로 시작하는 절대 경로도 여기서 막힌다.
        assert!(resolve_new_path(cwd, "C:/Windows/a.txt", "txt").is_err());
    }

    #[test]
    fn windows_hostile_names_are_refused() {
        let cwd = Path::new("/work");
        assert!(resolve_new_path(cwd, "", "md").is_err());
        assert!(resolve_new_path(cwd, "   ", "md").is_err());
        assert!(resolve_new_path(cwd, "a?b.md", "md").is_err());
        assert!(resolve_new_path(cwd, "a|b.md", "md").is_err());
        // 윈도우가 조용히 지우는 끝의 점·공백.
        assert!(resolve_new_path(cwd, "메모.", "md").is_err());
        assert!(resolve_new_path(cwd, "메모 ", "md").is_ok(), "바깥 공백은 다듬는다");
        // 예약 장치 이름.
        assert!(resolve_new_path(cwd, "nul", "txt").is_err());
        assert!(resolve_new_path(cwd, "COM1.md", "md").is_err());
    }

    #[test]
    fn an_unknown_kind_is_refused() {
        assert!(resolve_new_path(Path::new("/work"), "a", "exe").is_err());
    }

    #[test]
    fn a_new_markdown_file_starts_with_its_name_as_a_heading() {
        assert_eq!(seed_content(Path::new("/work/설계 노트.md")), "# 설계 노트\n\n");
        assert_eq!(seed_content(Path::new("/work/notes.txt")), "");
    }

    #[test]
    fn markdown_detection_is_case_insensitive() {
        assert!(is_markdown(Path::new("README.MD")));
        assert!(!is_markdown(Path::new("Cargo.toml")));
    }
}

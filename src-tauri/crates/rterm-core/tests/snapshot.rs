//! 스냅샷 저장·복원 회귀 테스트 — "종료 후 복원"이 실제로 왕복하는지 확인한다.

use std::path::PathBuf;

use rterm_core::{split, PaneKind, Session, Shell, Snapshot, SplitDir};

/// 테스트마다 겹치지 않는 임시 디렉터리.
fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("rterm-test-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn seed_starts_with_one_session_and_one_empty_block() {
    let snap = Snapshot::seed("C:/work/demo");
    assert_eq!(snap.sessions.len(), 1);
    assert_eq!(snap.sessions[0].name, "demo", "세션 이름은 폴더 이름에서 따온다");
    assert_eq!(snap.sessions[0].panes.len(), 1);
    assert_eq!(snap.sessions[0].panes[0].kind, PaneKind::Empty);
    assert!(!snap.restored);
}

#[test]
fn layout_scrollback_and_zoom_survive_a_save_load_cycle() {
    let dir = temp_dir("roundtrip");
    let path = Snapshot::path_in(&dir);

    let mut snap = Snapshot::seed("C:/work/demo");
    {
        let session = &mut snap.sessions[0];
        session.shell = Shell::Cmd;
        session.claude = "sess_abc".into();
        let root = session.panes[0].id.clone();
        split(session, &root, SplitDir::LeftRight).expect("split");

        let pane = session.pane_mut(&root).expect("root pane");
        pane.kind = PaneKind::Term;
        pane.title = "cmd · 빌드".into();
        pane.zoom = 18;
        pane.scrollback = Some("\u{1b}[32mok\u{1b}[0m\r\n".into());
        pane.alive = true;
    }

    snap.save(&path).expect("save");
    assert!(path.exists(), "스냅샷 파일이 생겨야 한다");

    let loaded = Snapshot::load(&path).expect("load");
    assert!(loaded.restored, "복원된 스냅샷은 restored 표시가 붙는다");
    assert_eq!(loaded.sessions.len(), 1);

    let session = &loaded.sessions[0];
    assert_eq!(session.shell, Shell::Cmd);
    assert_eq!(session.claude, "sess_abc");
    assert_eq!(session.grid.cols, 2, "그리드 배치가 그대로");
    assert_eq!(session.panes.len(), 2);

    let term = session
        .panes
        .iter()
        .find(|p| p.kind == PaneKind::Term)
        .expect("터미널 패널");
    assert_eq!(term.title, "cmd · 빌드");
    assert_eq!(term.zoom, 18, "확대 배율도 창별로 기록된다");
    assert_eq!(term.scrollback.as_deref(), Some("\u{1b}[32mok\u{1b}[0m\r\n"));
    assert!(!term.alive, "PTY 는 재스폰되므로 alive 는 항상 꺼진 채로 복원된다");

    assert!(loaded.saved_at_epoch.is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn saving_twice_leaves_no_temp_file_behind() {
    let dir = temp_dir("atomic");
    let path = Snapshot::path_in(&dir);
    let mut snap = Snapshot::seed("C:/work/demo");

    snap.save(&path).expect("first save");
    snap.save(&path).expect("second save");

    assert!(path.exists());
    assert!(
        !path.with_extension("json.tmp").exists(),
        "임시 파일은 rename 으로 사라져야 한다"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_corrupt_snapshot_is_ignored_rather_than_crashing() {
    let dir = temp_dir("corrupt");
    let path = Snapshot::path_in(&dir);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{ 이건 JSON 이 아니다").unwrap();

    assert!(Snapshot::load(&path).is_none(), "깨진 파일은 씨드로 넘어간다");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_snapshot_is_ignored() {
    let dir = temp_dir("missing");
    assert!(Snapshot::load(&Snapshot::path_in(&dir)).is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_dangling_active_id_is_repaired_on_load() {
    let dir = temp_dir("dangling");
    let path = Snapshot::path_in(&dir);

    let mut snap = Snapshot::seed("C:/work/demo");
    snap.sessions.push(Session::new("두번째", "C:/work/other", 1));
    snap.active_id = "ses_사라진세션".into();
    snap.save(&path).expect("save");

    let loaded = Snapshot::load(&path).expect("load");
    assert!(
        loaded.sessions.iter().any(|s| s.id == loaded.active_id),
        "활성 세션이 없으면 첫 세션으로 되돌린다"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_session_with_no_panes_gets_an_empty_block_back() {
    let dir = temp_dir("noplanes");
    let path = Snapshot::path_in(&dir);

    let mut snap = Snapshot::seed("C:/work/demo");
    snap.sessions[0].panes.clear();
    snap.save(&path).expect("save");

    let loaded = Snapshot::load(&path).expect("load");
    assert_eq!(loaded.sessions[0].panes.len(), 1);
    assert_eq!(loaded.sessions[0].panes[0].kind, PaneKind::Empty);
    let _ = std::fs::remove_dir_all(&dir);
}

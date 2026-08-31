//! 레이아웃 대수 회귀 테스트.
//!
//! 특히 병합의 **점유 규칙**(프로그램이 열린 창은 최대 하나)은 요구사항의 핵심이라
//! 5가지 조합을 모두 고정해 둔다.

use rterm_core::{
    layout, merge, merge_check, normalize, reset_weights, set_weights, split, swap, LayoutError,
    MergeAxis, MergeReject, MergeVerdict, Pane, PaneKind, Session, SplitDir, TrackAxis,
};

/// 1×1 빈 세션.
fn session() -> Session {
    Session::new("t", "C:/tmp", 0)
}

/// 지정한 자리의 창을 주어진 종류로 채운다 (터미널/에디터를 흉내).
fn occupy(s: &mut Session, id: &str, kind: PaneKind) {
    let p = s.pane_mut(id).expect("pane exists");
    p.kind = kind;
    p.title = match kind {
        PaneKind::Term => "pwsh".into(),
        PaneKind::Md => "README.md".into(),
        PaneKind::Text => "notes.txt".into(),
        PaneKind::Image => "logo.png".into(),
        PaneKind::Empty => "빈 블럭".into(),
    };
}

fn ids(s: &Session) -> Vec<String> {
    s.panes.iter().map(|p| p.id.clone()).collect()
}

/// 그리드 크기만 비교한다 (몫까지 든 `Grid` 를 통째로 견주면 읽기 어렵다).
fn dims(s: &Session) -> (u32, u32) {
    (s.grid.cols, s.grid.rows)
}

fn rect(s: &Session, id: &str) -> (u32, u32, u32, u32) {
    let p = s.pane(id).expect("pane exists");
    (p.r, p.c, p.rs, p.cs)
}

// ─────────────────────────────── 분할 ───────────────────────────────

#[test]
fn split_left_right_doubles_grid_and_adds_empty_block() {
    let mut s = session();
    let a = s.panes[0].id.clone();

    let b = split(&mut s, &a, SplitDir::LeftRight).expect("split ok");

    assert_eq!(dims(&s), (2, 1));
    assert_eq!(s.panes.len(), 2);
    assert_eq!(rect(&s, &a), (1, 1, 1, 1));
    assert_eq!(rect(&s, &b), (1, 2, 1, 1));
    assert_eq!(s.pane(&b).unwrap().kind, PaneKind::Empty);
}

#[test]
fn split_top_bottom_doubles_rows() {
    let mut s = session();
    let a = s.panes[0].id.clone();

    let b = split(&mut s, &a, SplitDir::TopBottom).expect("split ok");

    assert_eq!(dims(&s), (1, 2));
    assert_eq!(rect(&s, &a), (1, 1, 1, 1));
    assert_eq!(rect(&s, &b), (2, 1, 1, 1));
}

#[test]
fn split_reuses_existing_span_without_growing_grid() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    // 먼저 2열로 만들고 a 를 다시 넓힌다: a 가 2칸을 차지한 상태.
    split(&mut s, &a, SplitDir::LeftRight).unwrap();
    s.pane_mut(&a).unwrap().cs = 2;
    s.panes.retain(|p| p.id == a);

    let c = split(&mut s, &a, SplitDir::LeftRight).expect("split ok");

    // span 이 2라 그리드를 늘릴 필요가 없다.
    assert_eq!(s.grid.cols, 2);
    assert_eq!(rect(&s, &a), (1, 1, 1, 1));
    assert_eq!(rect(&s, &c), (1, 2, 1, 1));
}

#[test]
fn split_refuses_beyond_eight_tracks() {
    let mut s = session();
    let a = s.panes[0].id.clone();

    // 1 → 2 → 4 → 8 까지는 허용.
    for _ in 0..3 {
        split(&mut s, &a, SplitDir::LeftRight).expect("within limit");
    }
    assert_eq!(s.grid.cols, 8);

    let err = split(&mut s, &a, SplitDir::LeftRight).unwrap_err();
    assert_eq!(err, LayoutError::CannotSplitLeftRight);
    assert_eq!(s.grid.cols, 8, "거부된 분할은 그리드를 건드리지 않는다");
}

#[test]
fn split_of_unknown_pane_is_an_error() {
    let mut s = session();
    assert_eq!(
        split(&mut s, "없는id", SplitDir::LeftRight).unwrap_err(),
        LayoutError::PaneNotFound
    );
}

// ─────────────────────────────── 정규화 ───────────────────────────────

#[test]
fn normalize_folds_evenly_aligned_grid() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    split(&mut s, &a, SplitDir::LeftRight).unwrap();
    // 두 창을 지우고 a 가 전체를 차지하게 만든다 → 2열이 1열로 접혀야 한다.
    s.panes.retain(|p| p.id == a);
    s.pane_mut(&a).unwrap().cs = 2;

    normalize(&mut s);

    assert_eq!(s.grid.cols, 1);
    assert_eq!(rect(&s, &a), (1, 1, 1, 1));
}

#[test]
fn normalize_leaves_odd_alignment_alone() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();

    let before = (dims(&s), rect(&s, &a), rect(&s, &b));
    normalize(&mut s);

    assert_eq!((dims(&s), rect(&s, &a), rect(&s, &b)), before);
}

// ────────────────────────── 병합 · 기하 판정 ──────────────────────────

#[test]
fn merge_accepts_adjacent_panes_in_the_same_row() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();

    let verdict = merge_check(&s, &[a.clone(), b.clone()]);
    let plan = verdict.plan().expect("가로줄 인접은 병합 가능");
    assert_eq!(plan.axis, MergeAxis::Row);
    assert_eq!((plan.r, plan.c, plan.rs, plan.cs), (1, 1, 1, 2));
    assert_eq!(plan.count, 2);
}

#[test]
fn merge_accepts_adjacent_panes_in_the_same_column() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::TopBottom).unwrap();

    let plan = merge_check(&s, &[a, b]).plan().cloned().expect("세로줄 인접은 병합 가능");
    assert_eq!(plan.axis, MergeAxis::Col);
    assert_eq!((plan.r, plan.c, plan.rs, plan.cs), (1, 1, 2, 1));
}

#[test]
fn merge_rejects_l_shaped_selection() {
    // 2×2 를 만든 뒤 대각선으로 어긋난 3개를 고른다.
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    let c = split(&mut s, &a, SplitDir::TopBottom).unwrap();

    // a(1,1) · b(1,2) · c(2,1) → L자.
    match merge_check(&s, &[a, b, c]) {
        MergeVerdict::Rejected { reason, .. } => assert_eq!(reason, MergeReject::NotAligned),
        MergeVerdict::Ok(p) => panic!("L자 배치가 통과했다: {p:?}"),
    }
}

#[test]
fn merge_rejects_non_adjacent_panes() {
    // 1×3 가로줄에서 양 끝 두 개만 고르면 가운데가 비어 직사각형이 안 된다.
    let mut s = session();
    let a = s.panes[0].id.clone();
    split(&mut s, &a, SplitDir::LeftRight).unwrap(); // 2열
    let all = ids(&s);
    let left = all[0].clone();
    let right = all[1].clone();
    // 왼쪽을 다시 갈라 3칸 구조(4열 그리드)로 만든다.
    let mid = split(&mut s, &left, SplitDir::LeftRight).unwrap();

    // left(1..2) · mid(2..3) · right(3..5) 중 left 와 right 만 선택.
    match merge_check(&s, &[left, right]) {
        MergeVerdict::Rejected { reason, .. } => assert_eq!(reason, MergeReject::NotAligned),
        MergeVerdict::Ok(p) => panic!("비인접 병합이 통과했다: {p:?} (mid={mid})"),
    }
}

#[test]
fn merge_rejects_single_pane_drag() {
    let s = session();
    let a = s.panes[0].id.clone();
    match merge_check(&s, &[a]) {
        MergeVerdict::Rejected { reason, .. } => assert_eq!(reason, MergeReject::TooFew),
        MergeVerdict::Ok(_) => panic!("한 창만으로는 병합할 수 없다"),
    }
}

// ───────────────────── 병합 · 점유 규칙 (핵심 요구사항) ─────────────────────

#[test]
fn merge_terminal_with_empty_keeps_the_terminal() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    occupy(&mut s, &a, PaneKind::Term);

    let plan = merge(&mut s, &[a.clone(), b]).expect("터미널 + 빈블럭은 병합 가능");

    assert_eq!(plan.keep_id, a, "살아남는 창은 프로그램이 열린 쪽");
    assert_eq!(s.panes.len(), 1);
    assert_eq!(s.pane(&a).unwrap().kind, PaneKind::Term);
    // 전체를 차지하므로 그리드가 1×1 로 접힌다.
    assert_eq!(dims(&s), (1, 1));
    assert_eq!(rect(&s, &a), (1, 1, 1, 1));
}

#[test]
fn merge_editor_with_empty_keeps_the_editor_even_when_dragged_second() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    occupy(&mut s, &b, PaneKind::Md);

    // 빈 블럭에서 드래그를 시작해도 살아남는 것은 에디터여야 한다.
    let plan = merge(&mut s, &[a, b.clone()]).expect("에디터 + 빈블럭은 병합 가능");

    assert_eq!(plan.keep_id, b);
    assert_eq!(s.panes.len(), 1);
    assert_eq!(s.pane(&b).unwrap().kind, PaneKind::Md);
}

#[test]
fn merge_two_empty_blocks_produces_one_empty_block() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();

    let plan = merge(&mut s, &[a.clone(), b]).expect("빈블럭 + 빈블럭은 병합 가능");

    assert_eq!(plan.keep_id, a, "전부 비었으면 드래그를 시작한 창이 남는다");
    assert_eq!(s.panes.len(), 1);
    assert_eq!(s.pane(&a).unwrap().kind, PaneKind::Empty);
}

#[test]
fn merge_two_terminals_is_blocked() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    occupy(&mut s, &a, PaneKind::Term);
    occupy(&mut s, &b, PaneKind::Term);

    let before = s.clone();
    let err = merge(&mut s, &[a, b]).unwrap_err();

    assert_eq!(err, MergeReject::TooManyPrograms);
    assert_eq!(s, before, "차단된 병합은 레이아웃을 전혀 바꾸지 않는다");
}

#[test]
fn merge_terminal_with_editor_is_blocked() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    occupy(&mut s, &a, PaneKind::Term);
    occupy(&mut s, &b, PaneKind::Text);

    let before = s.clone();
    let err = merge(&mut s, &[a, b]).unwrap_err();

    assert_eq!(err, MergeReject::TooManyPrograms);
    assert_eq!(s, before);
}

#[test]
fn merge_image_with_empty_keeps_the_image() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    occupy(&mut s, &b, PaneKind::Image);

    let plan = merge(&mut s, &[a, b.clone()]).expect("이미지 + 빈블럭은 병합 가능");

    assert_eq!(plan.keep_id, b);
    assert_eq!(s.pane(&b).unwrap().kind, PaneKind::Image);
}

#[test]
fn merge_image_with_terminal_is_blocked() {
    // 이미지 뷰어도 "열린 프로그램" 으로 센다.
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    occupy(&mut s, &a, PaneKind::Term);
    occupy(&mut s, &b, PaneKind::Image);

    let before = s.clone();
    assert_eq!(merge(&mut s, &[a, b]).unwrap_err(), MergeReject::TooManyPrograms);
    assert_eq!(s, before);
}

#[test]
fn merge_blocked_message_only_states_the_reason() {
    // 요구사항: 병합 불가 시 토스트로 "안 된다"만 알린다.
    assert_eq!(
        MergeReject::TooManyPrograms.message(),
        "프로그램이 열린 창은 하나만 병합할 수 있습니다"
    );
}

#[test]
fn merge_of_three_in_a_row_keeps_the_single_program() {
    // 4열 가로줄 3칸 중 가운데만 터미널.
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    let c = split(&mut s, &b, SplitDir::LeftRight).unwrap();
    occupy(&mut s, &b, PaneKind::Term);

    let plan = merge(&mut s, &[a, b.clone(), c]).expect("가로줄 3칸 병합 가능");

    assert_eq!(plan.keep_id, b);
    assert_eq!(plan.axis, MergeAxis::Row);
    assert_eq!(plan.count, 3);
    assert_eq!(s.panes.len(), 1);
    assert_eq!(dims(&s), (1, 1));
}

// ─────────────────────────────── 위치 교환 ───────────────────────────────

#[test]
fn swap_exchanges_position_and_size() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    // b 를 다시 갈라 크기를 다르게 만든다.
    let _ = split(&mut s, &b, SplitDir::LeftRight).unwrap();

    let ra = rect(&s, &a);
    let rb = rect(&s, &b);
    swap(&mut s, &a, &b).expect("swap ok");

    assert_eq!(rect(&s, &a), rb);
    assert_eq!(rect(&s, &b), ra);
}

#[test]
fn swap_with_unknown_pane_is_an_error() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    assert_eq!(swap(&mut s, &a, "없는id").unwrap_err(), LayoutError::PaneNotFound);
}

// ─────────────────────────── 닫기 · 배치 보조 ───────────────────────────

#[test]
fn close_pane_leaves_an_empty_block_of_the_same_shape() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    split(&mut s, &a, SplitDir::TopBottom).unwrap();
    occupy(&mut s, &a, PaneKind::Term);
    let shape = rect(&s, &a);

    let fresh = layout::close_pane(&mut s, &a).expect("close ok");

    assert_eq!(s.panes.len(), 2, "닫아도 블럭 수는 그대로");
    assert_eq!(s.pane(&fresh).unwrap().kind, PaneKind::Empty);
    assert_eq!(rect(&s, &fresh), shape);
}

#[test]
fn place_pane_fills_the_named_empty_block() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    let shape = rect(&s, &b);

    let mut incoming = Pane::empty(9, 9, 9, 9);
    incoming.kind = PaneKind::Term;
    incoming.title = "pwsh".into();
    let placed = layout::place_pane(&mut s, incoming, Some(&b)).expect("빈 블럭이 있다");

    assert_eq!(rect(&s, &placed), shape, "좌표는 슬롯을 따른다");
    assert_eq!(s.pane(&placed).unwrap().kind, PaneKind::Term);
}

#[test]
fn place_pane_reports_when_there_is_no_room() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    occupy(&mut s, &a, PaneKind::Term);

    let mut incoming = Pane::empty(1, 1, 1, 1);
    incoming.kind = PaneKind::Md;

    assert!(layout::place_pane(&mut s, incoming, None).is_none());
}

// ─────────────────────── 경계 드래그 · 트랙 몫 ───────────────────────

#[test]
fn a_fresh_grid_shares_space_evenly() {
    let s = session();
    assert_eq!(s.grid.col_weights, vec![1.0]);
    assert_eq!(s.grid.row_weights, vec![1.0]);
}

#[test]
fn splitting_keeps_the_visible_proportions() {
    // 1열을 2열로 늘리면 각 트랙이 원래 몫의 반을 가져가므로 화면은 그대로다.
    let mut s = session();
    let a = s.panes[0].id.clone();
    split(&mut s, &a, SplitDir::LeftRight).unwrap();

    assert_eq!(s.grid.col_weights.len(), 2);
    assert!((s.grid.col_weights[0] - s.grid.col_weights[1]).abs() < 1e-5);
}

#[test]
fn resized_tracks_survive_a_further_split() {
    // 왼쪽을 3배로 넓힌 뒤 다시 나눠도 좌우 비율은 3:1 로 유지돼야 한다.
    let mut s = session();
    let a = s.panes[0].id.clone();
    let b = split(&mut s, &a, SplitDir::LeftRight).unwrap();
    set_weights(&mut s, TrackAxis::Col, vec![1.5, 0.5]).unwrap();

    split(&mut s, &b, SplitDir::LeftRight).unwrap();

    // 4열이 되고, 앞의 두 트랙 합 : 뒤의 두 트랙 합 = 3 : 1
    assert_eq!(s.grid.cols, 4);
    let left: f32 = s.grid.col_weights[0..2].iter().sum();
    let right: f32 = s.grid.col_weights[2..4].iter().sum();
    assert!((left / right - 3.0).abs() < 1e-3, "left={left} right={right}");
}

#[test]
fn folding_the_grid_adds_the_weights_together() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    split(&mut s, &a, SplitDir::LeftRight).unwrap();
    set_weights(&mut s, TrackAxis::Col, vec![1.5, 0.5]).unwrap();

    // 한 창이 두 트랙을 통째로 차지하면 2열이 1열로 접힌다.
    s.panes.retain(|p| p.id == a);
    s.pane_mut(&a).unwrap().cs = 2;
    normalize(&mut s);

    assert_eq!(s.grid.cols, 1);
    assert_eq!(s.grid.col_weights.len(), 1);
    assert!((s.grid.col_weights[0] - 1.0).abs() < 1e-5, "합쳐진 뒤에는 다시 균등해진다");
}

#[test]
fn weights_must_match_the_track_count() {
    let mut s = session();
    assert_eq!(
        set_weights(&mut s, TrackAxis::Col, vec![1.0, 1.0]).unwrap_err(),
        LayoutError::WeightCountMismatch
    );
}

#[test]
fn a_track_never_shrinks_to_nothing() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    split(&mut s, &a, SplitDir::LeftRight).unwrap();

    // 경계를 끝까지 밀어붙여도 반대쪽 창이 사라지지는 않는다.
    set_weights(&mut s, TrackAxis::Col, vec![2.0, 0.0]).unwrap();

    assert!(s.grid.col_weights[1] >= rterm_core::MIN_TRACK_WEIGHT);
    assert!(s.grid.col_weights[0] > s.grid.col_weights[1]);
}

#[test]
fn broken_weights_are_repaired_rather_than_trusted() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    split(&mut s, &a, SplitDir::TopBottom).unwrap();

    set_weights(&mut s, TrackAxis::Row, vec![f32::NAN, -3.0]).unwrap();

    assert!(s.grid.row_weights.iter().all(|w| w.is_finite() && *w > 0.0));
}

#[test]
fn reset_makes_every_track_equal_again() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    split(&mut s, &a, SplitDir::LeftRight).unwrap();
    set_weights(&mut s, TrackAxis::Col, vec![1.9, 0.1]).unwrap();

    reset_weights(&mut s);

    assert_eq!(s.grid.col_weights, vec![1.0, 1.0]);
}

#[test]
fn old_snapshots_without_weights_get_even_ones() {
    let mut s = session();
    let a = s.panes[0].id.clone();
    split(&mut s, &a, SplitDir::LeftRight).unwrap();
    // 예전 스냅샷을 흉내: 몫이 비어 있다.
    s.grid.col_weights.clear();
    s.grid.row_weights.clear();

    layout::ensure_non_empty(&mut s);

    assert_eq!(s.grid.col_weights, vec![1.0, 1.0]);
    assert_eq!(s.grid.row_weights, vec![1.0]);
}

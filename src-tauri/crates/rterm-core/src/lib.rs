//! rterm-core — 세션 모델 · 레이아웃 대수 · 스냅샷 영속화.
//!
//! Windows Terminal 의 창 배치 개념을 Rust 로 다시 세운 부분이며,
//! 프론트엔드는 여기 계산 결과를 렌더만 한다 (단일 진실 공급원).

pub mod layout;
pub mod model;
pub mod snapshot;

pub use layout::{
    close_pane, ensure_non_empty, merge, merge_check, normalize, place_pane, reset_weights,
    set_weights, split, swap, LayoutError, MergeAxis, MergePlan, MergeReject, MergeVerdict,
    SplitDir, TrackAxis, MAX_COLS, MAX_ROWS,
};
pub use model::{uid, EnvVar, Grid, MdMode, Pane, PaneKind, Session, Shell, MIN_TRACK_WEIGHT};
pub use snapshot::{Snapshot, SCROLLBACK_LINES, SNAPSHOT_VERSION};

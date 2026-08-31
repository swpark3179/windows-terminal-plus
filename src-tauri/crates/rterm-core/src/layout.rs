//! 레이아웃 대수 — 분할 · 병합 · 위치 교환 · 그리드 정규화.
//!
//! 디자인 스크립트의 `split` / `finishMerge` / `normalize` 를 옮긴 뒤,
//! 병합에 **점유 규칙**(프로그램이 열린 창은 최대 하나)을 추가했다.
//! 프론트엔드는 이 계산을 재현하지 않고 결과만 렌더한다.

use crate::model::{Grid, Pane, PaneKind, Session};
use serde::{Deserialize, Serialize};

pub const MAX_COLS: u32 = 8;
pub const MAX_ROWS: u32 = 8;

/// 분할 방향. 디자인의 `dir` 값 v/h 에 대응한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SplitDir {
    /// 좌·우 분할 — 세로선으로 가른다 (디자인 v).
    LeftRight,
    /// 위·아래 분할 — 가로선으로 가른다 (디자인 h).
    TopBottom,
}

/// 크기를 조절할 트랙의 방향.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackAxis {
    Col,
    Row,
}

/// 병합이 이뤄지는 축.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeAxis {
    /// 같은 가로줄에서 좌우로 이어붙임.
    Row,
    /// 같은 세로줄에서 상하로 이어붙임.
    Col,
}

impl MergeAxis {
    pub fn label(self) -> &'static str {
        match self {
            MergeAxis::Row => "가로줄",
            MergeAxis::Col => "세로줄",
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LayoutError {
    #[error("창을 찾을 수 없습니다")]
    PaneNotFound,
    #[error("좌·우로 더 나눌 수 없습니다")]
    CannotSplitLeftRight,
    #[error("위·아래로 더 나눌 수 없습니다")]
    CannotSplitTopBottom,
    #[error("트랙 개수와 몫의 개수가 맞지 않습니다")]
    WeightCountMismatch,
}

/// 병합 거부 사유. 사용자에게 보이는 토스트 문구를 그대로 들고 있다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeReject {
    /// 드래그가 창 하나에서 끝났다 — 조용히 취소.
    TooFew,
    /// 존재하지 않는 창이 섞였다.
    Missing,
    /// 같은 줄에서 이어지는 직사각형이 아니다.
    NotAligned,
    /// 프로그램이 열린 창이 둘 이상 — 요구사항의 핵심 차단 규칙.
    TooManyPrograms,
}

impl MergeReject {
    pub fn message(self) -> &'static str {
        match self {
            MergeReject::TooFew => "병합하려면 창 두 개 이상을 지나가세요",
            MergeReject::Missing => "창을 찾을 수 없습니다",
            MergeReject::NotAligned => {
                "같은 가로줄 또는 세로줄에서 이어지는 창들만 병합할 수 있습니다"
            }
            MergeReject::TooManyPrograms => "프로그램이 열린 창은 하나만 병합할 수 있습니다",
        }
    }
}

/// 병합 가능 판정 결과. 드래그 중 오버레이를 그리는 데도 그대로 쓰인다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePlan {
    /// 병합 후 남을 창 — 점유된 창이 있으면 그 창, 없으면 드래그를 시작한 창.
    pub keep_id: String,
    pub r: u32,
    pub c: u32,
    pub rs: u32,
    pub cs: u32,
    pub axis: MergeAxis,
    pub count: usize,
}

/// Result 를 그대로 직렬화하면 TS 쪽이 불편해서 태그드 유니온으로 감싼다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum MergeVerdict {
    Ok(MergePlan),
    Rejected { reason: MergeReject, message: String },
}

impl MergeVerdict {
    pub fn reject(reason: MergeReject) -> Self {
        MergeVerdict::Rejected {
            reason,
            message: reason.message().to_string(),
        }
    }

    pub fn plan(&self) -> Option<&MergePlan> {
        match self {
            MergeVerdict::Ok(p) => Some(p),
            MergeVerdict::Rejected { .. } => None,
        }
    }
}

/// 트랙 하나를 둘로 쪼갠다. 각 절반이 원래 몫의 반을 가져가므로 화면은 그대로다.
fn halve(weights: &[f32]) -> Vec<f32> {
    let mut next = Vec::with_capacity(weights.len() * 2);
    for w in weights {
        next.push(w / 2.0);
        next.push(w / 2.0);
    }
    next
}

/// 이웃한 두 트랙을 하나로 합친다 — 몫은 더한다.
fn fold(weights: &[f32]) -> Vec<f32> {
    weights.chunks(2).map(|pair| pair.iter().sum()).collect()
}

/// 그리드 축을 2배로 늘리고 모든 창의 좌표를 따라 늘린다.
fn double_cols(s: &mut Session) {
    s.grid.cols *= 2;
    s.grid.col_weights = halve(&s.grid.col_weights);
    s.grid.fix();
    for q in &mut s.panes {
        q.c = (q.c - 1) * 2 + 1;
        q.cs *= 2;
    }
}

fn double_rows(s: &mut Session) {
    s.grid.rows *= 2;
    s.grid.row_weights = halve(&s.grid.row_weights);
    s.grid.fix();
    for q in &mut s.panes {
        q.r = (q.r - 1) * 2 + 1;
        q.rs *= 2;
    }
}

/// 선택한 창을 반으로 가르고 남는 쪽에 빈 블럭을 만든다.
/// 성공 시 새 빈 블럭의 id 를 돌려준다 (디자인처럼 곧바로 선택 상태로 만들기 위함).
pub fn split(s: &mut Session, pane_id: &str, dir: SplitDir) -> Result<String, LayoutError> {
    let p = s.pane(pane_id).ok_or(LayoutError::PaneNotFound)?;

    match dir {
        SplitDir::LeftRight => {
            if p.cs < 2 {
                if s.grid.cols * 2 > MAX_COLS {
                    return Err(LayoutError::CannotSplitLeftRight);
                }
                double_cols(s);
            }
            let p = s.pane(pane_id).ok_or(LayoutError::PaneNotFound)?;
            let (r, c, rs, cs) = (p.r, p.c, p.rs, p.cs);
            let half = cs / 2;
            let new_pane = Pane::empty(r, c + half, rs, cs - half);
            let new_id = new_pane.id.clone();
            s.pane_mut(pane_id).expect("checked above").cs = half;
            s.panes.push(new_pane);
            Ok(new_id)
        }
        SplitDir::TopBottom => {
            if p.rs < 2 {
                if s.grid.rows * 2 > MAX_ROWS {
                    return Err(LayoutError::CannotSplitTopBottom);
                }
                double_rows(s);
            }
            let p = s.pane(pane_id).ok_or(LayoutError::PaneNotFound)?;
            let (r, c, rs, cs) = (p.r, p.c, p.rs, p.cs);
            let half = rs / 2;
            let new_pane = Pane::empty(r + half, c, rs - half, cs);
            let new_id = new_pane.id.clone();
            s.pane_mut(pane_id).expect("checked above").rs = half;
            s.panes.push(new_pane);
            Ok(new_id)
        }
    }
}

/// 병합 가능 여부를 판정한다. 드래그 중 매 hover 마다 호출해도 될 만큼 가볍다.
pub fn merge_check(s: &Session, ids: &[String]) -> MergeVerdict {
    if ids.len() < 2 {
        return MergeVerdict::reject(MergeReject::TooFew);
    }

    let members: Vec<&Pane> = ids.iter().filter_map(|id| s.pane(id)).collect();
    if members.len() != ids.len() {
        return MergeVerdict::reject(MergeReject::Missing);
    }

    // 1단계 — 기하: 같은 줄에서 이어지는 빈틈 없는 직사각형인가.
    let first = members[0];
    let r1 = members.iter().map(|p| p.r).min().unwrap();
    let c1 = members.iter().map(|p| p.c).min().unwrap();
    let r2 = members.iter().map(|p| p.r + p.rs).max().unwrap();
    let c2 = members.iter().map(|p| p.c + p.cs).max().unwrap();
    let area_sum: u32 = members.iter().map(|p| p.area()).sum();

    let same_row = members.iter().all(|p| p.r == first.r && p.rs == first.rs);
    let same_col = members.iter().all(|p| p.c == first.c && p.cs == first.cs);

    if area_sum != (r2 - r1) * (c2 - c1) || !(same_row || same_col) {
        return MergeVerdict::reject(MergeReject::NotAligned);
    }

    // 2단계 — 점유: 프로그램이 열린 창은 최대 하나여야 한다.
    let occupied: Vec<&Pane> = members
        .iter()
        .copied()
        .filter(|p| p.kind.is_occupied())
        .collect();
    if occupied.len() >= 2 {
        return MergeVerdict::reject(MergeReject::TooManyPrograms);
    }

    // 살아남는 창 = 유일하게 점유된 창. 전부 비었으면 드래그를 시작한 창.
    let keep_id = occupied
        .first()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| ids[0].clone());

    MergeVerdict::Ok(MergePlan {
        keep_id,
        r: r1,
        c: c1,
        rs: r2 - r1,
        cs: c2 - c1,
        axis: if same_row { MergeAxis::Row } else { MergeAxis::Col },
        count: members.len(),
    })
}

/// 판정을 통과하면 실제로 병합한다. 점유 창이 최대 하나이므로 PTY 가 파괴되는 일은 없다.
pub fn merge(s: &mut Session, ids: &[String]) -> Result<MergePlan, MergeReject> {
    let plan = match merge_check(s, ids) {
        MergeVerdict::Ok(p) => p,
        MergeVerdict::Rejected { reason, .. } => return Err(reason),
    };

    if let Some(keep) = s.pane_mut(&plan.keep_id) {
        keep.r = plan.r;
        keep.c = plan.c;
        keep.rs = plan.rs;
        keep.cs = plan.cs;
    }
    s.panes
        .retain(|p| p.id == plan.keep_id || !ids.iter().any(|id| id == &p.id));

    normalize(s);

    // 정규화로 좌표가 줄어들 수 있으므로 최종 사각형을 다시 읽어 돌려준다.
    let kept = s.pane(&plan.keep_id).expect("keep pane survives merge");
    Ok(MergePlan {
        keep_id: plan.keep_id.clone(),
        r: kept.r,
        c: kept.c,
        rs: kept.rs,
        cs: kept.cs,
        axis: plan.axis,
        count: plan.count,
    })
}

/// 두 창의 좌표·크기를 맞바꾼다.
pub fn swap(s: &mut Session, a: &str, b: &str) -> Result<(), LayoutError> {
    if a == b {
        return Ok(());
    }
    let pa = s
        .pane(a)
        .map(|p| (p.r, p.c, p.rs, p.cs))
        .ok_or(LayoutError::PaneNotFound)?;
    let pb = s
        .pane(b)
        .map(|p| (p.r, p.c, p.rs, p.cs))
        .ok_or(LayoutError::PaneNotFound)?;

    {
        let x = s.pane_mut(a).expect("checked above");
        x.r = pb.0;
        x.c = pb.1;
        x.rs = pb.2;
        x.cs = pb.3;
    }
    {
        let y = s.pane_mut(b).expect("checked above");
        y.r = pa.0;
        y.c = pa.1;
        y.rs = pa.2;
        y.cs = pa.3;
    }
    Ok(())
}

/// 모든 창이 짝수 트랙에 정렬돼 있으면 그리드를 절반으로 접는다. 최대 4회.
pub fn normalize(s: &mut Session) {
    for _ in 0..4 {
        let foldable =
            s.grid.cols > 1 && s.panes.iter().all(|p| (p.c - 1) % 2 == 0 && p.cs % 2 == 0);
        if !foldable {
            break;
        }
        s.grid.cols /= 2;
        s.grid.col_weights = fold(&s.grid.col_weights);
        s.grid.fix();
        for p in &mut s.panes {
            p.c = (p.c - 1) / 2 + 1;
            p.cs /= 2;
        }
    }
    for _ in 0..4 {
        let foldable =
            s.grid.rows > 1 && s.panes.iter().all(|p| (p.r - 1) % 2 == 0 && p.rs % 2 == 0);
        if !foldable {
            break;
        }
        s.grid.rows /= 2;
        s.grid.row_weights = fold(&s.grid.row_weights);
        s.grid.fix();
        for p in &mut s.panes {
            p.r = (p.r - 1) / 2 + 1;
            p.rs /= 2;
        }
    }
}

/// 경계를 끌어 정해진 트랙 몫으로 바꾼다. 길이는 트랙 수와 같아야 한다.
pub fn set_weights(s: &mut Session, axis: TrackAxis, weights: Vec<f32>) -> Result<(), LayoutError> {
    let expected = match axis {
        TrackAxis::Col => s.grid.cols as usize,
        TrackAxis::Row => s.grid.rows as usize,
    };
    if weights.len() != expected {
        return Err(LayoutError::WeightCountMismatch);
    }
    match axis {
        TrackAxis::Col => s.grid.col_weights = weights,
        TrackAxis::Row => s.grid.row_weights = weights,
    }
    s.grid.fix();
    Ok(())
}

/// 모든 트랙을 다시 같은 몫으로 되돌린다.
pub fn reset_weights(s: &mut Session) {
    s.grid.col_weights = vec![1.0; s.grid.cols as usize];
    s.grid.row_weights = vec![1.0; s.grid.rows as usize];
}

/// 창을 닫아 같은 자리의 빈 블럭으로 되돌린다. 새 빈 블럭의 id 를 돌려준다.
pub fn close_pane(s: &mut Session, pane_id: &str) -> Result<String, LayoutError> {
    let idx = s
        .panes
        .iter()
        .position(|p| p.id == pane_id)
        .ok_or(LayoutError::PaneNotFound)?;
    let fresh = s.panes[idx].cleared();
    let new_id = fresh.id.clone();
    s.panes[idx] = fresh;
    Ok(new_id)
}

/// 새 내용을 대상 빈 블럭 자리에 끼워 넣는다 (디자인의 addPane).
/// 대상이 없으면 첫 빈 블럭, 그마저 없으면 None — 호출부가 토스트를 띄운다.
pub fn place_pane(s: &mut Session, mut pane: Pane, target_id: Option<&str>) -> Option<String> {
    let idx = target_id
        .and_then(|id| s.panes.iter().position(|p| p.id == id))
        .or_else(|| s.panes.iter().position(|p| p.kind == PaneKind::Empty))?;

    let slot = &s.panes[idx];
    pane.r = slot.r;
    pane.c = slot.c;
    pane.rs = slot.rs;
    pane.cs = slot.cs;
    let id = pane.id.clone();
    s.panes[idx] = pane;
    Some(id)
}

/// 그리드가 비어 버리는 상황을 방어한다.
pub fn ensure_non_empty(s: &mut Session) {
    if s.panes.is_empty() {
        s.grid = Grid::new(1, 1);
        s.panes.push(Pane::empty(1, 1, 1, 1));
    }
    // 옛 스냅샷에는 몫이 없으므로 여기서 채워 넣는다.
    s.grid.fix();
}

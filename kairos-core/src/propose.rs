//! Own candidate proposer (spec 5.2 item 4).
//!
//! Proposals come from KAIROS' plan and nine features, NOT from Stockfish's
//! multi-PV list. Classes deliberately included:
//!   improve   quiet piece moves that raise coordination/flexibility
//!   reroute   moves of reserve pieces named in the plan token
//!   shadow    quiet moves that reduce the opponent's best tactical gain
//!             (null-move threat probe done with the own quiescence search)
//!   lever     pawn moves that add tension
//!   edge      flank pawn moves used as waiting / tension-adding moves
//!   check     quiet checks
//!   pawn      other quiet pawn moves
//!   release   captures and promotions (kept so the host can compare them with
//!             the quiet alternatives, i.e. so a release can be *delayed*)
//!
//! The ranking here only orders KAIROS' own list. It never overrides the
//! Stockfish soundness verdict; the host judges every proposal with
//! `go searchmoves` and applies the corridor and verification.

use std::collections::HashMap;

use crate::eval::evaluate;
use crate::features::*;
use crate::plan::Plan;
use crate::pos::*;
use crate::search::Search;
use crate::types::*;

/// Posture weight table, spec 11.4. Rows: Coil, Strike, Absorb, Reverse, Distill, Fog.
/// Columns: F_T, F_N, F_R, F_C, F_F, F_P, F_K, F_S, F_I.
pub const WEIGHTS: [[f64; 9]; 6] = [
    [2.0, 2.0, 2.0, 1.0, 2.0, 1.0, 1.0, -1.0, 1.0],
    [1.0, 1.0, 0.0, 3.0, 0.0, 0.0, 0.0, -1.0, 3.0],
    [1.0, 1.0, 1.0, 0.0, 2.0, 3.0, 3.0, 1.0, 0.0],
    [1.0, 1.0, 1.0, 2.0, 1.0, 1.0, 1.0, -1.0, 2.0],
    [-2.0, 0.0, 0.0, 0.0, 1.0, 3.0, 2.0, 3.0, 0.0],
    [2.0, 3.0, 1.0, 1.0, 1.0, 0.0, 0.0, -3.0, 1.0],
];

pub fn feature_vector(f: &Features) -> [f64; 9] {
    [f.f_t, f.f_n, f.f_r, f.f_c, f.f_f, f.f_p, f.f_k, f.f_s, f.f_i]
}

/// Sum over postures of mix[p] * sum_k W[p][k] * F_k.
pub fn weighted(mix: &[f64], f: &Features) -> f64 {
    let v = feature_vector(f);
    let mut total = 0.0;
    for p in 0..6usize {
        let m = if p < mix.len() { mix[p] } else { 0.0 };
        if m == 0.0 {
            continue;
        }
        for k in 0..9usize {
            total += m * WEIGHTS[p][k] * v[k];
        }
    }
    total
}

pub struct Proposal {
    pub mv: Mv,
    pub class: &'static str,
    pub score: f64,
    pub own_cp: Option<i32>,
    pub shadow: f64,
    pub features: Features,
}

fn enemy_gain(search: &mut Search, board: &cozy_chess::Board) -> i32 {
    let stand = evaluate(board);
    let q = search.qsearch_value(board);
    if q > stand {
        q - stand
    } else {
        0
    }
}

fn classify(pos: &Pos, plan: &Plan, m: &Mv, f: &Features, shadow: f64) -> &'static str {
    let piece = pos.sq[m.from as usize].abs();
    if f.capture || m.promo != 0 {
        return "release";
    }
    if f.gives_check {
        return "check";
    }
    if piece == 1 {
        let file = (m.from as usize) & 7;
        if f.f_t > 0.0 {
            return "lever";
        }
        if file <= 1 || file >= 6 {
            return "edge";
        }
        return "pawn";
    }
    if shadow > 0.15 {
        return "shadow";
    }
    let from_name = sq_name(m.from as usize);
    for label in plan.reserve.iter() {
        if label.ends_with(&from_name) {
            return "reroute";
        }
    }
    "improve"
}

/// Rank KAIROS' own candidates. `mix` = six posture weights (Coil..Fog).
pub fn propose(
    pos: &Pos,
    plan: &Plan,
    search: &mut Search,
    mix: &[f64],
    k: usize,
    node_budget: u64,
) -> Vec<Proposal> {
    let legal = pos.legal_moves();
    if legal.is_empty() || k == 0 {
        return Vec::new();
    }

    // Own shallow search scores per root move.
    let scored = search.root_scores(&pos.board, &pos.hist, 3, node_budget);
    let mut own: HashMap<(u8, u8, u8), i32> = HashMap::new();
    let mut best_cp = -32000;
    for (cm, s) in scored.iter() {
        let m = cmove_to_mv(&pos.board, *cm);
        own.insert((m.from, m.to, m.promo), *s);
        if *s > best_cp {
            best_cp = *s;
        }
    }
    let have_scores = !own.is_empty();

    // Threat the opponent would have if we passed.
    // VERIFY-API: cozy_chess::Board::null_move(&self) -> Option<Board>.
    let null_gain: Option<i32> = match pos.board.null_move() {
        Some(b) => Some(enemy_gain(search, &b)),
        None => None,
    };

    let mut items: Vec<Proposal> = Vec::new();
    for m in legal.iter() {
        let features = match compute_features(pos, m) {
            Some(f) => f,
            None => continue,
        };
        let own_cp = own.get(&(m.from, m.to, m.promo)).copied();
        if have_scores {
            if let Some(cp) = own_cp {
                if cp < best_cp - 120 {
                    continue; // own search says this loses material outright
                }
            }
        }
        let mut shadow = 0.0;
        if let (Some(null_value), Some(after)) = (null_gain, pos.board_after(m)) {
            let after_gain = enemy_gain(search, &after);
            shadow = clamp_f((null_value - after_gain) as f64 / 150.0, -1.0, 1.0);
        }
        let class = classify(pos, plan, m, &features, shadow);
        let style = weighted(mix, &features);
        let own_term = match own_cp {
            Some(cp) => (cp - best_cp) as f64 / 100.0,
            None => 0.0,
        };
        let plan_bonus = if plan.in_target(m.to as usize) { 0.2 } else { 0.0 };
        let score = style + 0.8 * shadow + plan_bonus + own_term;
        items.push(Proposal {
            mv: *m,
            class,
            score,
            own_cp,
            shadow,
            features,
        });
    }
    items.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Class diversity first (best of each class), then fill by score.
    let mut chosen: Vec<usize> = Vec::new();
    let mut seen: Vec<&'static str> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if chosen.len() >= (k + 1) / 2 {
            break;
        }
        if item.class == "release" {
            continue;
        }
        if !seen.contains(&item.class) {
            seen.push(item.class);
            chosen.push(i);
        }
    }
    for i in 0..items.len() {
        if chosen.len() >= k {
            break;
        }
        if !chosen.contains(&i) {
            chosen.push(i);
        }
    }
    chosen.sort();
    let mut out: Vec<Proposal> = Vec::new();
    let mut taken: Vec<Option<Proposal>> = items.into_iter().map(Some).collect();
    for i in chosen {
        if let Some(p) = taken[i].take() {
            out.push(p);
        }
    }
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

pub fn proposals_json(items: &[Proposal]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for p in items.iter() {
        let own = match p.own_cp {
            Some(v) => v.to_string(),
            None => "null".to_string(),
        };
        parts.push(format!(
            "{{\"move\":{},\"class\":{},\"score\":{},\"ownCp\":{},\"shadow\":{},\"features\":{}}}",
            json_str(&p.mv.uci()),
            json_str(p.class),
            json_num(p.score),
            own,
            json_num(p.shadow),
            features_json(&p.features)
        ));
    }
    format!("[{}]", parts.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coil_mix() -> Vec<f64> {
        vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    }

    #[test]
    fn weight_table_matches_the_specification() {
        // Spot-check against KAIROS_SPECIFICATION.md 11.4.
        assert_eq!(WEIGHTS[0][0], 2.0); // Coil F_T
        assert_eq!(WEIGHTS[1][3], 3.0); // Strike F_C
        assert_eq!(WEIGHTS[2][5], 3.0); // Absorb F_P
        assert_eq!(WEIGHTS[4][0], -2.0); // Distill F_T
        assert_eq!(WEIGHTS[5][7], -3.0); // Fog F_S
    }

    #[test]
    fn proposes_requested_number_of_legal_moves() {
        let pos = Pos::from_position_command("position startpos moves e2e4 e7e5").unwrap();
        let mut plan = Plan::new();
        plan.update(&pos, "Coil");
        let mut search = Search::new(14);
        let out = propose(&pos, &plan, &mut search, &coil_mix(), 8, 60_000);
        assert!(!out.is_empty() && out.len() <= 8);
        for p in out.iter() {
            assert!(pos.is_legal(&p.mv));
        }
    }

    #[test]
    fn quiet_position_gets_non_capture_proposals_of_several_classes() {
        let pos = Pos::from_position_command(
            "position startpos moves d2d4 d7d5 c2c4 e7e6 b1c3 g8f6",
        )
        .unwrap();
        let mut plan = Plan::new();
        plan.update(&pos, "Coil");
        let mut search = Search::new(14);
        let out = propose(&pos, &plan, &mut search, &coil_mix(), 10, 80_000);
        let quiet: Vec<&Proposal> = out.iter().filter(|p| p.class != "release").collect();
        assert!(quiet.len() >= 4);
        let mut classes: Vec<&str> = quiet.iter().map(|p| p.class).collect();
        classes.sort();
        classes.dedup();
        assert!(classes.len() >= 2, "classes: {:?}", classes);
    }

    #[test]
    fn does_not_propose_an_obvious_queen_hang() {
        let pos = Pos::from_fen("4k3/8/4p3/8/8/8/3Q4/4K3 w - - 0 1").unwrap();
        let mut plan = Plan::new();
        plan.update(&pos, "Coil");
        let mut search = Search::new(14);
        let out = propose(&pos, &plan, &mut search, &coil_mix(), 10, 80_000);
        assert!(out.iter().all(|p| p.mv.uci() != "d2d5"));
    }

    #[test]
    fn json_is_wellformed_enough() {
        let pos = Pos::startpos();
        let mut plan = Plan::new();
        plan.update(&pos, "Coil");
        let mut search = Search::new(12);
        let out = propose(&pos, &plan, &mut search, &coil_mix(), 4, 30_000);
        let text = proposals_json(&out);
        assert!(text.starts_with('[') && text.ends_with(']'));
        assert!(text.contains("\"move\""));
    }
}

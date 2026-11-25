//! kairos-core: the KAIROS board service, features, plan layer, candidate
//! proposer and small interruptible search, exported to JavaScript through
//! wasm-bindgen with a deliberately narrow, string/number-only surface.
//!
//! Structured results are returned as JSON strings built by hand (no serde),
//! so the only dependencies are `cozy-chess` and `wasm-bindgen`.

pub mod attacks;
pub mod eval;
pub mod features;
pub mod plan;
pub mod pos;
pub mod propose;
pub mod search;
pub mod types;

use wasm_bindgen::prelude::*;

use crate::features::{compute_features, features_json, forcing_density, position_stats, stats_json};
use crate::plan::Plan;
use crate::pos::{cmove_to_mv, legal_cmoves, perft, perft_uci, Pos};
use crate::propose::{propose, proposals_json};
use crate::search::Search;
use crate::types::*;

const MATE_BOUND: i32 = MATE - 100;

#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub struct Core {
    pos: Pos,
    plan: Plan,
    search: Search,
    last_error: String,
}

fn parse_mv(text: &str) -> Option<Mv> {
    Mv::parse(text.trim())
}

fn insufficient_material(sq: &[i8; 64]) -> bool {
    let mut minors = 0;
    for p in sq.iter() {
        let k = p.abs();
        if k == 1 || k == 4 || k == 5 {
            return false;
        }
        if k == 2 || k == 3 {
            minors += 1;
        }
    }
    minors <= 1
}

#[wasm_bindgen]
impl Core {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Core {
        Core {
            pos: Pos::startpos(),
            plan: Plan::new(),
            search: Search::new(16),
            last_error: String::new(),
        }
    }

    /// Replace the position from `position startpos|fen ... [moves ...]`. False + `last_error` on failure.
    pub fn set_position(&mut self, command: &str) -> bool {
        match Pos::from_position_command(command) {
            Ok(p) => {
                self.pos = p;
                self.last_error.clear();
                true
            }
            Err(e) => {
                self.last_error = e;
                false
            }
        }
    }

    pub fn last_error(&self) -> String {
        self.last_error.clone()
    }

    pub fn fen(&self) -> String {
        self.pos.to_fen()
    }

    pub fn side_to_move(&self) -> String {
        if self.pos.white_to_move() {
            "w".to_string()
        } else {
            "b".to_string()
        }
    }

    /// Space-separated legal moves in standard UCI notation.
    pub fn legal_moves(&self) -> String {
        let moves: Vec<String> = self.pos.legal_moves().iter().map(|m| m.uci()).collect();
        moves.join(" ")
    }

    pub fn is_legal(&self, mv: &str) -> bool {
        match parse_mv(mv) {
            Some(m) => self.pos.is_legal(&m),
            None => false,
        }
    }

    pub fn in_check(&self) -> bool {
        self.pos.in_check()
    }

    pub fn halfmove_clock(&self) -> u32 {
        self.pos.halfmove
    }

    /// "", "checkmate", "stalemate", "draw-50", "draw-repetition" or "draw-material".
    pub fn game_result(&self) -> String {
        if self.pos.legal_moves().is_empty() {
            return if self.pos.in_check() {
                "checkmate".to_string()
            } else {
                "stalemate".to_string()
            };
        }
        if self.pos.halfmove >= 100 {
            return "draw-50".to_string();
        }
        let h = self.pos.hash();
        let seen = self.pos.hist.iter().filter(|x| **x == h).count();
        if seen >= 2 {
            return "draw-repetition".to_string();
        }
        if insufficient_material(&self.pos.sq) {
            return "draw-material".to_string();
        }
        String::new()
    }

    /// JSON PositionStats (side-to-move view). Field names match web/src/core.ts.
    pub fn position_stats(&self) -> String {
        stats_json(&position_stats(&self.pos))
    }

    pub fn tension_index(&self) -> i32 {
        position_stats(&self.pos).tension
    }

    /// JSON features of a legal move, or "null".
    pub fn features(&self, mv: &str) -> String {
        match parse_mv(mv) {
            Some(m) => match compute_features(&self.pos, &m) {
                Some(f) => features_json(&f),
                None => "null".to_string(),
            },
            None => "null".to_string(),
        }
    }

    /// Share of checks/captures among the first six moves of a space-separated PV.
    pub fn forcing_density(&self, pv: &str) -> f64 {
        let moves: Vec<String> = pv.split_whitespace().map(|s| s.to_string()).collect();
        forcing_density(&self.pos, &moves)
    }

    /// How often the position reached by `mv` already occurred in this game; -1 if `mv` is not legal.
    pub fn repetition_count(&self, mv: &str) -> i32 {
        match parse_mv(mv) {
            Some(m) if self.pos.is_legal(&m) => self.pos.repetition_count_after(&m),
            _ => -1,
        }
    }

    pub fn resets_halfmove(&self, mv: &str) -> bool {
        match parse_mv(mv) {
            Some(m) if self.pos.is_legal(&m) => self.pos.resets_halfmove(&m),
            _ => false,
        }
    }

    /// FEN after `mv`, or "" if illegal.
    pub fn child_fen(&self, mv: &str) -> String {
        match parse_mv(mv) {
            Some(m) => self.pos.child_fen(&m).unwrap_or_default(),
            None => String::new(),
        }
    }

    /// FEN with the side flipped, or "" when the side to move is in check.
    pub fn null_fen(&self) -> String {
        self.pos.null_fen().unwrap_or_default()
    }

    pub fn apply_move(&mut self, mv: &str) -> bool {
        match parse_mv(mv) {
            Some(m) => self.pos.play(&m).is_ok(),
            None => false,
        }
    }

    pub fn new_game(&mut self) {
        self.pos = Pos::startpos();
        self.plan.reset();
        self.search.clear();
        self.last_error.clear();
    }

    /// Update the plan token for the dominant posture; returns its JSON.
    pub fn update_plan(&mut self, posture: &str) -> String {
        self.plan.update(&self.pos, posture);
        self.plan.to_json()
    }

    pub fn plan(&self) -> String {
        self.plan.to_json()
    }

    /// KAIROS' own candidates as JSON. `mix` = weights for Coil, Strike, Absorb, Reverse, Distill, Fog.
    pub fn propose(&mut self, mix: &[f64], k: u32, node_budget: u32) -> String {
        let items = propose(
            &self.pos,
            &self.plan,
            &mut self.search,
            mix,
            k as usize,
            node_budget as u64,
        );
        proposals_json(&items)
    }

    /// Begin the incremental own search from the current position.
    pub fn search_start(&mut self, max_depth: u32, node_cap: u32) {
        let root = self.pos.board.clone();
        let hist = self.pos.hist.clone();
        self.search
            .start(root, hist, max_depth as i32, node_cap as u64);
    }

    /// Run about `node_budget` nodes; JSON {"done":bool,"depth":n,"nodes":n}.
    pub fn search_step(&mut self, node_budget: u32) -> String {
        let s = self.search.step(node_budget as u64);
        format!(
            "{{\"done\":{},\"depth\":{},\"nodes\":{}}}",
            s.done, s.depth, s.nodes
        )
    }

    /// Best move of the last completed iteration as JSON, or "null" when there is none.
    pub fn own_best_move(&self) -> String {
        match self.search.best() {
            Some((cm, cp, depth)) => {
                let m = cmove_to_mv(&self.pos.board, cm);
                let mate = if cp.abs() >= MATE_BOUND {
                    let plies = MATE - cp.abs();
                    let moves = (plies + 1) / 2;
                    if cp > 0 {
                        moves.to_string()
                    } else {
                        format!("-{}", moves)
                    }
                } else {
                    "null".to_string()
                };
                format!(
                    "{{\"move\":{},\"cp\":{},\"mate\":{},\"depth\":{}}}",
                    json_str(&m.uci()),
                    cp,
                    mate,
                    depth
                )
            }
            None => "null".to_string(),
        }
    }

    /// Leaf count on the cozy board (for conformance tests in WASM). f64 avoids BigInt.
    pub fn perft(&self, depth: u32) -> f64 {
        perft(&self.pos.board, depth) as f64
    }

    /// Leaf count through the KAIROS UCI layer (castling/ep/promotion mapping).
    pub fn perft_uci(&self, depth: u32) -> f64 {
        perft_uci(&self.pos, depth) as f64
    }

    pub fn legal_move_count(&self) -> u32 {
        legal_cmoves(&self.pos.board).len() as u32
    }
}

impl Default for Core {
    fn default() -> Self {
        Core::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_api_smoke() {
        let mut core = Core::new();
        assert!(core.set_position("position startpos moves e2e4 e7e5"));
        assert_eq!(core.side_to_move(), "w");
        assert!(core.is_legal("g1f3"));
        assert!(!core.is_legal("e2e4"));
        assert_eq!(core.legal_move_count(), 29);
        assert!(core.features("g1f3").contains("\"F_T\""));
        assert_eq!(core.features("e2e4"), "null");
        assert_eq!(core.game_result(), "");
        assert_eq!(core.repetition_count("g1f3"), 0);
        assert!(!core.set_position("position startpos moves e2e5"));
        assert!(!core.last_error().is_empty());
    }

    #[test]
    fn standalone_search_through_the_api() {
        let mut core = Core::new();
        core.set_position("position startpos");
        core.search_start(4, 200_000);
        let mut guard = 0;
        loop {
            let status = core.search_step(10_000);
            guard += 1;
            if status.contains("\"done\":true") || guard > 1000 {
                break;
            }
        }
        let best = core.own_best_move();
        assert!(best.contains("\"move\""), "{}", best);
    }

    #[test]
    fn mate_in_one_is_reported_as_mate() {
        let mut core = Core::new();
        core.set_position(
            "position fen r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
        );
        core.search_start(4, 300_000);
        for _ in 0..200 {
            if core.search_step(20_000).contains("\"done\":true") {
                break;
            }
        }
        let best = core.own_best_move();
        assert!(best.contains("h5f7"), "{}", best);
        assert!(best.contains("\"mate\":1"), "{}", best);
    }

    #[test]
    fn game_results() {
        let mut core = Core::new();
        core.set_position("position fen 7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
        assert_eq!(core.game_result(), "stalemate");
        core.set_position("position fen 7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
        assert_eq!(core.game_result(), "checkmate");
        core.set_position("position fen 8/8/8/4k3/8/8/8/4K3 w - - 0 1");
        assert_eq!(core.game_result(), "draw-material");
    }
}

//! KAIROS' own shallow search.
//!
//! Scope guard (spec 3.1): this exists to (a) rank and sanity-check KAIROS' own
//! candidate proposals and (b) keep the page playable when Stockfish is not
//! available. It is iterative deepening + PVS + a transposition table +
//! quiescence + basic move ordering. No null-move, no tuning, no strength goals.
//!
//! Interruptibility: `start` / `step(node_budget)`. A step aborts the current
//! iteration when its node budget is used; the transposition table keeps the
//! finished subtrees, so the next step re-enters the same depth cheaply. The
//! best move of the last COMPLETED iteration is always available.

use cozy_chess::{Board, Move as CMove, Piece};

use crate::eval::evaluate;
use crate::pos::{idx_of, in_check, is_capture, legal_cmoves, piece_code};
use crate::types::*;

const INF: i32 = 32000;
const MAX_PLY: usize = 64;
const MATE_BOUND: i32 = MATE - 100;

#[derive(Clone, Copy)]
struct TtEntry {
    key: u64,
    depth: i32,
    score: i32,
    flag: u8, // 0 exact, 1 lower bound, 2 upper bound
    mv: Option<CMove>,
}

impl TtEntry {
    fn empty() -> TtEntry {
        TtEntry {
            key: 0,
            depth: -1,
            score: 0,
            flag: 0,
            mv: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StepStatus {
    pub done: bool,
    pub depth: i32,
    pub nodes: u64,
}

pub struct Search {
    tt: Vec<TtEntry>,
    tt_mask: usize,
    killers: Vec<[Option<CMove>; 2]>,
    history: Vec<i32>,
    path: Vec<u64>,
    game_hist: Vec<u64>,
    nodes: u64,
    start_nodes: u64,
    step_limit: u64,
    aborted: bool,
    root: Option<Board>,
    root_order: Vec<CMove>,
    iter_depth: i32,
    max_depth: i32,
    node_cap: u64,
    best: Option<(CMove, i32, i32)>,
    done: bool,
}

fn score_to_tt(score: i32, ply: usize) -> i32 {
    if score > MATE_BOUND {
        score + ply as i32
    } else if score < -MATE_BOUND {
        score - ply as i32
    } else {
        score
    }
}

fn score_from_tt(score: i32, ply: usize) -> i32 {
    if score > MATE_BOUND {
        score - ply as i32
    } else if score < -MATE_BOUND {
        score + ply as i32
    } else {
        score
    }
}

impl Search {
    pub fn new(tt_bits: u32) -> Search {
        let size = 1usize << tt_bits;
        Search {
            tt: vec![TtEntry::empty(); size],
            tt_mask: size - 1,
            killers: vec![[None, None]; MAX_PLY + 2],
            history: vec![0; 2 * 64 * 64],
            path: Vec::new(),
            game_hist: Vec::new(),
            nodes: 0,
            start_nodes: 0,
            step_limit: 0,
            aborted: false,
            root: None,
            root_order: Vec::new(),
            iter_depth: 1,
            max_depth: 1,
            node_cap: 0,
            best: None,
            done: true,
        }
    }

    pub fn clear(&mut self) {
        for e in self.tt.iter_mut() {
            *e = TtEntry::empty();
        }
        for k in self.killers.iter_mut() {
            *k = [None, None];
        }
        for h in self.history.iter_mut() {
            *h = 0;
        }
        self.root = None;
        self.best = None;
        self.done = true;
    }

    fn is_repetition(&self, hash: u64, path_len_before: usize) -> bool {
        for earlier in self.path.iter().take(path_len_before) {
            if *earlier == hash {
                return true;
            }
        }
        let skip = if self.game_hist.len() > 60 {
            self.game_hist.len() - 60
        } else {
            0
        };
        for earlier in self.game_hist.iter().skip(skip) {
            if *earlier == hash {
                return true;
            }
        }
        false
    }

    fn history_index(board: &Board, m: &CMove) -> usize {
        let color = if board.side_to_move() == cozy_chess::Color::White {
            0
        } else {
            1
        };
        color * 4096 + idx_of(m.from) * 64 + idx_of(m.to)
    }

    fn order(&self, board: &Board, moves: &mut Vec<CMove>, tt_move: Option<CMove>, ply: usize) {
        let mut scored: Vec<(i32, CMove)> = Vec::with_capacity(moves.len());
        for m in moves.iter() {
            let mut score = 0;
            if tt_move == Some(*m) {
                score = 1_000_000;
            } else if is_capture(board, m) {
                let victim = match board.piece_on(m.to) {
                    Some(p) => piece_code(p) as i32,
                    None => 1,
                };
                let attacker = match board.piece_on(m.from) {
                    Some(p) => piece_code(p) as i32,
                    None => 1,
                };
                score = 100_000 + 10 * victim - attacker;
            } else if let Some(p) = m.promotion {
                score = 90_000 + piece_code(p) as i32;
            } else if ply < self.killers.len() && self.killers[ply][0] == Some(*m) {
                score = 80_000;
            } else if ply < self.killers.len() && self.killers[ply][1] == Some(*m) {
                score = 79_000;
            } else {
                score += self.history[Search::history_index(board, m)];
            }
            scored.push((score, *m));
        }
        scored.sort_by(|a, b| b.0.cmp(&a.0));
        moves.clear();
        for (_, m) in scored {
            moves.push(m);
        }
    }

    fn negamax(&mut self, board: &Board, depth: i32, alpha: i32, beta: i32, ply: usize) -> i32 {
        let hash = board.hash();
        let before = self.path.len();
        self.path.push(hash);
        let result = self.negamax_inner(board, depth, alpha, beta, ply, hash, before);
        self.path.pop();
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn negamax_inner(
        &mut self,
        board: &Board,
        depth_in: i32,
        mut alpha: i32,
        beta: i32,
        ply: usize,
        hash: u64,
        path_len_before: usize,
    ) -> i32 {
        if self.aborted {
            return 0;
        }
        self.nodes += 1;
        if self.nodes >= self.step_limit {
            self.aborted = true;
            return 0;
        }
        if ply >= MAX_PLY - 1 {
            return evaluate(board);
        }
        if ply > 0 {
            // VERIFY-API: cozy_chess Board::halfmove_clock() -> u8.
            if board.halfmove_clock() >= 100 {
                return 0;
            }
            if self.is_repetition(hash, path_len_before) {
                return 0;
            }
        }
        let checked = in_check(board);
        let mut depth = depth_in;
        if checked {
            depth += 1;
        }
        if depth <= 0 {
            return self.qsearch(board, alpha, beta, ply, 0);
        }

        let mut tt_move: Option<CMove> = None;
        let slot = (hash as usize) & self.tt_mask;
        let entry = self.tt[slot];
        if entry.key == hash {
            tt_move = entry.mv;
            if ply > 0 && entry.depth >= depth {
                let s = score_from_tt(entry.score, ply);
                if entry.flag == 0 {
                    return s;
                }
                if beta - alpha == 1 {
                    if entry.flag == 1 && s >= beta {
                        return s;
                    }
                    if entry.flag == 2 && s <= alpha {
                        return s;
                    }
                }
            }
        }

        let mut moves = legal_cmoves(board);
        if moves.is_empty() {
            return if checked { -MATE + ply as i32 } else { 0 };
        }
        self.order(board, &mut moves, tt_move, ply);

        let alpha_orig = alpha;
        let mut best_score = -INF;
        let mut best_move: Option<CMove> = None;
        for (i, m) in moves.iter().enumerate() {
            let quiet = !is_capture(board, m) && m.promotion.is_none();
            let mut next = board.clone();
            next.play_unchecked(*m);
            let new_depth = depth - 1;
            let mut score;
            if i == 0 {
                score = -self.negamax(&next, new_depth, -beta, -alpha, ply + 1);
            } else {
                let mut reduction = 0;
                if depth >= 3 && i >= 4 && quiet && !checked && !in_check(&next) {
                    reduction = 1;
                }
                score = -self.negamax(&next, new_depth - reduction, -alpha - 1, -alpha, ply + 1);
                if score > alpha && reduction > 0 {
                    score = -self.negamax(&next, new_depth, -alpha - 1, -alpha, ply + 1);
                }
                if score > alpha && score < beta {
                    score = -self.negamax(&next, new_depth, -beta, -alpha, ply + 1);
                }
            }
            if self.aborted {
                return 0;
            }
            if score > best_score {
                best_score = score;
                best_move = Some(*m);
            }
            if score > alpha {
                alpha = score;
            }
            if alpha >= beta {
                if quiet {
                    if self.killers[ply][0] != Some(*m) {
                        self.killers[ply][1] = self.killers[ply][0];
                        self.killers[ply][0] = Some(*m);
                    }
                    let hi = Search::history_index(board, m);
                    let bonus = depth * depth;
                    self.history[hi] = std::cmp::min(self.history[hi] + bonus, 50_000);
                }
                break;
            }
        }

        let flag = if best_score <= alpha_orig {
            2
        } else if best_score >= beta {
            1
        } else {
            0
        };
        self.tt[slot] = TtEntry {
            key: hash,
            depth,
            score: score_to_tt(best_score, ply),
            flag,
            mv: best_move,
        };
        best_score
    }

    fn qsearch(&mut self, board: &Board, alpha_in: i32, beta: i32, ply: usize, qd: i32) -> i32 {
        if self.aborted {
            return 0;
        }
        self.nodes += 1;
        if self.nodes >= self.step_limit {
            self.aborted = true;
            return 0;
        }
        let mut alpha = alpha_in;
        let checked = in_check(board);
        let stand = evaluate(board);
        if ply >= MAX_PLY - 1 || qd >= 10 {
            return stand;
        }
        let mut best = if checked { -INF } else { stand };
        if !checked {
            if stand >= beta {
                return stand;
            }
            if stand > alpha {
                alpha = stand;
            }
        }
        let mut moves = legal_cmoves(board);
        if moves.is_empty() {
            return if checked { -MATE + ply as i32 } else { 0 };
        }
        self.order(board, &mut moves, None, ply);
        for m in moves.iter() {
            let capture = is_capture(board, m);
            let promotion = m.promotion.is_some();
            if !checked && !capture && !promotion {
                continue;
            }
            if !checked && capture && !promotion {
                let victim = match board.piece_on(m.to) {
                    Some(p) => PIECE_VALUE_CP[piece_code(p) as usize],
                    None => 100,
                };
                if stand + victim + 200 < alpha {
                    continue;
                }
            }
            let mut next = board.clone();
            next.play_unchecked(*m);
            let score = -self.qsearch(&next, -beta, -alpha, ply + 1, qd + 1);
            if self.aborted {
                return 0;
            }
            if score > best {
                best = score;
                if score > alpha {
                    alpha = score;
                }
            }
            if alpha >= beta {
                break;
            }
        }
        best
    }

    fn search_root(&mut self, depth: i32) -> Option<(CMove, i32)> {
        let root = match &self.root {
            Some(b) => b.clone(),
            None => return None,
        };
        let order = self.root_order.clone();
        self.path.clear();
        self.path.push(root.hash());
        let mut alpha = -INF;
        let beta = INF;
        let mut best_move: Option<CMove> = None;
        let mut best_score = -INF;
        for (i, m) in order.iter().enumerate() {
            let mut next = root.clone();
            next.play_unchecked(*m);
            let mut score;
            if i == 0 {
                score = -self.negamax(&next, depth - 1, -beta, -alpha, 1);
            } else {
                score = -self.negamax(&next, depth - 1, -alpha - 1, -alpha, 1);
                if score > alpha && score < beta {
                    score = -self.negamax(&next, depth - 1, -beta, -alpha, 1);
                }
            }
            if self.aborted {
                return None;
            }
            if score > best_score {
                best_score = score;
                best_move = Some(*m);
            }
            if score > alpha {
                alpha = score;
            }
        }
        match best_move {
            Some(bm) => {
                if let Some(pos) = self.root_order.iter().position(|x| *x == bm) {
                    let moved = self.root_order.remove(pos);
                    self.root_order.insert(0, moved);
                }
                Some((bm, best_score))
            }
            None => None,
        }
    }

    /// Begin an incremental search from `root`. `game_hist` = hashes of earlier game positions.
    pub fn start(&mut self, root: Board, game_hist: Vec<u64>, max_depth: i32, node_cap: u64) {
        self.game_hist = game_hist;
        self.max_depth = std::cmp::max(1, std::cmp::min(max_depth, 40));
        self.node_cap = std::cmp::max(2000, node_cap);
        self.start_nodes = self.nodes;
        self.iter_depth = 1;
        self.best = None;
        self.aborted = false;
        let mut moves = legal_cmoves(&root);
        self.order(&root, &mut moves, None, 0);
        self.done = moves.is_empty();
        if let Some(first) = moves.first() {
            self.best = Some((*first, 0, 0));
        }
        self.root_order = moves;
        self.root = Some(root);
    }

    pub fn status(&self) -> StepStatus {
        StepStatus {
            done: self.done,
            depth: match self.best {
                Some((_, _, d)) => d,
                None => 0,
            },
            nodes: self.nodes - self.start_nodes,
        }
    }

    /// Run at most about `step_nodes` nodes. Returns the status afterwards.
    pub fn step(&mut self, step_nodes: u64) -> StepStatus {
        if self.done || self.root.is_none() {
            return self.status();
        }
        let cap_limit = self.start_nodes + self.node_cap;
        loop {
            if self.iter_depth > self.max_depth || self.nodes >= cap_limit {
                self.done = true;
                break;
            }
            self.aborted = false;
            let budget = std::cmp::max(step_nodes, 1000);
            self.step_limit = std::cmp::min(self.nodes + budget, cap_limit);
            match self.search_root(self.iter_depth) {
                Some((m, score)) => {
                    self.best = Some((m, score, self.iter_depth));
                    self.iter_depth += 1;
                    if score.abs() >= MATE_BOUND {
                        self.done = true;
                        break;
                    }
                    if self.nodes >= self.step_limit {
                        break;
                    }
                }
                None => {
                    if self.nodes >= cap_limit {
                        self.done = true;
                    }
                    break;
                }
            }
        }
        self.status()
    }

    /// Best move of the last completed iteration: (move, centipawns or mate score, depth).
    pub fn best(&self) -> Option<(CMove, i32, i32)> {
        self.best
    }

    /// Score every legal root move with a full window (used to rank proposals).
    /// Falls back to shallower depths when the node budget is exhausted.
    pub fn root_scores(
        &mut self,
        board: &Board,
        hist: &[u64],
        depth: i32,
        node_budget: u64,
    ) -> Vec<(CMove, i32)> {
        self.game_hist = hist.to_vec();
        let moves = legal_cmoves(board);
        let mut d = std::cmp::max(1, depth);
        loop {
            self.aborted = false;
            self.step_limit = self.nodes + std::cmp::max(node_budget, 20_000);
            self.path.clear();
            self.path.push(board.hash());
            let mut out: Vec<(CMove, i32)> = Vec::new();
            let mut complete = true;
            for m in moves.iter() {
                let mut next = board.clone();
                next.play_unchecked(*m);
                let score = -self.negamax(&next, d - 1, -INF, INF, 1);
                if self.aborted {
                    complete = false;
                    break;
                }
                out.push((*m, score));
            }
            if complete || d <= 1 {
                return out;
            }
            d -= 1;
        }
    }

    /// Quiescence value from the side to move's point of view.
    pub fn qsearch_value(&mut self, board: &Board) -> i32 {
        self.aborted = false;
        self.step_limit = self.nodes + 20_000;
        self.path.clear();
        self.path.push(board.hash());
        let v = self.qsearch(board, -INF, INF, 0, 0);
        if self.aborted {
            evaluate(board)
        } else {
            v
        }
    }
}

/// Is this cozy piece a pawn? (small helper for callers that avoid importing Piece)
pub fn is_pawn(board: &Board, m: &CMove) -> bool {
    board.piece_on(m.from) == Some(Piece::Pawn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pos::{cmove_to_mv, Pos};

    fn best_uci(fen: &str, depth: i32, nodes: u64) -> (String, i32) {
        let pos = Pos::from_fen(fen).unwrap();
        let mut s = Search::new(14);
        s.start(pos.board.clone(), pos.hist.clone(), depth, nodes);
        let mut guard = 0;
        while !s.status().done && guard < 10_000 {
            s.step(20_000);
            guard += 1;
        }
        let (m, score, _) = s.best().expect("best move");
        (cmove_to_mv(&pos.board, m).uci(), score)
    }

    #[test]
    fn finds_scholars_mate() {
        let (mv, score) = best_uci(
            "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
            4,
            500_000,
        );
        assert_eq!(mv, "h5f7");
        assert!(score >= MATE_BOUND, "score {}", score);
    }

    #[test]
    fn finds_ladder_mate_in_two() {
        let (mv, score) = best_uci("7k/8/8/8/8/8/R7/1R4K1 w - - 0 1", 6, 2_000_000);
        assert!(mv == "a2a7" || mv == "b1b7", "played {}", mv);
        assert!(score >= MATE_BOUND, "score {}", score);
    }

    #[test]
    fn does_not_hang_the_queen() {
        // Qd2-d5?? would lose the queen to the pawn on e6; Qd2 must not walk into it.
        let (mv, _) = best_uci("4k3/8/4p3/8/8/8/3Q4/4K3 w - - 0 1", 4, 200_000);
        assert_ne!(mv, "d2d5");
    }

    #[test]
    fn always_returns_a_legal_move_with_tiny_budget() {
        let pos = Pos::startpos();
        let mut s = Search::new(12);
        s.start(pos.board.clone(), Vec::new(), 8, 2000);
        s.step(1000);
        let (m, _, _) = s.best().expect("a move exists");
        assert!(pos.is_legal(&cmove_to_mv(&pos.board, m)));
    }

    #[test]
    fn stalemate_has_no_move() {
        let pos = Pos::from_fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").unwrap();
        let mut s = Search::new(10);
        s.start(pos.board.clone(), Vec::new(), 4, 10_000);
        assert!(s.status().done);
        assert!(s.best().is_none());
    }

    #[test]
    fn step_is_resumable() {
        let pos = Pos::startpos();
        let mut s = Search::new(16);
        s.start(pos.board.clone(), Vec::new(), 5, 400_000);
        let mut steps = 0;
        while !s.status().done && steps < 2000 {
            s.step(5_000);
            steps += 1;
        }
        assert!(s.status().done);
        let (_, _, depth) = s.best().unwrap();
        assert!(depth >= 3, "depth {}", depth);
    }
}

//! Position analysis and the nine KAIROS features (spec 11.3), computed on the
//! mailbox with real attack maps, SEE, pins/x-rays and king-zone counts.
//!
//! Definitions (see docs/FEATURES_CHANGELOG.md for how they differ from the
//! v0.2.1 static proxies):
//!   T    Tension Index = pawn levers + near-zero-SEE piece conflicts
//!        + pins/x-rays against more valuable pieces + contested open files (cap 12).
//!   F_T  change in T after the move; penalty 0.25 when the move resolves a
//!        lever/capture while its release value (SEE) is <= 0.
//!   F_R  count of uncommitted pieces with >= 2 safe destinations, /5.
//!   F_C  change in coordination (mutual protection + king-zone attackers + 2*batteries), /6.
//!   F_F  change in flexibility (safe mobility + 3*pawn breaks), /12.
//!   F_K  change in own king margin (defenders - attackers of the king zone), /4.
//!   F_S  simplification: material traded in the capture/recapture, /9 pawns,
//!        +0.3 when queens come off.
//!   F_I  change in forcing-move difference (checks, SEE>=0 captures, threats), /6.
//!   F_N, F_P are probe features measured by the host with Stockfish; 0 here.

use crate::attacks::*;
use crate::pos::*;
use crate::types::*;

pub struct Maps {
    pub att: [[u8; 64]; 2],
}

pub fn ci(white: bool) -> usize {
    if white {
        0
    } else {
        1
    }
}

pub fn build_maps(sq: &[i8; 64]) -> Maps {
    let mut att = [[0u8; 64]; 2];
    for s in 0..64usize {
        let p = sq[s];
        if p == 0 {
            continue;
        }
        let c = ci(p > 0);
        for t in attacks_from(sq, s) {
            att[c][t] = att[c][t].saturating_add(1);
        }
    }
    Maps { att }
}

pub fn king_zone(ks: Sq) -> [bool; 64] {
    let mut zone = [false; 64];
    for dr in -1..=1 {
        for df in -1..=1 {
            if let Some(t) = step(ks, df, dr) {
                zone[t] = true;
            }
        }
    }
    zone
}

/// (defenders, attackers) of `white`'s king zone (3x3 around the king).
pub fn king_margin(sq: &[i8; 64], white: bool) -> (i32, i32) {
    let ks = match king_square(sq, white) {
        Some(k) => k,
        None => return (0, 0),
    };
    let zone = king_zone(ks);
    let mut defenders = 0;
    let mut attackers = 0;
    for s in 0..64usize {
        let p = sq[s];
        if p == 0 || p.abs() == 6 {
            continue;
        }
        let touches = zone[s] || attacks_from(sq, s).iter().any(|t| zone[*t]);
        if !touches {
            continue;
        }
        if (p > 0) == white {
            defenders += 1;
        } else {
            attackers += 1;
        }
    }
    (defenders, attackers)
}

pub fn phase(sq: &[i8; 64]) -> f64 {
    let mut total = 0;
    for p in sq.iter() {
        let k = p.abs();
        if k >= 2 && k <= 5 {
            total += value_of(*p) / 100;
        }
    }
    clamp_f(total as f64 / 62.0, 0.0, 1.0)
}

/// Material balance in pawn units from `white`'s point of view (N=B=3, R=5, Q=9).
pub fn material_balance(sq: &[i8; 64], white: bool) -> f64 {
    let mut total = 0.0;
    for p in sq.iter() {
        let k = p.abs();
        if k == 0 || k == 6 {
            continue;
        }
        let v = match k {
            1 => 1.0,
            2 | 3 => 3.0,
            4 => 5.0,
            _ => 9.0,
        };
        if (*p > 0) == white {
            total += v;
        } else {
            total -= v;
        }
    }
    total
}

pub fn lever_count(sq: &[i8; 64]) -> i32 {
    let mut n = 0;
    for s in 0..64usize {
        if sq[s] == 1 {
            for df in [-1, 1] {
                if let Some(t) = step(s, df, 1) {
                    if sq[t] == -1 {
                        n += 1;
                    }
                }
            }
        }
    }
    n
}

/// Sliders aimed through an enemy piece at a more valuable enemy piece (pins and x-rays, king included).
pub fn pin_count(sq: &[i8; 64]) -> i32 {
    let mut n = 0;
    for s in 0..64usize {
        let p = sq[s];
        let k = p.abs();
        if !(3..=5).contains(&k) {
            continue;
        }
        let white = p > 0;
        let mut dirs: Vec<(i32, i32)> = Vec::new();
        if k == 4 || k == 5 {
            dirs.extend_from_slice(&ROOK_D);
        }
        if k == 3 || k == 5 {
            dirs.extend_from_slice(&BISHOP_D);
        }
        for (df, dr) in dirs {
            if let Some(a) = first_on_ray(sq, s, df, dr) {
                if (sq[a] > 0) != white {
                    if let Some(b) = first_on_ray(sq, a, df, dr) {
                        if (sq[b] > 0) != white && value_of(sq[b]) > value_of(sq[a]) {
                            n += 1;
                        }
                    }
                }
            }
        }
    }
    n
}

/// Pieces (not pawns/kings) attacked by the enemy where the exchange is close to even.
pub fn exchange_conflicts(sq: &[i8; 64], maps: &Maps) -> i32 {
    let mut n = 0;
    for s in 0..64usize {
        let p = sq[s];
        let k = p.abs();
        if k < 2 || k == 6 {
            continue;
        }
        let enemy = p < 0; // the enemy of this piece is white when the piece is black
        if maps.att[ci(enemy)][s] == 0 {
            continue;
        }
        if let Some(attacker) = least_attacker(sq, s, enemy) {
            let net = see_capture(sq, s, enemy, attacker);
            if net.abs() <= 60 {
                n += 1;
            }
        }
    }
    n
}

pub fn key_file_contest(sq: &[i8; 64]) -> i32 {
    let mut n = 0;
    for f in 0..8usize {
        let mut pawns = false;
        let mut white_major = false;
        let mut black_major = false;
        for r in 0..8usize {
            let p = sq[r * 8 + f];
            if p.abs() == 1 {
                pawns = true;
            }
            if p == 4 || p == 5 {
                white_major = true;
            }
            if p == -4 || p == -5 {
                black_major = true;
            }
        }
        if !pawns && white_major && black_major {
            n += 1;
        }
    }
    n
}

pub fn tension_index(sq: &[i8; 64], maps: &Maps) -> i32 {
    let total =
        lever_count(sq) + exchange_conflicts(sq, maps) + pin_count(sq) + key_file_contest(sq);
    std::cmp::min(12, total)
}

/// Destinations a non-pawn piece can reach without losing material.
pub fn safe_targets(sq: &[i8; 64], from: Sq) -> Vec<Sq> {
    let p = sq[from];
    let k = p.abs();
    let mut out: Vec<Sq> = Vec::new();
    if k < 2 || k == 6 {
        return out;
    }
    let white = p > 0;
    for t in attacks_from(sq, from) {
        if sq[t] != 0 && (sq[t] > 0) == white {
            continue;
        }
        if landing_loss(sq, from, t) > 0 {
            continue;
        }
        out.push(t);
    }
    out
}

pub fn mobility(sq: &[i8; 64], white: bool) -> i32 {
    let mut n = 0;
    for s in 0..64usize {
        let p = sq[s];
        if p != 0 && (p > 0) == white {
            n += safe_targets(sq, s).len() as i32;
        }
    }
    n
}

/// Pawn pushes that would create a new lever against an enemy pawn.
pub fn pawn_breaks(sq: &[i8; 64], white: bool) -> i32 {
    let own: i8 = if white { 1 } else { -1 };
    let dir = if white { 1 } else { -1 };
    let start_rank = if white { 1 } else { 6 };
    let mut n = 0;
    for s in 0..64usize {
        if sq[s] != own {
            continue;
        }
        for steps in 1..=2 {
            if steps == 2 && (s >> 3) != start_rank {
                continue;
            }
            let target = match step(s, 0, dir * steps) {
                Some(t) => t,
                None => break,
            };
            if sq[target] != 0 {
                break;
            }
            for df in [-1, 1] {
                if let Some(a) = step(target, df, dir) {
                    if sq[a] == -own {
                        n += 1;
                    }
                }
            }
        }
    }
    n
}

pub fn flexibility(sq: &[i8; 64], white: bool) -> i32 {
    mobility(sq, white) + 3 * pawn_breaks(sq, white)
}

/// Pieces still "at home" (first two ranks; rooks also on pawn-closed files) with >= 2 safe destinations.
pub fn reserve_pieces(sq: &[i8; 64], white: bool) -> Vec<Sq> {
    let mut out: Vec<Sq> = Vec::new();
    for s in 0..64usize {
        let p = sq[s];
        let k = p.abs();
        if !(2..=5).contains(&k) || (p > 0) != white {
            continue;
        }
        let rank = s >> 3;
        let home = if white { rank <= 1 } else { rank >= 6 };
        let mut closed_rook_file = false;
        if k == 4 {
            let own_pawn: i8 = if white { 1 } else { -1 };
            for r in 0..8usize {
                if sq[r * 8 + (s & 7)] == own_pawn {
                    closed_rook_file = true;
                }
            }
        }
        if !(home || closed_rook_file) {
            continue;
        }
        if safe_targets(sq, s).len() >= 2 {
            out.push(s);
        }
    }
    out
}

pub fn reserve_count(sq: &[i8; 64], white: bool) -> i32 {
    reserve_pieces(sq, white).len() as i32
}

/// Same-line pairs of own sliders (battery), counted once per pair; +1 when the line continues to an enemy piece.
pub fn batteries(sq: &[i8; 64], white: bool) -> i32 {
    let mut n = 0;
    for s in 0..64usize {
        let p = sq[s];
        let k = p.abs();
        if !(3..=5).contains(&k) || (p > 0) != white {
            continue;
        }
        let mut dirs: Vec<(i32, i32)> = Vec::new();
        if k == 4 || k == 5 {
            dirs.extend_from_slice(&ROOK_D);
        }
        if k == 3 || k == 5 {
            dirs.extend_from_slice(&BISHOP_D);
        }
        for (df, dr) in dirs {
            if let Some(a) = first_on_ray(sq, s, df, dr) {
                if a <= s || (sq[a] > 0) != white {
                    continue;
                }
                let q = sq[a].abs();
                let straight = df == 0 || dr == 0;
                let compatible = if straight { q == 4 || q == 5 } else { q == 3 || q == 5 };
                if compatible {
                    n += 1;
                    if let Some(b) = first_on_ray(sq, a, df, dr) {
                        if (sq[b] > 0) != white {
                            n += 1;
                        }
                    }
                }
            }
        }
    }
    n
}

pub fn coordination(sq: &[i8; 64], maps: &Maps, white: bool) -> i32 {
    let mut mutual = 0;
    for s in 0..64usize {
        let p = sq[s];
        if p == 0 || p.abs() == 6 || (p > 0) != white {
            continue;
        }
        if maps.att[ci(white)][s] > 0 {
            mutual += 1;
        }
    }
    let (_, king_attackers) = king_margin(sq, !white);
    mutual + king_attackers + 2 * batteries(sq, white)
}

/// For each piece kind 1..=5: squares from which that kind (of colour `attacker_white`) gives check to the enemy king.
fn check_squares(sq: &[i8; 64], king: Sq, attacker_white: bool) -> [[bool; 64]; 6] {
    let mut out = [[false; 64]; 6];
    let pawn_dr = if attacker_white { -1 } else { 1 };
    for df in [-1, 1] {
        if let Some(t) = step(king, df, pawn_dr) {
            out[1][t] = true;
        }
    }
    for (df, dr) in KNIGHT_D.iter() {
        if let Some(t) = step(king, *df, *dr) {
            out[2][t] = true;
        }
    }
    let attacker_sign: i8 = if attacker_white { 1 } else { -1 };
    for (df, dr) in BISHOP_D.iter() {
        let mut cur = king;
        while let Some(t) = step(cur, *df, *dr) {
            if sq[t] == 0 || (sq[t] > 0) != attacker_white {
                out[3][t] = true;
                out[5][t] = true;
            }
            if sq[t] != 0 {
                break;
            }
            cur = t;
        }
    }
    for (df, dr) in ROOK_D.iter() {
        let mut cur = king;
        while let Some(t) = step(cur, *df, *dr) {
            if sq[t] == 0 || (sq[t] > 0) != attacker_white {
                out[4][t] = true;
                out[5][t] = true;
            }
            if sq[t] != 0 {
                break;
            }
            cur = t;
        }
    }
    let _ = attacker_sign;
    out
}

fn creates_threat(sq: &[i8; 64], maps: &Maps, from: Sq, to: Sq, white: bool) -> bool {
    if landing_loss(sq, from, to) > 0 {
        return false;
    }
    let mut tmp = *sq;
    let piece = tmp[from];
    tmp[from] = 0;
    tmp[to] = piece;
    let own_value = value_of(piece);
    for a in attacks_from(&tmp, to) {
        let q = tmp[a];
        if q != 0 && (q > 0) != white {
            let qv = value_of(q);
            if qv > own_value || (qv >= 300 && maps.att[ci(!white)][a] == 0) {
                return true;
            }
        }
    }
    false
}

/// Checks + captures with SEE >= 0 + at most one quiet threat per piece (static, pseudo-legal).
pub fn forcing_count(sq: &[i8; 64], maps: &Maps, white: bool) -> i32 {
    let checks = match king_square(sq, !white) {
        Some(k) => Some(check_squares(sq, k, white)),
        None => None,
    };
    let mut n = 0;
    for s in 0..64usize {
        let p = sq[s];
        if p == 0 || (p > 0) != white {
            continue;
        }
        let k = p.abs();
        let mut found_threat = false;
        for t in attacks_from(sq, s) {
            if sq[t] != 0 && (sq[t] > 0) == white {
                continue;
            }
            if sq[t] != 0 {
                if see_move(sq, s, t, false) >= 0 {
                    n += 1;
                }
                continue;
            }
            if (2..=5).contains(&k) {
                let mut is_check = false;
                if let Some(c) = &checks {
                    if c[k as usize][t] {
                        is_check = true;
                    }
                }
                if is_check {
                    n += 1;
                } else if !found_threat && creates_threat(sq, maps, s, t, white) {
                    found_threat = true;
                    n += 1;
                }
            }
        }
    }
    std::cmp::min(n, 20)
}

pub struct Stats {
    pub tension: i32,
    pub own_king_attackers: i32,
    pub own_king_defenders: i32,
    pub enemy_king_attackers: i32,
    pub enemy_king_defenders: i32,
    pub phase: f64,
    pub material_balance: f64,
}

/// Position evidence from the side to move's point of view (same field meaning as v0.2.1).
pub fn position_stats(pos: &Pos) -> Stats {
    let sq = &pos.sq;
    let white = pos.white_to_move();
    let maps = build_maps(sq);
    let (own_def, own_att) = king_margin(sq, white);
    let (enemy_def, enemy_att) = king_margin(sq, !white);
    Stats {
        tension: tension_index(sq, &maps),
        own_king_attackers: own_att,
        own_king_defenders: own_def,
        enemy_king_attackers: enemy_att,
        enemy_king_defenders: enemy_def,
        phase: phase(sq),
        material_balance: material_balance(sq, white),
    }
}

pub fn stats_json(s: &Stats) -> String {
    format!(
        "{{\"tension\":{},\"ownKingAttackers\":{},\"ownKingDefenders\":{},\"enemyKingAttackers\":{},\"enemyKingDefenders\":{},\"phase\":{},\"materialBalance\":{}}}",
        s.tension,
        s.own_king_attackers,
        s.own_king_defenders,
        s.enemy_king_attackers,
        s.enemy_king_defenders,
        json_num(s.phase),
        json_num(s.material_balance)
    )
}

#[derive(Clone, Debug)]
pub struct Features {
    pub t: i32,
    pub f_t: f64,
    pub f_n: f64,
    pub f_r: f64,
    pub f_c: f64,
    pub f_f: f64,
    pub f_p: f64,
    pub f_k: f64,
    pub f_s: f64,
    pub f_i: f64,
    pub see: i32,
    pub capture: bool,
    pub gives_check: bool,
}

/// The nine features of `m` for the side to move (probe features F_N/F_P stay 0).
pub fn compute_features(pos: &Pos, m: &Mv) -> Option<Features> {
    let cm = mv_to_cmove(&pos.board, m)?;
    let mut after_board = pos.board.clone();
    after_board.play_unchecked(cm);
    let after = mailbox_of(&after_board);
    let before = &pos.sq;
    let white = pos.white_to_move();
    let mb = build_maps(before);
    let ma = build_maps(&after);

    let from = m.from as usize;
    let to = m.to as usize;
    let moving = before[from];
    let ep = moving.abs() == 1 && (from & 7) != (to & 7) && before[to] == 0;
    let capture = before[to] != 0 || ep;
    let see = if capture { see_move(before, from, to, ep) } else { 0 };

    let t_before = tension_index(before, &mb);
    let t_after = tension_index(&after, &ma);
    let resolves = capture || lever_count(&after) < lever_count(before);
    let penalty = if resolves && see <= 0 { 0.25 } else { 0.0 };
    let f_t = clamp_f((t_after - t_before) as f64 / 4.0 - penalty, -1.0, 1.0);

    let f_r = clamp_f(reserve_count(&after, white) as f64 / 5.0, 0.0, 1.0);

    let c_delta = coordination(&after, &ma, white) - coordination(before, &mb, white);
    let f_c = clamp_f(c_delta as f64 / 6.0, -1.0, 1.0);

    let fl_delta = flexibility(&after, white) - flexibility(before, white);
    let f_f = clamp_f(fl_delta as f64 / 12.0, -1.0, 1.0);

    let (def_b, att_b) = king_margin(before, white);
    let (def_a, att_a) = king_margin(&after, white);
    let k_delta = (def_a - att_a) - (def_b - att_b);
    let f_k = clamp_f(k_delta as f64 / 4.0, -1.0, 1.0);

    let mut f_s = 0.0;
    if capture {
        let victim = if ep { 100 } else { value_of(before[to]) };
        let mover_value = value_of(moving);
        let mut tmp = *before;
        tmp[to] = moving;
        tmp[from] = 0;
        let recapture = least_attacker(&tmp, to, !white).is_some();
        let traded = victim + if recapture { mover_value } else { 0 };
        let queen_off = before[to].abs() == 5 || (recapture && moving.abs() == 5);
        f_s = traded as f64 / 900.0 + if queen_off { 0.3 } else { 0.0 };
        f_s = clamp_f(f_s, 0.0, 1.0);
    }

    let gives_check = in_check(&after_board);
    let init_before = forcing_count(before, &mb, white) - forcing_count(before, &mb, !white);
    let init_after = forcing_count(&after, &ma, white) - forcing_count(&after, &ma, !white);
    let bonus = if gives_check { 1 } else { 0 };
    let f_i = clamp_f((init_after - init_before + bonus) as f64 / 6.0, -1.0, 1.0);

    Some(Features {
        t: t_before,
        f_t,
        f_n: 0.0,
        f_r,
        f_c,
        f_f,
        f_p: 0.0,
        f_k,
        f_s,
        f_i,
        see,
        capture,
        gives_check,
    })
}

pub fn features_json(f: &Features) -> String {
    format!(
        "{{\"T\":{},\"F_T\":{},\"F_N\":{},\"F_R\":{},\"F_C\":{},\"F_F\":{},\"F_P\":{},\"F_K\":{},\"F_S\":{},\"F_I\":{},\"see\":{},\"capture\":{},\"givesCheck\":{}}}",
        f.t,
        json_num(f.f_t),
        json_num(f.f_n),
        json_num(f.f_r),
        json_num(f.f_c),
        json_num(f.f_f),
        json_num(f.f_p),
        json_num(f.f_k),
        json_num(f.f_s),
        json_num(f.f_i),
        f.see,
        f.capture,
        f.gives_check
    )
}

/// Share of checks/captures among the first six PV moves (UCI text), 0 when unparsable.
pub fn forcing_density(pos: &Pos, pv: &[String]) -> f64 {
    let mut board = pos.board.clone();
    let mut forcing = 0;
    let mut total = 0;
    for text in pv.iter().take(6) {
        let m = match Mv::parse(text) {
            Some(m) => m,
            None => break,
        };
        let cm = match mv_to_cmove(&board, &m) {
            Some(c) => c,
            None => break,
        };
        let captured = is_capture(&board, &cm);
        let mut next = board.clone();
        next.play_unchecked(cm);
        let check = in_check(&next);
        total += 1;
        if captured || check {
            forcing += 1;
        }
        board = next;
    }
    if total == 0 {
        0.0
    } else {
        forcing as f64 / total as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(fen: &str) -> Pos {
        Pos::from_fen(fen).unwrap()
    }

    #[test]
    fn startpos_is_quiet() {
        let p = Pos::startpos();
        let s = position_stats(&p);
        assert_eq!(s.tension, 0);
        assert!((s.phase - 1.0).abs() < 1e-9);
        assert!(s.material_balance.abs() < 1e-9);
    }

    #[test]
    fn mutual_pawn_levers_are_counted() {
        let sq = pos("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2").sq;
        assert_eq!(lever_count(&sq), 1);
        let maps = build_maps(&sq);
        assert!(tension_index(&sq, &maps) >= 1);
    }

    #[test]
    fn absolute_pin_counts() {
        // black knight e7 pinned against the king e8 by the rook on e1
        let sq = pos("4k3/4n3/8/8/8/8/8/4RK2 w - - 0 1").sq;
        assert!(pin_count(&sq) >= 1);
    }

    #[test]
    fn resolving_a_lever_for_nothing_is_penalised() {
        let p = pos("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
        let capture = compute_features(&p, &Mv::parse("e4d5").unwrap()).unwrap();
        let wait = compute_features(&p, &Mv::parse("g1f3").unwrap()).unwrap();
        assert!(capture.capture);
        assert!(capture.f_t <= -0.25 + 1e-9, "f_t = {}", capture.f_t);
        assert!(wait.f_t >= -1e-9, "f_t = {}", wait.f_t);
    }

    #[test]
    fn features_are_bounded_and_none_for_illegal_moves() {
        let p = Pos::startpos();
        for m in p.legal_moves() {
            let f = compute_features(&p, &m).unwrap();
            for v in [f.f_t, f.f_r, f.f_c, f.f_f, f.f_k, f.f_s, f.f_i] {
                assert!(v >= -1.0 && v <= 1.0);
            }
        }
        assert!(compute_features(&p, &Mv::parse("e2e5").unwrap()).is_none());
    }

    #[test]
    fn queen_trade_scores_as_simplification() {
        let p = pos("3qk3/8/8/8/8/8/8/3QK3 w - - 0 1");
        let f = compute_features(&p, &Mv::parse("d1d8").unwrap()).unwrap();
        assert!(f.capture);
        assert!(f.f_s >= 0.9, "f_s = {}", f.f_s);
    }

    #[test]
    fn forcing_density_counts_checks_and_captures() {
        let p = Pos::startpos();
        let pv: Vec<String> = ["e2e4", "d7d5", "e4d5", "d8d5"].iter().map(|s| s.to_string()).collect();
        let d = forcing_density(&p, &pv);
        assert!((d - 0.5).abs() < 1e-9, "d = {}", d);
    }
}

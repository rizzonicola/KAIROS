//! Attack geometry and static exchange evaluation on the mailbox
//! (`[i8; 64]`, see `types.rs`). Pure Rust, no external crate API.
//!
//! These routines are written for clarity, not speed: they are used for
//! features and candidate proposal (a dozen positions per move), never inside
//! the search hot path.

use crate::types::*;

pub const KNIGHT_D: [(i32, i32); 8] = [
    (1, 2),
    (2, 1),
    (2, -1),
    (1, -2),
    (-1, -2),
    (-2, -1),
    (-2, 1),
    (-1, 2),
];
pub const KING_D: [(i32, i32); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];
pub const ROOK_D: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
pub const BISHOP_D: [(i32, i32); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];

/// Step from a square by (file, rank) deltas; None when it leaves the board.
pub fn step(s: Sq, df: i32, dr: i32) -> Option<Sq> {
    let f = (s & 7) as i32 + df;
    let r = (s >> 3) as i32 + dr;
    if !(0..8).contains(&f) || !(0..8).contains(&r) {
        None
    } else {
        Some((r * 8 + f) as usize)
    }
}

fn push_ray(sq: &[i8; 64], from: Sq, df: i32, dr: i32, out: &mut Vec<Sq>) {
    let mut cur = from;
    loop {
        match step(cur, df, dr) {
            Some(t) => {
                out.push(t);
                if sq[t] != 0 {
                    break;
                }
                cur = t;
            }
            None => break,
        }
    }
}

/// First occupied square along a ray (exclusive of `from`).
pub fn first_on_ray(sq: &[i8; 64], from: Sq, df: i32, dr: i32) -> Option<Sq> {
    let mut cur = from;
    loop {
        match step(cur, df, dr) {
            Some(t) => {
                if sq[t] != 0 {
                    return Some(t);
                }
                cur = t;
            }
            None => return None,
        }
    }
}

/// Squares attacked by the piece on `from`. Includes squares holding own
/// pieces (those are "defended"). Sliders stop at the first blocker (inclusive).
pub fn attacks_from(sq: &[i8; 64], from: Sq) -> Vec<Sq> {
    let piece = sq[from];
    let mut out: Vec<Sq> = Vec::new();
    if piece == 0 {
        return out;
    }
    let white = piece > 0;
    let kind = piece.abs();
    match kind {
        1 => {
            let dr = if white { 1 } else { -1 };
            for df in [-1, 1] {
                if let Some(t) = step(from, df, dr) {
                    out.push(t);
                }
            }
        }
        2 => {
            for (df, dr) in KNIGHT_D.iter() {
                if let Some(t) = step(from, *df, *dr) {
                    out.push(t);
                }
            }
        }
        6 => {
            for (df, dr) in KING_D.iter() {
                if let Some(t) = step(from, *df, *dr) {
                    out.push(t);
                }
            }
        }
        3 | 4 | 5 => {
            if kind == 4 || kind == 5 {
                for (df, dr) in ROOK_D.iter() {
                    push_ray(sq, from, *df, *dr, &mut out);
                }
            }
            if kind == 3 || kind == 5 {
                for (df, dr) in BISHOP_D.iter() {
                    push_ray(sq, from, *df, *dr, &mut out);
                }
            }
        }
        _ => {}
    }
    out
}

/// Squares of all `white`-coloured pieces that attack `target` (current occupancy).
pub fn attackers_to(sq: &[i8; 64], target: Sq, white: bool) -> Vec<Sq> {
    let sign: i8 = if white { 1 } else { -1 };
    let mut out: Vec<Sq> = Vec::new();
    let pawn_dr = if white { -1 } else { 1 };
    for df in [-1, 1] {
        if let Some(s) = step(target, df, pawn_dr) {
            if sq[s] == sign {
                out.push(s);
            }
        }
    }
    for (df, dr) in KNIGHT_D.iter() {
        if let Some(s) = step(target, *df, *dr) {
            if sq[s] == sign * 2 {
                out.push(s);
            }
        }
    }
    for (df, dr) in KING_D.iter() {
        if let Some(s) = step(target, *df, *dr) {
            if sq[s] == sign * 6 {
                out.push(s);
            }
        }
    }
    for (df, dr) in ROOK_D.iter() {
        if let Some(s) = first_on_ray(sq, target, *df, *dr) {
            if sq[s] == sign * 4 || sq[s] == sign * 5 {
                out.push(s);
            }
        }
    }
    for (df, dr) in BISHOP_D.iter() {
        if let Some(s) = first_on_ray(sq, target, *df, *dr) {
            if sq[s] == sign * 3 || sq[s] == sign * 5 {
                out.push(s);
            }
        }
    }
    out
}

fn least_valuable(sq: &[i8; 64], attackers: &[Sq]) -> Option<Sq> {
    let mut best: Option<Sq> = None;
    let mut best_value = i32::MAX;
    for a in attackers.iter() {
        let v = value_of(sq[*a]);
        if v < best_value {
            best_value = v;
            best = Some(*a);
        }
    }
    best
}

/// Least valuable attacker of `target` for the given colour.
pub fn least_attacker(sq: &[i8; 64], target: Sq, white: bool) -> Option<Sq> {
    let list = attackers_to(sq, target, white);
    least_valuable(sq, &list)
}

pub fn king_square(sq: &[i8; 64], white: bool) -> Option<Sq> {
    let want: i8 = if white { 6 } else { -6 };
    for (i, p) in sq.iter().enumerate() {
        if *p == want {
            return Some(i);
        }
    }
    None
}

/// Swap-list SEE. The piece on `first_from` (colour `side_white`) captures
/// whatever stands on `target`; both sides then recapture with their least
/// valuable attacker for as long as it pays. Returns the net material gain in
/// centipawns for the side that started the sequence (may be negative).
pub fn see_capture(sq0: &[i8; 64], target: Sq, side_white: bool, first_from: Sq) -> i32 {
    let mut sq = *sq0;
    let mut gain = [0i32; 34];
    let mut depth = 0usize;
    gain[0] = value_of(sq[target]);
    let mut from = first_from;
    let mut white = side_white;
    loop {
        let piece = sq[from];
        sq[target] = piece;
        sq[from] = 0;
        depth += 1;
        if depth >= 33 {
            break;
        }
        gain[depth] = value_of(piece) - gain[depth - 1];
        white = !white;
        match least_attacker(&sq, target, white) {
            Some(next) => from = next,
            None => break,
        }
    }
    let mut i = depth;
    while i > 1 {
        i -= 1;
        gain[i - 1] = -std::cmp::max(-gain[i - 1], gain[i]);
    }
    gain[0]
}

/// SEE of the move `from -> to` for the side owning `from` (captures only; for
/// quiet moves returns 0). `ep` marks an en-passant capture.
pub fn see_move(sq: &[i8; 64], from: Sq, to: Sq, ep: bool) -> i32 {
    let piece = sq[from];
    if piece == 0 {
        return 0;
    }
    let white = piece > 0;
    if ep {
        let mut tmp = *sq;
        tmp[to] = if white { -1 } else { 1 };
        return see_capture(&tmp, to, white, from);
    }
    if sq[to] == 0 || (sq[to] > 0) == white {
        return 0;
    }
    see_capture(sq, to, white, from)
}

/// Material the enemy would win by capturing the piece after `from -> to`
/// (0 when the landing square is safe). Quiet-move safety test.
pub fn landing_loss(sq: &[i8; 64], from: Sq, to: Sq) -> i32 {
    let piece = sq[from];
    if piece == 0 {
        return 0;
    }
    let white = piece > 0;
    let mut tmp = *sq;
    tmp[from] = 0;
    tmp[to] = piece;
    match least_attacker(&tmp, to, !white) {
        None => 0,
        Some(attacker) => {
            let net = see_capture(&tmp, to, !white, attacker);
            if net > 0 {
                net
            } else {
                0
            }
        }
    }
}

/// Is `to` attacked by an enemy pawn (given the mover's colour)?
pub fn attacked_by_pawn(sq: &[i8; 64], to: Sq, mover_white: bool) -> bool {
    let sign: i8 = if mover_white { -1 } else { 1 };
    let dr = if mover_white { 1 } else { -1 };
    for df in [-1, 1] {
        if let Some(s) = step(to, df, dr) {
            if sq[s] == sign {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pos::Pos;

    fn board(fen: &str) -> [i8; 64] {
        Pos::from_fen(fen).unwrap().sq
    }

    #[test]
    fn knight_attacks_from_corner() {
        let sq = board("4k3/8/8/8/8/8/8/N3K3 w - - 0 1");
        let mut a = attacks_from(&sq, 0);
        a.sort();
        assert_eq!(a, vec![10, 17]); // c2, b3
    }

    #[test]
    fn rook_ray_stops_at_blocker() {
        let sq = board("4k3/8/8/8/8/8/P7/R3K3 w - - 0 1");
        let a = attacks_from(&sq, 0);
        assert!(a.contains(&8)); // a2 own pawn is "defended"
        assert!(!a.contains(&16)); // blocked beyond a2
        assert!(a.contains(&3)); // d1
    }

    #[test]
    fn see_pawn_takes_defended_knight_wins_two_hundred_twenty() {
        // white pawn d4 takes black knight e5 defended by a pawn on d6
        let sq = board("4k3/8/3p4/4n3/3P4/8/8/4K3 w - - 0 1");
        assert_eq!(see_move(&sq, 27, 36, false), 220);
    }

    #[test]
    fn see_queen_takes_defended_pawn_loses() {
        // Qe2 takes pawn e5, which is defended by the pawn on d6
        let sq = board("4k3/8/3p4/4p3/8/8/4Q3/4K3 w - - 0 1");
        assert_eq!(see_move(&sq, 12, 36, false), -800);
    }

    #[test]
    fn see_undefended_piece_is_full_value() {
        let sq = board("4k3/8/8/4n3/8/8/4Q3/4K3 w - - 0 1");
        assert_eq!(see_move(&sq, 12, 36, false), 320);
    }

    #[test]
    fn landing_loss_detects_hanging_square() {
        // Ne3-f5 walks into the pawn on e6 with no defender
        let sq = board("4k3/8/4p3/8/8/4N3/8/4K3 w - - 0 1");
        assert_eq!(landing_loss(&sq, 20, 37), 320);
        assert_eq!(landing_loss(&sq, 20, 21), 0); // f3 is safe
    }
}

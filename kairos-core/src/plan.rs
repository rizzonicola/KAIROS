//! Plan layer (spec 3 "plan inertia", 7.3, 7.5).
//!
//! A plan token names a target area of the board, the pawn levers and the
//! reserve pieces that serve the current posture. It persists over several
//! engine moves and expires on a material structural change (a pawn
//! disappears, two or more pieces come off) or after a fixed age.

use crate::attacks::*;
use crate::features::*;
use crate::pos::Pos;
use crate::types::*;

pub const MAX_PLAN_AGE: u32 = 16;

#[derive(Clone, Debug)]
pub struct Plan {
    pub active: bool,
    pub posture: String,
    pub intent: String,
    pub target: String,
    pub files_lo: usize,
    pub files_hi: usize,
    pub levers: Vec<String>,
    pub reserve: Vec<String>,
    pub age: u32,
    pub expired_reason: String,
    sig_white_pawns: i32,
    sig_black_pawns: i32,
    sig_pieces: i32,
}

pub fn intent_for(posture: &str) -> &'static str {
    match posture {
        "Coil" => "hold-tension",
        "Strike" => "press-king",
        "Absorb" => "absorb-threat",
        "Reverse" => "reverse-tension",
        "Distill" => "convert",
        "Fog" => "complicate",
        _ => "hold-tension",
    }
}

fn counts(sq: &[i8; 64]) -> (i32, i32, i32) {
    let mut white_pawns = 0;
    let mut black_pawns = 0;
    let mut pieces = 0;
    for p in sq.iter() {
        match *p {
            1 => white_pawns += 1,
            -1 => black_pawns += 1,
            0 => {}
            k if k.abs() != 6 => pieces += 1,
            _ => {}
        }
    }
    (white_pawns, black_pawns, pieces)
}

fn flank(file: usize) -> (&'static str, usize, usize) {
    if file <= 2 {
        ("queenside", 0, 2)
    } else if file >= 5 {
        ("kingside", 5, 7)
    } else {
        ("center", 2, 5)
    }
}

fn pawn_has_lever(sq: &[i8; 64], s: Sq, white: bool) -> bool {
    let dir = if white { 1 } else { -1 };
    let enemy: i8 = if white { -1 } else { 1 };
    // existing lever
    for df in [-1, 1] {
        if let Some(t) = step(s, df, dir) {
            if sq[t] == enemy {
                return true;
            }
        }
    }
    // push that creates a lever
    if let Some(one) = step(s, 0, dir) {
        if sq[one] == 0 {
            for df in [-1, 1] {
                if let Some(a) = step(one, df, dir) {
                    if sq[a] == enemy {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn target_for(sq: &[i8; 64], white: bool, posture: &str) -> (&'static str, usize, usize) {
    let own_king_file = match king_square(sq, white) {
        Some(k) => k & 7,
        None => 4,
    };
    let enemy_king_file = match king_square(sq, !white) {
        Some(k) => k & 7,
        None => 4,
    };
    match posture {
        "Strike" => flank(enemy_king_file),
        "Absorb" => flank(own_king_file),
        "Reverse" | "Fog" | "Coil" | "Distill" => {
            // Prefer the flank with most lever potential; levers in the centre keep it central.
            let mut per_file = [0i32; 8];
            for s in 0..64usize {
                let own: i8 = if white { 1 } else { -1 };
                if sq[s] == own && pawn_has_lever(sq, s, white) {
                    per_file[s & 7] += 1;
                }
            }
            let center: i32 = per_file[2] + per_file[3] + per_file[4] + per_file[5];
            let queen: i32 = per_file[0] + per_file[1];
            let king: i32 = per_file[6] + per_file[7];
            if posture == "Distill" || center >= queen && center >= king {
                ("center", 2, 5)
            } else if queen > king {
                ("queenside", 0, 2)
            } else {
                ("kingside", 5, 7)
            }
        }
        _ => ("center", 2, 5),
    }
}

fn piece_label(sq: &[i8; 64], s: Sq) -> String {
    let c = piece_char(sq[s]).to_ascii_uppercase();
    format!("{}{}", c, sq_name(s))
}

impl Plan {
    pub fn new() -> Plan {
        Plan {
            active: false,
            posture: String::new(),
            intent: String::new(),
            target: String::new(),
            files_lo: 2,
            files_hi: 5,
            levers: Vec::new(),
            reserve: Vec::new(),
            age: 0,
            expired_reason: String::new(),
            sig_white_pawns: 0,
            sig_black_pawns: 0,
            sig_pieces: 0,
        }
    }

    pub fn reset(&mut self) {
        *self = Plan::new();
    }

    fn refresh_lists(&mut self, pos: &Pos) {
        let white = pos.white_to_move();
        let own: i8 = if white { 1 } else { -1 };
        self.levers.clear();
        for s in 0..64usize {
            if pos.sq[s] == own && pawn_has_lever(&pos.sq, s, white) {
                self.levers.push(sq_name(s));
            }
        }
        self.reserve.clear();
        for s in reserve_pieces(&pos.sq, white) {
            self.reserve.push(piece_label(&pos.sq, s));
        }
    }

    /// Update the token for `posture` (dominant posture after hysteresis) at `pos`
    /// (the position with the engine to move). Expires, ages or re-creates it.
    pub fn update(&mut self, pos: &Pos, posture: &str) {
        let (wp, bp, np) = counts(&pos.sq);
        if self.active {
            let structural = wp != self.sig_white_pawns
                || bp != self.sig_black_pawns
                || (np - self.sig_pieces).abs() >= 2;
            if structural {
                self.active = false;
                self.expired_reason = "structure-changed".to_string();
            } else if self.age >= MAX_PLAN_AGE {
                self.active = false;
                self.expired_reason = "aged-out".to_string();
            }
        }
        if self.active && self.posture == posture {
            self.age += 1;
            self.refresh_lists(pos);
            return;
        }
        let white = pos.white_to_move();
        let (name, lo, hi) = target_for(&pos.sq, white, posture);
        self.active = true;
        self.posture = posture.to_string();
        self.intent = intent_for(posture).to_string();
        self.target = name.to_string();
        self.files_lo = lo;
        self.files_hi = hi;
        self.age = 0;
        self.expired_reason.clear();
        self.sig_white_pawns = wp;
        self.sig_black_pawns = bp;
        self.sig_pieces = np;
        self.refresh_lists(pos);
    }

    pub fn in_target(&self, square: usize) -> bool {
        if !self.active {
            return false;
        }
        let f = square & 7;
        f >= self.files_lo && f <= self.files_hi
    }

    pub fn to_json(&self) -> String {
        let levers: Vec<String> = self.levers.iter().map(|s| json_str(s)).collect();
        let reserve: Vec<String> = self.reserve.iter().map(|s| json_str(s)).collect();
        let files = format!(
            "{}-{}",
            (b'a' + self.files_lo as u8) as char,
            (b'a' + self.files_hi as u8) as char
        );
        format!(
            "{{\"active\":{},\"posture\":{},\"intent\":{},\"target\":{},\"files\":{},\"levers\":[{}],\"reserve\":[{}],\"age\":{},\"expired\":{}}}",
            self.active,
            json_str(&self.posture),
            json_str(&self.intent),
            json_str(&self.target),
            json_str(&files),
            levers.join(","),
            reserve.join(","),
            self.age,
            json_str(&self.expired_reason)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_is_created_and_persists() {
        let mut plan = Plan::new();
        let pos = Pos::startpos();
        plan.update(&pos, "Coil");
        assert!(plan.active);
        assert_eq!(plan.intent, "hold-tension");
        assert_eq!(plan.age, 0);
        plan.update(&pos, "Coil");
        assert_eq!(plan.age, 1);
        assert!(plan.reserve.len() >= 2);
    }

    #[test]
    fn plan_expires_when_a_pawn_disappears() {
        let mut plan = Plan::new();
        let before = Pos::from_position_command("position startpos moves e2e4 d7d5").unwrap();
        plan.update(&before, "Coil");
        let after = Pos::from_position_command("position startpos moves e2e4 d7d5 e4d5").unwrap();
        plan.update(&after, "Coil");
        // expired, then re-created for the new structure
        assert!(plan.active);
        assert_eq!(plan.age, 0);
    }

    #[test]
    fn posture_change_recreates_the_plan() {
        let mut plan = Plan::new();
        let pos = Pos::startpos();
        plan.update(&pos, "Coil");
        plan.update(&pos, "Strike");
        assert_eq!(plan.posture, "Strike");
        assert_eq!(plan.intent, "press-king");
        assert_eq!(plan.age, 0);
    }

    #[test]
    fn plan_ages_out() {
        let mut plan = Plan::new();
        let pos = Pos::startpos();
        plan.update(&pos, "Coil");
        for _ in 0..(MAX_PLAN_AGE + 2) {
            plan.update(&pos, "Coil");
        }
        assert!(plan.age <= MAX_PLAN_AGE);
    }
}

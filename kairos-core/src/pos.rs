//! Board service. Legal move generation, hashing and move application come from
//! the `cozy-chess` crate (nothing is hand-written for move generation). This
//! file adds: UCI (de)serialisation incl. castling/en passant/promotion, a
//! mailbox mirror used by the feature code, FEN output, game history and
//! repetition counting.
//!
//! This is the ONLY file (together with `search.rs` / `eval.rs`) that touches
//! the cozy-chess API. Every call whose exact signature could not be checked
//! against a compiler is marked `VERIFY-API`.

use cozy_chess::{Board, Color, Move as CMove, Piece, Square};

use crate::types::*;

pub const STARTPOS_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/// Mailbox code of a cozy piece (positive).
pub fn piece_code(piece: Piece) -> i8 {
    match piece {
        Piece::Pawn => 1,
        Piece::Knight => 2,
        Piece::Bishop => 3,
        Piece::Rook => 4,
        Piece::Queen => 5,
        Piece::King => 6,
    }
}

pub fn code_to_piece(code: u8) -> Option<Piece> {
    match code {
        1 => Some(Piece::Pawn),
        2 => Some(Piece::Knight),
        3 => Some(Piece::Bishop),
        4 => Some(Piece::Rook),
        5 => Some(Piece::Queen),
        6 => Some(Piece::King),
        _ => None,
    }
}

/// KAIROS square index (rank * 8 + file) of a cozy square.
pub fn idx_of(square: Square) -> usize {
    // VERIFY-API: cozy_chess Square::file() / Square::rank() and `as usize` on File/Rank.
    (square.file() as usize) + 8 * (square.rank() as usize)
}

/// Inverse of `idx_of` by linear scan (used only at parse time, never in search).
pub fn square_of(idx: usize) -> Square {
    // VERIFY-API: cozy_chess Square::ALL ([Square; 64]) and Square::A1.
    for s in Square::ALL.iter() {
        if idx_of(*s) == idx {
            return *s;
        }
    }
    Square::A1
}

pub fn mailbox_of(board: &Board) -> [i8; 64] {
    let mut out = [0i8; 64];
    for s in Square::ALL.iter() {
        // VERIFY-API: Board::piece_on(Square) -> Option<Piece>, Board::color_on(Square) -> Option<Color>.
        if let Some(piece) = board.piece_on(*s) {
            let code = piece_code(piece);
            let white = board.color_on(*s) == Some(Color::White);
            out[idx_of(*s)] = if white { code } else { -code };
        }
    }
    out
}

/// All legal moves in cozy's own encoding (castling = king takes own rook).
pub fn legal_cmoves(board: &Board) -> Vec<CMove> {
    let mut out: Vec<CMove> = Vec::new();
    // VERIFY-API: Board::generate_moves(FnMut(PieceMoves) -> bool); PieceMoves: IntoIterator<Item = Move>.
    board.generate_moves(|piece_moves| {
        for mv in piece_moves {
            out.push(mv);
        }
        false
    });
    out
}

/// Convert a cozy move to a standard-UCI `Mv` (castling becomes e1g1/e1c1 style).
// VERIFY-API: cozy_chess Move { from: Square, to: Square, promotion: Option<Piece> } public fields,
// Move: Copy + PartialEq, Board: Clone, Board::side_to_move() -> Color. Castling is encoded as
// "king takes own rook" (assumed from cozy-chess' Chess960-style move encoding).
pub fn cmove_to_mv(board: &Board, m: CMove) -> Mv {
    let from = idx_of(m.from);
    let mut to = idx_of(m.to);
    let own = board.color_on(m.from);
    let castling = board.piece_on(m.from) == Some(Piece::King)
        && own.is_some()
        && board.color_on(m.to) == own;
    if castling {
        let rank = from >> 3;
        let king_file = from & 7;
        let rook_file = to & 7;
        let dest_file = if rook_file > king_file { 6 } else { 2 };
        to = rank * 8 + dest_file;
    }
    let promo = match m.promotion {
        Some(p) => piece_code(p) as u8,
        None => 0,
    };
    Mv {
        from: from as u8,
        to: to as u8,
        promo,
    }
}

/// Find the legal cozy move matching a standard-UCI move.
pub fn mv_to_cmove(board: &Board, m: &Mv) -> Option<CMove> {
    for c in legal_cmoves(board) {
        if cmove_to_mv(board, c) == *m {
            return Some(c);
        }
    }
    None
}

pub fn is_capture(board: &Board, m: &CMove) -> bool {
    match board.color_on(m.to) {
        Some(c) => c != board.side_to_move(),
        None => {
            board.piece_on(m.from) == Some(Piece::Pawn) && m.from.file() != m.to.file()
        }
    }
}

pub fn in_check(board: &Board) -> bool {
    // VERIFY-API: Board::checkers() -> BitBoard; BitBoard(pub u64).
    board.checkers().0 != 0
}

#[derive(Clone)]
pub struct Pos {
    pub board: Board,
    pub sq: [i8; 64],
    /// K, Q, k, q
    pub castling: [bool; 4],
    pub ep: Option<usize>,
    pub halfmove: u32,
    pub fullmove: u32,
    /// Hashes of all earlier positions of this game (not including the current one).
    pub hist: Vec<u64>,
    pub played: Vec<String>,
}

impl Pos {
    pub fn startpos() -> Pos {
        match Pos::from_fen(STARTPOS_FEN) {
            Ok(p) => p,
            Err(_) => panic!("start position must parse"),
        }
    }

    pub fn from_fen(fen: &str) -> Result<Pos, String> {
        let fields: Vec<&str> = fen.split_whitespace().collect();
        if fields.len() != 6 {
            return Err("FEN must contain six fields".to_string());
        }
        // VERIFY-API: Board::from_fen(&str, bool) -> Result<Board, _>. Alternative: fen.parse::<Board>().
        let board = match Board::from_fen(fen, false) {
            Ok(b) => b,
            Err(_) => return Err("invalid FEN".to_string()),
        };
        let sq = mailbox_of(&board);
        let rights = fields[2];
        let castling = [
            rights.contains('K'),
            rights.contains('Q'),
            rights.contains('k'),
            rights.contains('q'),
        ];
        let ep = if fields[3] == "-" {
            None
        } else {
            parse_sq(fields[3])
        };
        let halfmove = match fields[4].parse::<u32>() {
            Ok(v) => v,
            Err(_) => return Err("invalid halfmove counter".to_string()),
        };
        let fullmove = match fields[5].parse::<u32>() {
            Ok(v) => v,
            Err(_) => return Err("invalid fullmove counter".to_string()),
        };
        Ok(Pos {
            board,
            sq,
            castling,
            ep,
            halfmove,
            fullmove,
            hist: Vec::new(),
            played: Vec::new(),
        })
    }

    /// Parse `position startpos|fen <6 fields> [moves ...]`.
    pub fn from_position_command(command: &str) -> Result<Pos, String> {
        let tokens: Vec<&str> = command.split_whitespace().collect();
        if tokens.first() != Some(&"position") {
            return Err("not a position command".to_string());
        }
        let mut index;
        let mut pos;
        if tokens.get(1) == Some(&"startpos") {
            pos = Pos::startpos();
            index = 2;
        } else if tokens.get(1) == Some(&"fen") && tokens.len() >= 8 {
            pos = Pos::from_fen(&tokens[2..8].join(" "))?;
            index = 8;
        } else {
            return Err("unsupported position command".to_string());
        }
        if index < tokens.len() {
            if tokens[index] != "moves" {
                return Err("expected 'moves'".to_string());
            }
            index += 1;
            while index < tokens.len() {
                let m = match Mv::parse(tokens[index]) {
                    Some(m) => m,
                    None => return Err(format!("bad move token {}", tokens[index])),
                };
                pos.play(&m)?;
                index += 1;
            }
        }
        Ok(pos)
    }

    pub fn white_to_move(&self) -> bool {
        self.board.side_to_move() == Color::White
    }

    pub fn legal_moves(&self) -> Vec<Mv> {
        legal_cmoves(&self.board)
            .into_iter()
            .map(|c| cmove_to_mv(&self.board, c))
            .collect()
    }

    pub fn is_legal(&self, m: &Mv) -> bool {
        mv_to_cmove(&self.board, m).is_some()
    }

    pub fn in_check(&self) -> bool {
        in_check(&self.board)
    }

    pub fn hash(&self) -> u64 {
        // VERIFY-API: Board::hash() -> u64.
        self.board.hash()
    }

    /// Apply a legal move, updating the mailbox, clocks, castling rights and history.
    pub fn play(&mut self, m: &Mv) -> Result<(), String> {
        let cm = match mv_to_cmove(&self.board, m) {
            Some(c) => c,
            None => return Err(format!("illegal move {}", m.uci())),
        };
        let from = m.from as usize;
        let to = m.to as usize;
        let piece = self.sq[from];
        let white_moves = piece > 0;
        let is_pawn = piece.abs() == 1;
        let mut capture = self.sq[to] != 0;
        if is_pawn && (from & 7) != (to & 7) && self.sq[to] == 0 {
            capture = true; // en passant
        }
        if piece.abs() == 6 {
            if white_moves {
                self.castling[0] = false;
                self.castling[1] = false;
            } else {
                self.castling[2] = false;
                self.castling[3] = false;
            }
        }
        for s in [from, to] {
            match s {
                0 => self.castling[1] = false,
                7 => self.castling[0] = false,
                56 => self.castling[3] = false,
                63 => self.castling[2] = false,
                _ => {}
            }
        }
        self.ep = if is_pawn && (to as i32 - from as i32).abs() == 16 {
            Some((from + to) / 2)
        } else {
            None
        };
        self.hist.push(self.board.hash());
        // VERIFY-API: Board::play_unchecked(Move). Fallback: Board::play(Move).
        self.board.play_unchecked(cm);
        self.sq = mailbox_of(&self.board);
        self.halfmove = if is_pawn || capture { 0 } else { self.halfmove + 1 };
        if !white_moves {
            self.fullmove += 1;
        }
        self.played.push(m.uci());
        Ok(())
    }

    /// Board after `m` without touching `self`.
    pub fn board_after(&self, m: &Mv) -> Option<Board> {
        let cm = mv_to_cmove(&self.board, m)?;
        let mut next = self.board.clone();
        next.play_unchecked(cm);
        Some(next)
    }

    /// Number of times the position reached by `m` has already occurred in this game.
    pub fn repetition_count_after(&self, m: &Mv) -> i32 {
        let next = match self.board_after(m) {
            Some(b) => b,
            None => return 0,
        };
        let h = next.hash();
        let mut count = 0;
        for earlier in self.hist.iter() {
            if *earlier == h {
                count += 1;
            }
        }
        if self.board.hash() == h {
            count += 1;
        }
        count
    }

    /// True when `m` is a pawn move or a capture (resets the 50-move clock).
    pub fn resets_halfmove(&self, m: &Mv) -> bool {
        let piece = self.sq[m.from as usize];
        if piece.abs() == 1 {
            return true;
        }
        self.sq[m.to as usize] != 0
    }

    pub fn to_fen(&self) -> String {
        self.fen_with(false, false)
    }

    /// FEN of the position after a null move (side flipped, no en passant). None when in check.
    pub fn null_fen(&self) -> Option<String> {
        if self.in_check() {
            return None;
        }
        Some(self.fen_with(true, true))
    }

    pub fn child_fen(&self, m: &Mv) -> Option<String> {
        let mut child = self.clone();
        match child.play(m) {
            Ok(()) => Some(child.to_fen()),
            Err(_) => None,
        }
    }

    fn fen_with(&self, flip_side: bool, drop_ep: bool) -> String {
        let mut out = String::new();
        for r in (0..8usize).rev() {
            let mut empty = 0;
            for f in 0..8usize {
                let p = self.sq[r * 8 + f];
                if p == 0 {
                    empty += 1;
                } else {
                    if empty > 0 {
                        out.push_str(&empty.to_string());
                        empty = 0;
                    }
                    out.push(piece_char(p));
                }
            }
            if empty > 0 {
                out.push_str(&empty.to_string());
            }
            if r > 0 {
                out.push('/');
            }
        }
        let white = self.white_to_move() != flip_side;
        out.push(' ');
        out.push(if white { 'w' } else { 'b' });
        out.push(' ');
        let mut rights = String::new();
        if self.castling[0] {
            rights.push('K');
        }
        if self.castling[1] {
            rights.push('Q');
        }
        if self.castling[2] {
            rights.push('k');
        }
        if self.castling[3] {
            rights.push('q');
        }
        if rights.is_empty() {
            rights.push('-');
        }
        out.push_str(&rights);
        out.push(' ');
        let mut ep_text = "-".to_string();
        if !drop_ep {
            if let Some(ep) = self.ep {
                if self.ep_capturable(ep, white) {
                    ep_text = sq_name(ep);
                }
            }
        }
        out.push_str(&ep_text);
        out.push(' ');
        out.push_str(&self.halfmove.to_string());
        out.push(' ');
        out.push_str(&self.fullmove.to_string());
        out
    }

    /// Stockfish prints the en-passant square only when a pawn of the side to move can use it.
    fn ep_capturable(&self, ep: usize, white_to_move: bool) -> bool {
        let file = ep & 7;
        if white_to_move {
            // white pawns capture from the rank below the target
            if ep < 9 {
                return false;
            }
            (file > 0 && self.sq[ep - 9] == 1) || (file < 7 && ep >= 7 && self.sq[ep - 7] == 1)
        } else {
            if ep + 9 > 63 {
                return false;
            }
            (file > 0 && self.sq[ep + 7] == -1) || (file < 7 && self.sq[ep + 9] == -1)
        }
    }
}

/// Plain perft on the cozy board (counts leaf nodes).
pub fn perft(board: &Board, depth: u32) -> u64 {
    if depth == 0 {
        return 1;
    }
    let moves = legal_cmoves(board);
    if depth == 1 {
        return moves.len() as u64;
    }
    let mut total = 0u64;
    for m in moves {
        let mut next = board.clone();
        next.play_unchecked(m);
        total += perft(&next, depth - 1);
    }
    total
}

/// Perft through the KAIROS UCI layer (parse -> play), exercising castling/ep/promotion mapping.
pub fn perft_uci(pos: &Pos, depth: u32) -> u64 {
    if depth == 0 {
        return 1;
    }
    let moves = pos.legal_moves();
    if depth == 1 {
        return moves.len() as u64;
    }
    let mut total = 0u64;
    for m in moves {
        let reparsed = match Mv::parse(&m.uci()) {
            Some(r) => r,
            None => continue,
        };
        let mut child = pos.clone();
        if child.play(&reparsed).is_err() {
            continue;
        }
        total += perft_uci(&child, depth - 1);
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_layout_is_lerf() {
        // Guards the assumption behind idx_of/square_of.
        for (i, s) in Square::ALL.iter().enumerate() {
            assert_eq!(idx_of(*s), i, "Square::ALL[{}] has unexpected file/rank", i);
        }
    }

    #[test]
    fn startpos_mailbox_and_fen() {
        let pos = Pos::startpos();
        assert_eq!(pos.sq[4], 6); // e1 white king
        assert_eq!(pos.sq[60], -6); // e8 black king
        assert_eq!(pos.sq[8], 1); // a2 white pawn
        assert_eq!(pos.to_fen(), STARTPOS_FEN);
        assert_eq!(pos.legal_moves().len(), 20);
    }

    #[test]
    fn fen_round_trip_after_moves() {
        let pos = Pos::from_position_command("position startpos moves e2e4 c7c5 g1f3").unwrap();
        assert_eq!(
            pos.to_fen(),
            "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
        );
        let again = Pos::from_fen(&pos.to_fen()).unwrap();
        assert_eq!(again.hash(), pos.hash());
    }

    #[test]
    fn ep_square_only_when_capturable() {
        let pos = Pos::from_position_command("position startpos moves e2e4").unwrap();
        assert_eq!(
            pos.to_fen(),
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        );
        let pos = Pos::from_position_command("position startpos moves e2e4 a7a6 e4e5 d7d5").unwrap();
        assert!(pos.to_fen().contains(" d6 "), "{}", pos.to_fen());
    }

    #[test]
    fn castling_is_translated_both_ways() {
        let pos = Pos::from_position_command(
            "position startpos moves e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1g1",
        )
        .unwrap();
        assert_eq!(pos.sq[6], 6); // king on g1
        assert_eq!(pos.sq[5], 4); // rook on f1
        assert!(!pos.castling[0] && !pos.castling[1]);
        assert!(pos.to_fen().contains(" kq "), "{}", pos.to_fen());
    }

    #[test]
    fn illegal_moves_are_rejected() {
        assert!(Pos::from_position_command("position startpos moves e2e5").is_err());
        assert!(Pos::from_position_command("position startpos moves e7e8q").is_err());
    }

    #[test]
    fn repetition_and_halfmove() {
        let pos = Pos::from_position_command(
            "position startpos moves g1f3 g8f6 f3g1 f6g8",
        )
        .unwrap();
        // Position after g1f3 would be new; going back to the start is a repeat.
        let m = Mv::parse("g1f3").unwrap();
        assert_eq!(pos.repetition_count_after(&m), 1);
        assert_eq!(pos.halfmove, 4);
        assert!(pos.resets_halfmove(&Mv::parse("e2e4").unwrap()));
        assert!(!pos.resets_halfmove(&m));
    }

    #[test]
    fn null_fen_flips_side_and_is_none_in_check() {
        let pos = Pos::startpos();
        let fen = pos.null_fen().unwrap();
        assert!(fen.contains(" b KQkq - "));
        let checked =
            Pos::from_fen("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1").unwrap();
        assert!(checked.null_fen().is_none());
    }
}

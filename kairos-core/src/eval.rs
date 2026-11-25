//! Small baseline evaluation for KAIROS' own search: material, simple
//! piece-square tables and the bishop pair. It exists to order and sanity-check
//! KAIROS proposals and to keep the standalone mode tactically sane. It is
//! deliberately NOT tuned for strength (scope guard, spec 3.1).

use cozy_chess::{Board, Color, Piece};

use crate::pos::idx_of;

// Piece-square tables from White's point of view, listed rank 8 first (the
// widely published "simplified evaluation function" values).
const PAWN: [i32; 64] = [
    0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5,
    10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20,
    -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0,
];
const KNIGHT: [i32; 64] = [
    -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10,
    0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10,
    5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50,
];
const BISHOP: [i32; 64] = [
    -20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0,
    -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10,
    -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20,
];
const ROOK: [i32; 64] = [
    0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0,
    0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0,
    0, 5, 5, 0, 0, 0,
];
const QUEEN: [i32; 64] = [
    -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0,
    0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20,
];
const KING_MG: [i32; 64] = [
    -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40,
    -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30,
    -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0,
    10, 30, 20,
];
const KING_EG: [i32; 64] = [
    -50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30,
    30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30,
    -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30,
    -30, -50,
];

const VALUES: [i32; 6] = [100, 320, 330, 500, 900, 0];
const PHASE_WEIGHT: [i32; 6] = [0, 1, 1, 2, 4, 0];

fn table_index(idx: usize, white: bool) -> usize {
    let file = idx & 7;
    let rank = idx >> 3;
    if white {
        (7 - rank) * 8 + file
    } else {
        rank * 8 + file
    }
}

/// Centipawn evaluation from the side to move's point of view.
pub fn evaluate(board: &Board) -> i32 {
    let pieces = [
        Piece::Pawn,
        Piece::Knight,
        Piece::Bishop,
        Piece::Rook,
        Piece::Queen,
        Piece::King,
    ];
    let mut mg = 0i32;
    let mut eg = 0i32;
    let mut phase = 0i32;
    for color in [Color::White, Color::Black] {
        let white = color == Color::White;
        let sign = if white { 1 } else { -1 };
        // VERIFY-API: Board::colors(Color) -> BitBoard, Board::pieces(Piece) -> BitBoard, BitBoard(pub u64).
        let own = board.colors(color).0;
        let mut bishops = 0;
        for (pi, piece) in pieces.iter().enumerate() {
            let mut bits = own & board.pieces(*piece).0;
            while bits != 0 {
                let bit = bits.trailing_zeros() as usize;
                bits &= bits - 1;
                // VERIFY-API: Square::ALL indexed by bit position.
                let idx = idx_of(cozy_chess::Square::ALL[bit]);
                let t = table_index(idx, white);
                let (pst_mg, pst_eg) = match pi {
                    0 => (PAWN[t], PAWN[t]),
                    1 => (KNIGHT[t], KNIGHT[t]),
                    2 => (BISHOP[t], BISHOP[t]),
                    3 => (ROOK[t], ROOK[t]),
                    4 => (QUEEN[t], QUEEN[t]),
                    _ => (KING_MG[t], KING_EG[t]),
                };
                mg += sign * (VALUES[pi] + pst_mg);
                eg += sign * (VALUES[pi] + pst_eg);
                phase += PHASE_WEIGHT[pi];
                if pi == 2 {
                    bishops += 1;
                }
            }
        }
        if bishops >= 2 {
            mg += sign * 30;
            eg += sign * 40;
        }
    }
    let phase = std::cmp::min(phase, 24);
    let score = (mg * phase + eg * (24 - phase)) / 24;
    let tempo = 10;
    if board.side_to_move() == Color::White {
        score + tempo
    } else {
        -score + tempo
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pos::Pos;

    #[test]
    fn startpos_is_balanced() {
        let pos = Pos::startpos();
        let e = evaluate(&pos.board);
        assert!(e.abs() <= 15, "start eval = {}", e);
    }

    #[test]
    fn extra_queen_is_a_big_edge() {
        let up = Pos::from_fen("4k3/8/8/8/8/8/8/3QK3 w - - 0 1").unwrap();
        assert!(evaluate(&up.board) > 800);
        let down = Pos::from_fen("3qk3/8/8/8/8/8/8/4K3 w - - 0 1").unwrap();
        assert!(evaluate(&down.board) < -800);
    }

    #[test]
    fn evaluation_is_colour_symmetric() {
        let w = Pos::from_fen("4k3/pppp4/8/8/8/8/PPPP4/4K3 w - - 0 1").unwrap();
        let b = Pos::from_fen("4k3/pppp4/8/8/8/8/PPPP4/4K3 b - - 0 1").unwrap();
        assert_eq!(evaluate(&w.board), evaluate(&b.board));
    }
}

//! Perft conformance (spec phase 2). Run in release mode:
//!   cargo test --release --manifest-path kairos-core/Cargo.toml --test perft
//! Known node counts: https://www.chessprogramming.org/Perft_Results

use kairos_core::pos::{perft, perft_uci, Pos};

struct Case {
    name: &'static str,
    fen: &'static str,
    // (depth, nodes) checked on the raw cozy board
    raw: &'static [(u32, u64)],
    // (depth, nodes) checked through the KAIROS UCI layer (slower)
    uci: &'static [(u32, u64)],
}

const CASES: &[Case] = &[
    Case {
        name: "startpos",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        raw: &[(1, 20), (2, 400), (3, 8902), (4, 197_281), (5, 4_865_609)],
        uci: &[(1, 20), (2, 400), (3, 8902), (4, 197_281)],
    },
    Case {
        name: "kiwipete",
        fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        raw: &[(1, 48), (2, 2039), (3, 97_862), (4, 4_085_603)],
        uci: &[(1, 48), (2, 2039), (3, 97_862)],
    },
    Case {
        name: "cpw-position-3",
        fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
        raw: &[(1, 14), (2, 191), (3, 2812), (4, 43_238), (5, 674_624)],
        uci: &[(1, 14), (2, 191), (3, 2812), (4, 43_238)],
    },
    Case {
        name: "cpw-position-4",
        fen: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
        raw: &[(1, 6), (2, 264), (3, 9467), (4, 422_333)],
        uci: &[(1, 6), (2, 264), (3, 9467)],
    },
    Case {
        name: "cpw-position-5",
        fen: "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
        raw: &[(1, 44), (2, 1486), (3, 62_379), (4, 2_103_487)],
        uci: &[(1, 44), (2, 1486), (3, 62_379)],
    },
    Case {
        name: "cpw-position-6",
        fen: "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
        raw: &[(1, 46), (2, 2079), (3, 89_890), (4, 3_894_594)],
        uci: &[(1, 46), (2, 2079), (3, 89_890)],
    },
];

#[test]
fn perft_raw_board() {
    for case in CASES {
        let pos = Pos::from_fen(case.fen).expect(case.name);
        for (depth, nodes) in case.raw {
            assert_eq!(
                perft(&pos.board, *depth),
                *nodes,
                "{} depth {}",
                case.name,
                depth
            );
        }
    }
}

#[test]
fn perft_through_the_uci_layer() {
    for case in CASES {
        let pos = Pos::from_fen(case.fen).expect(case.name);
        for (depth, nodes) in case.uci {
            assert_eq!(
                perft_uci(&pos, *depth),
                *nodes,
                "{} depth {} (UCI layer)",
                case.name,
                depth
            );
        }
    }
}

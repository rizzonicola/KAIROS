import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "kairos"))
from chess_features import Board, board_from_position_command, candidate_features  # noqa: E402


class ChessFeatureTests(unittest.TestCase):
    def test_pawn_tension_delta_for_c2c4(self):
        fen = "4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1"
        board = Board.from_fen(fen)
        self.assertEqual(board.pawn_lever_count(), 1)
        features = candidate_features(board, "c2c4")
        self.assertEqual(features["T"], 1)
        self.assertAlmostEqual(features["F_T"], 0.25)
        self.assertEqual(features["F_S"], 0.0)

    def test_capture_material_feature(self):
        fen = "4k3/5p2/8/8/8/5Q2/5PPP/4K3 w - - 0 1"
        board = Board.from_fen(fen)
        features = candidate_features(board, "f3f7")
        self.assertAlmostEqual(features["F_S"], 1.0 / 9.0)

    def test_check_feature(self):
        fen = "4k3/5p2/8/8/8/5Q2/5PPP/4K3 w - - 0 1"
        board = Board.from_fen(fen)
        self.assertTrue(board.move_gives_check("f3f7"))
        self.assertEqual(candidate_features(board, "f3f7")["F_I"], 1.0)

    def test_position_history_reconstruction(self):
        board = board_from_position_command("position startpos moves e2e4 d7d5")
        self.assertIsNotNone(board)
        self.assertEqual(board.turn, "w")
        self.assertEqual(board.squares[3 * 8 + 4], "P")
        self.assertEqual(board.squares[4 * 8 + 3], "p")

    def test_castling_and_promotion_application(self):
        castle = Board.from_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1").apply_uci("e1g1")
        self.assertEqual(castle.squares[6], "K")
        self.assertEqual(castle.squares[5], "R")
        promoted = Board.from_fen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1").apply_uci("a7a8q")
        self.assertEqual(promoted.squares[56], "Q")

    def test_absolute_pin_count_and_creation(self):
        pinned = Board.from_fen("k3r3/8/8/8/8/8/4N3/4K3 w - - 0 1")
        self.assertEqual(pinned.pin_count(), 1)
        self.assertEqual(pinned.tension_count(), 1)
        board = Board.from_fen("4k3/4n3/8/8/8/8/8/R6K w - - 0 1")
        self.assertEqual(board.pin_count(), 0)
        features = candidate_features(board, "a1e1")
        self.assertAlmostEqual(features["F_T"], 0.25)
        # Two own pieces on the ray: the first is not pinned.
        blocked = Board.from_fen("k3r3/8/8/8/8/4B3/4N3/4K3 w - - 0 1")
        self.assertEqual(blocked.pin_count(), 0)

    def test_promotion_reduces_simplification(self):
        board = Board.from_fen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1")
        self.assertEqual(board.material_delta("a7a8q"), -8)
        self.assertAlmostEqual(candidate_features(board, "a7a8q")["F_S"], -8.0 / 9.0)

    def test_queen_threat_counts_as_initiative(self):
        board = Board.from_fen("q6k/8/8/8/8/8/8/R6K w - - 0 1")
        self.assertTrue(board.move_threatens_enemy_queen("a1a7"))
        self.assertEqual(candidate_features(board, "a1a7")["F_I"], 1.0)
        self.assertEqual(candidate_features(board, "a1b1")["F_I"], 0.0)


if __name__ == "__main__":
    unittest.main()

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "kairos"))
from chess_features import board_from_position_command  # noqa: E402
from validation import (  # noqa: E402
    SCENARIOS,
    ScenarioResult,
    parse_chunk,
    results_markdown,
    safety_issues,
)

VERIFIED_CHUNK = """
verify candidate=c2c4 versus sf_best=g1f3 budget=0.750%
accepted pick=c2c4 verified_loss=0.0000%
info string kairos posture=COIL conf=0.61 mix={'Coil': 0.61} plan=hold-tension
"""


class ScenarioDefinitionTests(unittest.TestCase):
    def test_scenarios_are_unique_and_playable(self):
        names = [scenario.name for scenario in SCENARIOS]
        self.assertEqual(len(names), len(set(names)))
        for scenario in SCENARIOS:
            self.assertGreater(scenario.depth, 0)
            self.assertIsNotNone(
                board_from_position_command(f"position {scenario.position}"),
                scenario.name,
            )
            self.assertIn(
                scenario.posture,
                ("Auto", "Coil", "Strike", "Absorb", "Reverse", "Distill", "Fog"),
            )

    def test_scenarios_cover_safety_paths(self):
        postures = {scenario.posture for scenario in SCENARIOS}
        self.assertIn("Distill", postures)
        self.assertIn("Fog", postures)
        self.assertTrue(any("7k/5Q2/6K1" in scenario.position for scenario in SCENARIOS))


class ParseChunkTests(unittest.TestCase):
    def test_verified_rerank_is_parsed(self):
        result = parse_chunk("queens-gambit", VERIFIED_CHUNK, "bestmove c2c4 ponder e7e5")
        self.assertEqual(result.bestmove, "c2c4")
        self.assertEqual(result.posture, "COIL")
        self.assertEqual(result.pick, "c2c4")
        self.assertTrue(result.reranked)
        self.assertTrue(result.verified)
        self.assertAlmostEqual(result.verified_loss_pct, 0.0)
        self.assertAlmostEqual(result.budget_pct, 0.75)
        self.assertEqual(result.note, "verified-rerank")
        self.assertEqual(safety_issues(result), [])

    def test_passthrough_without_posture(self):
        result = parse_chunk("startpos", "no eligible rerank", "bestmove e2e4")
        self.assertEqual(result.posture, "n/a")
        self.assertFalse(result.reranked)
        self.assertFalse(result.verified)
        self.assertEqual(result.note, "stockfish-best")
        self.assertEqual(safety_issues(result), [])

    def test_mate_guard_and_distill_skip_are_labelled(self):
        mate = parse_chunk("mate-in-one", "mate score observed", "bestmove f7f8q")
        self.assertEqual(mate.note, "mate-guard")
        self.assertEqual(mate.posture, "mate-guard")
        distill = parse_chunk("queen-conversion", "distill conversion", "bestmove d2d8")
        self.assertEqual(distill.note, "distill-skip")
        self.assertEqual(safety_issues(distill), [])


class SafetyIssueTests(unittest.TestCase):
    def make(self, **overrides):
        values = dict(
            name="x",
            posture="COIL",
            bestmove="c2c4",
            pick="c2c4",
            reranked=True,
            verified=True,
            verified_loss_pct=0.5,
            budget_pct=0.75,
            note="verified-rerank",
        )
        values.update(overrides)
        return ScenarioResult(**values)

    def test_clean_result_has_no_issues(self):
        self.assertEqual(safety_issues(self.make()), [])

    def test_malformed_bestmove_is_flagged(self):
        self.assertIn("missing or malformed bestmove", safety_issues(self.make(bestmove="")))

    def test_unverified_pick_is_flagged(self):
        issues = safety_issues(self.make(verified=False))
        self.assertIn("reranked pick without verification", issues)

    def test_pick_must_match_bestmove(self):
        issues = safety_issues(self.make(bestmove="e1d2"))
        self.assertIn("accepted pick does not match bestmove", issues)

    def test_loss_must_fit_budget(self):
        issues = safety_issues(self.make(verified_loss_pct=1.0))
        self.assertIn("verified loss exceeds effective budget", issues)

    def test_rerank_after_mate_or_distill_is_flagged(self):
        self.assertIn("rerank after mate score", safety_issues(self.make(note="mate-guard")))
        self.assertIn(
            "rerank in Distill conversion", safety_issues(self.make(note="distill-skip"))
        )


class ResultsMarkdownTests(unittest.TestCase):
    def test_table_contains_every_scenario(self):
        results = [
            ScenarioResult("a", "COIL", "e2e4", "e2e4", True, True, 0.0, 0.75, "verified-rerank"),
            ScenarioResult("b", "n/a", "e2e4", "", False, False, None, None, "passthrough-or-best"),
        ]
        text = results_markdown(results, "2026-11-23")
        self.assertIn("Run date: 2026-11-23", text)
        self.assertIn("| a | COIL | e2e4 | yes | yes | 0.000% | 0.750% | verified-rerank |", text)
        self.assertIn("| b | n/a | e2e4 | no | no | - | - | passthrough-or-best |", text)


if __name__ == "__main__":
    unittest.main()

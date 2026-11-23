import random
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "kairos"))
from postures import (  # noqa: E402
    FEATURES,
    POSTURES,
    WEIGHTS,
    Evidence,
    PostureController,
    dominant,
    infer_mix,
    one_hot,
    sample_index,
    weighted_features,
)


def mix(**values):
    result = {name: 0.0 for name in POSTURES}
    result.update(values)
    return result


class WeightTests(unittest.TestCase):
    def test_spec_weight_table(self):
        for posture in POSTURES:
            self.assertEqual(set(WEIGHTS[posture]), set(FEATURES))
        self.assertEqual(WEIGHTS["Coil"]["F_T"], 2)
        self.assertEqual(WEIGHTS["Coil"]["F_S"], -1)
        self.assertEqual(WEIGHTS["Distill"]["F_S"], 3)
        self.assertEqual(WEIGHTS["Fog"]["F_S"], -3)
        self.assertEqual(WEIGHTS["Absorb"]["F_P"], 3)

    def test_weighted_features_coil(self):
        coil = one_hot("Coil")
        self.assertAlmostEqual(weighted_features(coil, {"F_T": 0.25}), 0.5)
        self.assertAlmostEqual(weighted_features(coil, {"F_S": 0.5}), -0.5)
        self.assertAlmostEqual(weighted_features(coil, {"F_I": 1.0}), 1.0)


class InferenceTests(unittest.TestCase):
    def test_balanced_evidence_prefers_coil(self):
        result = infer_mix(Evidence(expected=0.5, tension=0.1))
        self.assertEqual(dominant(result), "Coil")
        self.assertAlmostEqual(sum(result.values()), 1.0)

    def test_attack_evidence_prefers_strike(self):
        result = infer_mix(
            Evidence(
                expected=0.60,
                trend=0.5,
                enemy_king_pressure=0.9,
                forcing_density=0.8,
            )
        )
        self.assertEqual(dominant(result), "Strike")

    def test_losing_evidence_prefers_fog(self):
        result = infer_mix(Evidence(expected=0.20, tension=0.1))
        self.assertEqual(dominant(result), "Fog")

    def test_winning_evidence_prefers_distill(self):
        result = infer_mix(Evidence(expected=0.90, tension=0.1, phase=0.5))
        self.assertEqual(dominant(result), "Distill")

    def test_precise_opponent_damps_fog(self):
        fragile = infer_mix(Evidence(expected=0.20, tension=0.1, opponent_fragility=0.5))
        precise = infer_mix(Evidence(expected=0.20, tension=0.1, opponent_fragility=-0.5))
        self.assertGreater(fragile["Fog"], precise["Fog"])


class ControllerTests(unittest.TestCase):
    def test_inertia_requires_two_consecutive_moves(self):
        controller = PostureController()
        strong_strike = mix(Strike=0.80, Coil=0.20)
        evidence = Evidence(expected=0.60, enemy_king_pressure=0.2)
        controller.update(strong_strike, evidence)
        self.assertEqual(dominant(controller.mix), "Coil")
        controller.update(strong_strike, evidence)
        self.assertEqual(dominant(controller.mix), "Strike")

    def test_immediate_strike_override(self):
        controller = PostureController()
        controller.update(
            mix(Strike=0.80, Coil=0.20),
            Evidence(expected=0.60, enemy_king_pressure=0.80),
        )
        self.assertEqual(dominant(controller.mix), "Strike")

    def test_distill_lock_and_exit(self):
        controller = PostureController()
        controller.mix = one_hot("Distill")
        coily = mix(Coil=0.80, Distill=0.05)
        controller.update(coily, Evidence(expected=0.85))
        self.assertEqual(dominant(controller.mix), "Distill")
        controller.update(coily, Evidence(expected=0.70))
        self.assertEqual(dominant(controller.mix), "Distill")
        controller.update(coily, Evidence(expected=0.50))
        self.assertEqual(dominant(controller.mix), "Distill")
        controller.update(coily, Evidence(expected=0.50))
        self.assertEqual(dominant(controller.mix), "Coil")

    def test_forced_posture_overrides_inference(self):
        controller = PostureController()
        controller.update(infer_mix(Evidence()), Evidence(), forced="Fog")
        self.assertEqual(controller.mix, one_hot("Fog"))

    def test_sample_index_is_argmax_at_zero_temperature(self):
        self.assertEqual(sample_index([0.0, 1.0, 0.5], 0.0, random.Random(0)), 1)

    def test_sample_index_explores_at_positive_temperature(self):
        rng = random.Random(0)
        picks = {sample_index([0.0, 1.0, 0.5], 0.2, rng) for _ in range(100)}
        self.assertIn(1, picks)


if __name__ == "__main__":
    unittest.main()

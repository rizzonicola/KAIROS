"""Postures, weights, inference and hysteresis for KAIROS.

The weight table follows KAIROS_SPECIFICATION.md section 11.4. One weight unit
is worth roughly 0.1% of expected score after the caller applies the style
scale; the loss term always remains dominant.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import random
from typing import Mapping, Optional, Sequence

POSTURES = ("Coil", "Strike", "Absorb", "Reverse", "Distill", "Fog")
FEATURES = ("F_T", "F_N", "F_R", "F_C", "F_F", "F_P", "F_K", "F_S", "F_I")

WEIGHTS: dict[str, dict[str, int]] = {
    "Coil":    {"F_T": 2, "F_N": 2, "F_R": 2, "F_C": 1, "F_F": 2, "F_P": 1, "F_K": 1, "F_S": -1, "F_I": 1},
    "Strike":  {"F_T": 1, "F_N": 1, "F_R": 0, "F_C": 3, "F_F": 0, "F_P": 0, "F_K": 0, "F_S": -1, "F_I": 3},
    "Absorb":  {"F_T": 1, "F_N": 1, "F_R": 1, "F_C": 0, "F_F": 2, "F_P": 3, "F_K": 3, "F_S": 1, "F_I": 0},
    "Reverse": {"F_T": 1, "F_N": 1, "F_R": 1, "F_C": 2, "F_F": 1, "F_P": 1, "F_K": 1, "F_S": -1, "F_I": 2},
    "Distill": {"F_T": -2, "F_N": 0, "F_R": 0, "F_C": 0, "F_F": 1, "F_P": 3, "F_K": 2, "F_S": 3, "F_I": 0},
    "Fog":     {"F_T": 2, "F_N": 3, "F_R": 1, "F_C": 1, "F_F": 1, "F_P": 0, "F_K": 0, "F_S": -3, "F_I": 1},
}

INERTIA_MARGIN = 0.15
INERTIA_STREAK = 2
SOFTMAX_TEMPERATURE = 0.20
DISTILL_ENTER = 0.80
DISTILL_EXIT = 0.65

PLAN_TOKENS = {
    "Coil": "hold-tension",
    "Strike": "press-king",
    "Absorb": "absorb-threat",
    "Reverse": "reverse-tension",
    "Distill": "convert",
    "Fog": "complicate",
}


def plan_token(posture: str) -> str:
    return PLAN_TOKENS.get(posture, "hold-tension")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def one_hot(posture: str) -> dict[str, float]:
    return {name: 1.0 if name == posture else 0.0 for name in POSTURES}


def normalize(mix: Mapping[str, float]) -> dict[str, float]:
    clean = {name: max(0.0, float(mix.get(name, 0.0))) for name in POSTURES}
    total = sum(clean.values())
    if total <= 0:
        return one_hot("Coil")
    return {name: value / total for name, value in clean.items()}


def dominant(mix: Mapping[str, float]) -> str:
    return max(POSTURES, key=lambda name: mix.get(name, 0.0))


def weighted_features(mix: Mapping[str, float], features: Mapping[str, float | int]) -> float:
    return sum(
        WEIGHTS[posture][feature] * mix.get(posture, 0.0) * float(features.get(feature, 0.0))
        for posture in POSTURES
        for feature in FEATURES
    )


def softmax(scores: Mapping[str, float], temperature: float = SOFTMAX_TEMPERATURE) -> dict[str, float]:
    if temperature <= 0:
        return one_hot(dominant(scores))
    peak = max(scores.values())
    weights = {name: math.exp((value - peak) / temperature) for name, value in scores.items()}
    total = sum(weights.values())
    return {name: value / total for name, value in weights.items()}


def sample_index(scores: list[float], tau: float, rng: random.Random) -> int:
    """Sample an index from a softmax over scores. tau <= 0 is argmax."""
    if not scores:
        return -1
    if tau <= 0:
        return max(range(len(scores)), key=lambda index: scores[index])
    peak = max(scores)
    weights = [math.exp((score - peak) / tau) for score in scores]
    total = sum(weights)
    threshold = rng.random() * total
    upto = 0.0
    for index, weight in enumerate(weights):
        upto += weight
        if threshold <= upto:
            return index
    return len(scores) - 1


@dataclass(frozen=True)
class Evidence:
    expected: float = 0.5
    trend: float = 0.0
    tension: float = 0.0
    own_king_pressure: float = 0.0
    enemy_king_pressure: float = 0.0
    forcing_density: float = 0.0
    phase: float = 0.0
    opponent_fragility: float = 0.0
    material_balance: float = 0.0


def score_trend(history: Sequence[float], current: float) -> float:
    """Normalized expected-score change versus the previous own moves."""
    previous = list(history)[-3:]
    if not previous:
        return 0.0
    return clamp((current - sum(previous) / len(previous)) / 0.10, -1.0, 1.0)


def evidence_from_stats(
    stats: Mapping[str, float],
    expected: float,
    history: Sequence[float],
    forcing_density: float,
    opponent_fragility: float = 0.0,
) -> Evidence:
    """Build inference evidence from static stats, own history and PV forcing."""
    return Evidence(
        expected=expected,
        trend=score_trend(history, expected),
        tension=clamp(stats.get("tension", 0.0) / 4.0, 0.0, 1.0),
        own_king_pressure=clamp(stats.get("own_king_attackers", 0.0) / 3.0, 0.0, 1.0),
        enemy_king_pressure=clamp(stats.get("enemy_king_attackers", 0.0) / 3.0, 0.0, 1.0),
        forcing_density=clamp(forcing_density, 0.0, 1.0),
        phase=clamp(stats.get("phase", 0.0), 0.0, 1.0),
        opponent_fragility=clamp(opponent_fragility, -1.0, 1.0),
        material_balance=float(stats.get("material_balance", 0.0)),
    )


FRAGILITY_CLASSES = ("sharp-tactical", "quiet-maneuvering", "defending", "endgame")
FRAGILITY_ALPHA = 0.3
MAX_VARIETY_TAU = 0.10


def position_class(
    stats: Mapping[str, float], expected: float, forcing_density: float = 0.0
) -> str:
    """Deterministic class used to keep separate opponent-accuracy averages."""
    if stats.get("phase", 0.0) < 0.25:
        return "endgame"
    if stats.get("tension", 0.0) >= 3.0 or forcing_density >= 0.5:
        return "sharp-tactical"
    if expected < 0.45 or stats.get("own_king_attackers", 0.0) >= 2.0:
        return "defending"
    return "quiet-maneuvering"


def update_fragility(previous: float, loss: float, alpha: float = FRAGILITY_ALPHA) -> float:
    """EWMA of the opponent's expected-score loss in one position class."""
    return clamp((1.0 - alpha) * previous + alpha * clamp(loss, -1.0, 1.0), -1.0, 1.0)


def variety_temperature(variety: int, posture: str, forced: bool) -> float:
    """Softmax temperature for anti-rigidity; zero keeps the argmax."""
    if forced or variety <= 0 or posture in ("Strike", "Distill"):
        return 0.0
    return MAX_VARIETY_TAU * clamp(variety, 0, 100) / 100.0


def infer_mix(evidence: Evidence, temperature: float = SOFTMAX_TEMPERATURE) -> dict[str, float]:
    """Turn observable evidence into a soft posture mix."""
    expected = clamp(evidence.expected, 0.0, 1.0)
    trend = clamp(evidence.trend, -1.0, 1.0)
    tension = clamp(evidence.tension, 0.0, 1.0)
    own_pressure = clamp(evidence.own_king_pressure, 0.0, 1.0)
    enemy_pressure = clamp(evidence.enemy_king_pressure, 0.0, 1.0)
    forcing = clamp(evidence.forcing_density, 0.0, 1.0)
    phase = clamp(evidence.phase, 0.0, 1.0)
    fragility = clamp(evidence.opponent_fragility, -1.0, 1.0)
    material = clamp(evidence.material_balance / 9.0, -1.0, 1.0)
    midgame_balance = 1.0 - abs(expected - 0.5) * 2.0
    fragile = max(0.0, fragility)
    precise = max(0.0, -fragility)

    scores = {
        "Coil": (
            0.20
            + 0.35 * tension
            + 0.20 * (1.0 - abs(trend))
            + 0.15 * midgame_balance
            + 0.10 * fragile
        ),
        "Strike": (
            0.10
            + 0.45 * enemy_pressure
            + 0.25 * max(trend, 0.0)
            + 0.20 * forcing
            - 0.20 * precise
        ),
        "Absorb": (
            0.10
            + 0.55 * own_pressure
            + 0.20 * max(-trend, 0.0)
            + 0.15 * (1.0 - phase)
        ),
        "Reverse": (
            0.05
            + 0.30 * own_pressure
            + 0.25 * max(-trend, 0.0)
            + 0.20 * tension
            + 0.20 * fragile
        ),
        "Distill": (
            0.05
            + 0.55 * clamp((expected - 0.65) / 0.35, 0.0, 1.0)
            + 0.25 * (1.0 - tension)
            + 0.15 * (1.0 - phase)
            + 0.10 * max(material, 0.0)
        ),
        "Fog": (
            0.05
            + 0.75 * clamp((0.35 - expected) / 0.35, 0.0, 1.0)
            + 0.20 * (1.0 - tension)
            + 0.15 * fragile
            - 0.20 * precise
        ),
    }
    return softmax({name: max(0.01, score) for name, score in scores.items()}, temperature)


class PostureController:
    """Hysteresis around the inferred mix.

    The current mix is sticky while the dominant posture is unchanged. A new
    dominant posture needs two consecutive moves with a margin of 0.15, unless
    a strong Strike/Absorb evidence triggers an immediate override. Distill
    locks in above 0.80 expected score and exits below 0.65.
    """

    def __init__(self) -> None:
        self.mix = one_hot("Coil")
        self.pending: Optional[str] = None
        self.pending_count = 0
        self.distill_lock = False

    def reset(self) -> None:
        self.mix = one_hot("Coil")
        self.pending = None
        self.pending_count = 0
        self.distill_lock = False

    def update(
        self,
        inferred: Mapping[str, float],
        evidence: Evidence,
        forced: Optional[str] = None,
    ) -> dict[str, float]:
        inferred = normalize(inferred)
        if forced:
            self.mix = one_hot(forced)
            self.pending = None
            self.pending_count = 0
            self.distill_lock = False
            return self.mix

        current = dominant(self.mix)
        new = dominant(inferred)

        if current == "Distill" and evidence.expected >= DISTILL_ENTER:
            self.distill_lock = True
        if self.distill_lock and current == "Distill":
            if evidence.expected >= DISTILL_EXIT:
                return self.mix
            self.distill_lock = False

        if new == current:
            self.pending = None
            self.pending_count = 0
            return self.mix

        immediate = (
            new == "Strike"
            and inferred["Strike"] >= 0.75
            and evidence.enemy_king_pressure >= 0.60
        ) or (
            new == "Absorb"
            and inferred["Absorb"] >= 0.75
            and evidence.own_king_pressure >= 0.60
        )
        if immediate:
            self.mix = inferred
            self.pending = None
            self.pending_count = 0
            return self.mix

        if inferred[new] - inferred[current] >= INERTIA_MARGIN:
            if self.pending == new:
                self.pending_count += 1
            else:
                self.pending = new
                self.pending_count = 1
            if self.pending_count >= INERTIA_STREAK:
                self.mix = inferred
                self.pending = None
                self.pending_count = 0
        else:
            self.pending = None
            self.pending_count = 0
        return self.mix

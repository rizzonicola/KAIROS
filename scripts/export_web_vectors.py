#!/usr/bin/env python3
"""Generate JSON parity vectors from the Python KAIROS reference.

The web port must reproduce these values within 1e-9. Run with --check in CI
to catch stale fixtures.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "kairos"))

from chess_features import (  # noqa: E402
    Board,
    board_from_position_command,
    candidate_features,
    position_stats,
)
from postures import (  # noqa: E402
    FEATURES,
    POSTURES,
    WEIGHTS,
    Evidence,
    PostureController,
    dominant,
    evidence_from_stats,
    infer_mix,
    one_hot,
    plan_token,
    position_class,
    score_trend,
    update_fragility,
    variety_temperature,
)
from uci_proxy import (  # noqa: E402
    KairosProxy,
    fifty_move_blocked,
    is_saturated,
    parse_info,
    repetition_blocked,
    result_band,
    supported_personality_search,
)

OUT = ROOT / "web" / "tests" / "vectors"

TENSION_FEN = "4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1"
QUEEN_FEN = "4k3/5p2/8/8/8/5Q2/5PPP/4K3 w - - 0 1"


def camel_stats(stats: dict[str, float]) -> dict[str, float]:
    return {
        "tension": float(stats.get("tension", 0.0)),
        "ownKingAttackers": float(stats.get("own_king_attackers", 0.0)),
        "ownKingDefenders": float(stats.get("own_king_defenders", 0.0)),
        "enemyKingAttackers": float(stats.get("enemy_king_attackers", 0.0)),
        "enemyKingDefenders": float(stats.get("enemy_king_defenders", 0.0)),
        "phase": float(stats.get("phase", 0.0)),
        "materialBalance": float(stats.get("material_balance", 0.0)),
    }


def mix_dict(values: dict[str, float]) -> dict[str, float]:
    return {name: float(values.get(name, 0.0)) for name in POSTURES}


def evidence_dict(item: Evidence) -> dict[str, float]:
    return {
        "expected": item.expected,
        "trend": item.trend,
        "tension": item.tension,
        "ownKingPressure": item.own_king_pressure,
        "enemyKingPressure": item.enemy_king_pressure,
        "forcingDensity": item.forcing_density,
        "phase": item.phase,
        "opponentFragility": item.opponent_fragility,
        "materialBalance": item.material_balance,
    }


def board_vectors() -> dict[str, object]:
    cases = [
        (TENSION_FEN, "c2c4"),
        (QUEEN_FEN, "f3f7"),
        ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1"),
        ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "a1a8"),
        ("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1", "e8g8"),
        ("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8q"),
        ("k3r3/8/8/8/8/8/4N3/4K3 w - - 0 1", "e1d2"),
        ("q6k/8/8/8/8/8/8/R6K w - - 0 1", "a1a7"),
        ("q6k/8/8/8/8/8/8/R6K w - - 0 1", "a1b1"),
        ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e2e4"),
        ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "g1f3"),
        ("4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 90 1", "e4d5"),
        ("4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 90 1", "e1d2"),
        ("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "e5d6"),
    ]
    result = []
    for fen, move in cases:
        board = Board.from_fen(fen)
        after = board.apply_uci(move)
        result.append(
            {
                "fen": fen,
                "move": move,
                "fenAfter": after.to_fen(),
                "positionKey": after.position_key(),
                "halfmoveReset": board.resets_halfmove(move),
                "capturedValue": board.captured_value(move),
                "materialDelta": board.material_delta(move),
                "givesCheck": board.move_gives_check(move),
                "threatensQueen": board.move_threatens_enemy_queen(move),
            }
        )
    return {"cases": result}


def feature_vectors() -> dict[str, object]:
    cases = [
        (TENSION_FEN, ["c2c4", "e1d2", "e4d5", "c2c3"]),
        (QUEEN_FEN, ["f3f7", "f3b7", "e1d2"]),
        ("k3r3/8/8/8/8/8/4N3/4K3 w - - 0 1", ["e1d2", "e2d4", "e2c3"]),
        ("4k3/8/8/8/3N4/8/8/4K3 w - - 0 1", ["d4e6", "d4f5", "e1d2"]),
        ("R6R/8/8/8/8/8/8/4K3 w - - 0 1", ["a1a7", "h1h7", "e1d2"]),
        ("4k3/8/8/3p4/8/8/2P5/4K3 w - - 0 1", ["c2c3", "c2c4", "e1d2"]),
        ("q6k/8/8/8/8/8/8/R6K w - - 0 1", ["a1a7", "a1b1"]),
        ("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", ["a7a8q", "a7a8n", "e1d2"]),
        ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", ["e2e4", "g1f3", "d2d4"]),
        ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", ["e1g1", "e1c1", "a1a8"]),
        ("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", ["e1d2", "e2e3", "e2e4"]),
        ("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", ["e5d6", "e5e6", "e1d2"]),
    ]
    result = []
    for fen, moves in cases:
        board = Board.from_fen(fen)
        result.append(
            {
                "fen": fen,
                "moves": moves,
                "stats": camel_stats(position_stats(board)),
                "features": {move: candidate_features(board, move) for move in moves},
            }
        )
    return {"cases": result}


def probe_feature_vectors() -> dict[str, object]:
    cases = [
        {
            "move": "e2e4",
            "probeResults": {
                "e2e4": {"best": 0.65, "second": 0.64, "replies": [0.65, 0.64, 0.40]},
            },
            "nullThreat": 0.70,
        },
        {
            "move": "e2e4",
            "probeResults": {
                "e2e4": {"best": 0.65, "second": 0.50, "replies": [0.65, 0.50, 0.40]},
            },
            "nullThreat": None,
        },
        {
            "move": "e2e4",
            "probeResults": {},
            "nullThreat": 0.70,
        },
        {
            "move": "e2e4",
            "probeResults": {
                "e2e4": {"best": 0.65, "second": None, "replies": []},
            },
            "nullThreat": 0.70,
        },
        {
            "move": "e2e4",
            "probeResults": {
                "e2e4": {"best": 0.50, "second": 0.10, "replies": [0.50, 0.10]},
            },
            "nullThreat": 0.10,
        },
        {
            "move": "e2e4",
            "probeResults": {
                "e2e4": {"best": 0.50, "second": 0.10, "replies": [0.50, 0.10]},
            },
            "nullThreat": 0.00,
        },
        {
            "move": "e2e4",
            "probeResults": {
                "e2e4": {"best": 0.80, "second": 0.80, "replies": [0.80, 0.55, 0.30]},
            },
            "nullThreat": 0.90,
        },
    ]
    result = []
    for case in cases:
        search = SimpleNamespace(
            probe_results=case["probeResults"],
            null_threat=case["nullThreat"],
        )
        expected = KairosProxy._probe_features(None, search, case["move"])
        result.append(
            {
                "move": case["move"],
                "probeResults": case["probeResults"],
                "nullThreat": case["nullThreat"],
                "expected": expected,
            }
        )
    return {"cases": result}


def posture_vectors() -> dict[str, object]:
    trend_cases = [
        {"history": [], "current": 0.70},
        {"history": [0.50], "current": 0.60},
        {"history": [0.60], "current": 0.50},
        {"history": [0.50, 0.50, 0.50, 0.50], "current": 0.55},
        {"history": [0.40, 0.55, 0.65], "current": 0.60},
    ]
    trend = [
        {
            "history": case["history"],
            "current": case["current"],
            "expected": score_trend(case["history"], case["current"]),
        }
        for case in trend_cases
    ]

    evidence_cases = [
        (
            {
                "tension": 8.0,
                "own_king_attackers": 3.0,
                "enemy_king_attackers": 1.5,
                "phase": 0.5,
                "material_balance": -2.0,
            },
            0.60,
            [0.50],
            0.75,
            0.40,
        ),
        ({}, 0.50, [], 0.0, 0.0),
        (
            {
                "tension": 1.0,
                "own_king_attackers": 0.5,
                "enemy_king_attackers": 2.5,
                "phase": 0.8,
                "material_balance": 3.0,
            },
            0.30,
            [0.60, 0.55],
            0.20,
            -0.50,
        ),
    ]
    evidence = []
    for stats, expected, history, forcing, fragility in evidence_cases:
        item = evidence_from_stats(stats, expected, history, forcing, fragility)
        evidence.append(
            {
                "stats": camel_stats(stats),
                "expected": expected,
                "history": history,
                "forcingDensity": forcing,
                "opponentFragility": fragility,
                "result": evidence_dict(item),
            }
        )

    inference_cases = [
        Evidence(expected=0.5, tension=0.1),
        Evidence(expected=0.6, trend=0.5, enemy_king_pressure=0.9, forcing_density=0.8),
        Evidence(expected=0.2, tension=0.1),
        Evidence(expected=0.9, tension=0.1, phase=0.5),
        Evidence(expected=0.2, tension=0.1, opponent_fragility=0.5),
        Evidence(expected=0.2, tension=0.1, opponent_fragility=-0.5),
        Evidence(
            expected=0.55,
            trend=-0.4,
            tension=0.7,
            own_king_pressure=0.8,
            phase=0.6,
            material_balance=2.0,
        ),
    ]
    inference = []
    for item in inference_cases:
        result = infer_mix(item)
        inference.append(
            {
                "evidence": evidence_dict(item),
                "mix": mix_dict(result),
                "dominant": dominant(result),
            }
        )

    class_cases = [
        ({"phase": 0.10}, 0.50, 0.0),
        ({"phase": 0.80, "tension": 3.0}, 0.50, 0.0),
        ({"phase": 0.80, "tension": 0.0}, 0.50, 0.60),
        ({"phase": 0.80, "tension": 0.0, "own_king_attackers": 2.0}, 0.50, 0.0),
        ({"phase": 0.80}, 0.40, 0.0),
        ({"phase": 0.80}, 0.55, 0.0),
        ({"phase": 0.20, "tension": 5.0}, 0.30, 0.0),
    ]
    classes = [
        {
            "stats": camel_stats(stats),
            "expected": expected,
            "forcingDensity": forcing,
            "class": position_class(stats, expected, forcing),
        }
        for stats, expected, forcing in class_cases
    ]

    fragility_cases = [(0.0, 1.0), (0.3, 0.0), (0.0, 5.0), (0.0, -5.0), (-0.4, 0.2)]
    fragility = [
        {"previous": previous, "loss": loss, "expected": update_fragility(previous, loss)}
        for previous, loss in fragility_cases
    ]

    variety_cases = [
        (0, "Coil", False),
        (100, "Strike", False),
        (100, "Distill", False),
        (100, "Coil", True),
        (50, "Coil", False),
        (100, "Fog", False),
        (30, "Absorb", False),
    ]
    variety = [
        {
            "variety": value,
            "posture": posture,
            "forced": forced,
            "temperature": variety_temperature(value, posture, forced),
        }
        for value, posture, forced in variety_cases
    ]

    strong_strike = {"Strike": 0.80, "Coil": 0.20}
    weak_strike = Evidence(expected=0.60, enemy_king_pressure=0.20)
    immediate_strike = Evidence(expected=0.60, enemy_king_pressure=0.80)
    coily = {"Coil": 0.80, "Distill": 0.05}
    controller_cases: list[dict[str, object]] = []

    controller = PostureController()
    steps = []
    for _ in range(2):
        steps.append({"mix": mix_dict(strong_strike), "evidence": evidence_dict(weak_strike)})
        controller.update(strong_strike, weak_strike)
    controller_cases.append(
        {"name": "inertia", "initialMix": None, "steps": steps, "finalMix": mix_dict(controller.mix)}
    )

    controller = PostureController()
    controller.update(strong_strike, immediate_strike)
    controller_cases.append(
        {
            "name": "immediate-strike",
            "initialMix": None,
            "steps": [
                {
                    "mix": mix_dict(strong_strike),
                    "evidence": evidence_dict(immediate_strike),
                }
            ],
            "finalMix": mix_dict(controller.mix),
        }
    )

    controller = PostureController()
    controller.mix = one_hot("Distill")
    steps = []
    for expected in (0.85, 0.70, 0.50, 0.50):
        item = Evidence(expected=expected)
        steps.append({"mix": mix_dict(coily), "evidence": evidence_dict(item)})
        controller.update(coily, item)
    controller_cases.append(
        {
            "name": "distill-lock-exit",
            "initialMix": mix_dict(one_hot("Distill")),
            "steps": steps,
            "finalMix": mix_dict(controller.mix),
        }
    )

    controller = PostureController()
    empty = Evidence()
    forced_mix = infer_mix(empty)
    controller.update(forced_mix, empty, forced="Fog")
    controller_cases.append(
        {
            "name": "forced-fog",
            "initialMix": None,
            "steps": [
                {
                    "mix": mix_dict(forced_mix),
                    "evidence": evidence_dict(empty),
                    "forced": "Fog",
                }
            ],
            "finalMix": mix_dict(controller.mix),
        }
    )

    return {
        "weights": {posture: dict(WEIGHTS[posture]) for posture in POSTURES},
        "features": list(FEATURES),
        "planTokens": {posture: plan_token(posture) for posture in POSTURES},
        "trend": trend,
        "evidence": evidence,
        "inference": inference,
        "classes": classes,
        "fragility": fragility,
        "variety": variety,
        "controller": controller_cases,
    }


def parse_info_vectors() -> dict[str, object]:
    lines = [
        "info depth 20 seldepth 30 multipv 1 score cp 35 wdl 900 100 0 pv e2e4 e7e5",
        "info depth 20 score cp 35 lowerbound wdl 900 100 0 pv e2e4",
        "info depth 20 score cp 35 upperbound wdl 900 100 0 pv e2e4",
        "info depth 20 score cp 35 wdl 900 100 0",
        "info depth 20 score cp 35 pv e2e4",
        "info depth 20 score cp 35 wdl 0 0 0 pv e2e4",
        "info score cp 35 wdl 900 100 0 pv e2e4",
        "info depth 20 wdl 900 100 0 pv e2e4",
        "info depth 20 score cp 35 wdl 900 100 0 pv e2e4 e7e5 e1e2",
        "info string kairos posture=COIL",
        "info depth 20 multipv 2 score cp -12 wdl 100 800 100 pv g1f3",
        "info depth 20 multipv 3 score mate 4 wdl 1000 0 0 pv e2e4",
        "info depth +20 seldepth +30 multipv +1 score cp +35 wdl +900 +100 0 pv e2e4",
        "info depth 20.5 score cp 35 wdl 900 100 0 pv e2e4",
        "info depth 20 score cp 35.0 wdl 900 100 0 pv e2e4",
        "info depth 20 score cp 35 wdl 900.5 100 0 pv e2e4",
    ]
    cases = []
    for line in lines:
        candidate = parse_info(line)
        cases.append(
            {
                "line": line,
                "candidate": None
                if candidate is None
                else {
                    "multipv": candidate.multipv,
                    "depth": candidate.depth,
                    "move": candidate.move,
                    "scoreKind": candidate.score_kind,
                    "scoreValue": candidate.score_value,
                    "wdl": list(candidate.wdl),
                    "pv": list(candidate.pv),
                },
            }
        )
    return {"cases": cases}


def guard_vectors() -> dict[str, object]:
    result_band_cases = [0.55, 0.45, 0.50, 0.54, 0.56, 0.44, 0.90, 0.10]
    bands = [{"expected": value, "band": result_band(value)} for value in result_band_cases]

    saturation_cases = [0.99, 0.01, 0.985, 0.0101, 0.5, 1.0, 0.0]
    saturation = [
        {"expected": value, "saturated": is_saturated(value)} for value in saturation_cases
    ]

    repetition_board = Board.from_fen(TENSION_FEN)
    repetition_key = repetition_board.apply_uci("c2c4").position_key()
    other_key = repetition_board.apply_uci("e1d2").position_key()
    repetition_cases = [
        ("c2c4", {repetition_key: 2}, 0.65),
        ("c2c4", {repetition_key: 1}, 0.65),
        ("c2c4", {repetition_key: 2}, 0.50),
        ("c2c4", {repetition_key: 2}, 0.49),
        ("c2c4", {other_key: 2}, 0.65),
        ("e2e5", {repetition_key: 2}, 0.65),
    ]
    repetition = [
        {
            "fen": TENSION_FEN,
            "move": move,
            "counts": counts,
            "baselineExpected": baseline,
            "blocked": repetition_blocked(repetition_board, move, counts, baseline),
        }
        for move, counts, baseline in repetition_cases
    ]

    fifty_board = Board.from_fen("4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 90 1")
    early_board = Board.from_fen("4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 89 1")
    fifty_cases = [
        (fifty_board, "e1d2", 0.65),
        (fifty_board, "c2c4", 0.65),
        (fifty_board, "e1d2", 0.50),
        (fifty_board, "e2e5", 0.65),
        (early_board, "e1d2", 0.65),
    ]
    fifty_move = [
        {
            "fen": board.to_fen(),
            "move": move,
            "baselineExpected": baseline,
            "blocked": fifty_move_blocked(board, move, baseline),
        }
        for board, move, baseline in fifty_cases
    ]

    supported_lines = [
        "go depth 4",
        "go depth +4",
        "go depth 4.0",
        "go movetime +2000",
        "go movetime 2000.0",
        "go movetime 2000",
        "go depth 4 movetime 1000",
        "go movetime 1000 depth 4",
        "go wtime 60000 btime 60000 winc 1000 binc 1000",
        "go infinite",
        "go nodes 1000",
        "go mate 3",
        "go perft 5",
        "go movetime 1000",
        "go movetime 1500",
        "go depth 0",
        "go depth",
        "go",
        "go ponder",
        "go searchmoves e2e4",
        "go depth 1",
        "go depth 4 searchmoves e2e4",
    ]
    supported = []
    for line in supported_lines:
        ok, kind, amount = supported_personality_search(line)
        supported.append(
            {
                "line": line,
                "supported": ok,
                "kind": kind if ok else "",
                "amount": amount,
                "reason": "supported" if ok else kind,
            }
        )

    return {
        "resultBand": bands,
        "saturation": saturation,
        "repetition": repetition,
        "fiftyMove": fifty_move,
        "supported": supported,
    }


def all_files() -> dict[str, str]:
    payloads = {
        "board.json": board_vectors(),
        "features.json": feature_vectors(),
        "postures.json": posture_vectors(),
        "parse_info.json": parse_info_vectors(),
        "guards.json": guard_vectors(),
        "probes.json": probe_feature_vectors(),
    }
    return {
        name: json.dumps(data, indent=2, sort_keys=True) + "\n"
        for name, data in payloads.items()
    }


def main() -> int:
    files = all_files()
    if "--check" in sys.argv[1:]:
        for name, content in files.items():
            path = OUT / name
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                print("stale vectors: run python3 scripts/export_web_vectors.py", file=sys.stderr)
                return 1
        print("vectors are fresh")
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (OUT / name).write_text(content, encoding="utf-8")
    print(f"wrote {len(files)} vector files to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

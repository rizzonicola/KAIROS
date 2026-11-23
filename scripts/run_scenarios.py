#!/usr/bin/env python3
"""Run the KAIROS scenario suite against the pinned local Stockfish 19 build.

Writes docs/SCENARIO_RESULTS.md and exits non-zero when a safety check fails.
This is a behavioural smoke test, not an Elo measurement.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "build" / "stockfish19"
OUTPUT = ROOT / "docs" / "SCENARIO_RESULTS.md"

sys.path.insert(0, str(ROOT / "kairos"))
sys.path.insert(0, str(ROOT / "tests"))
from validation import SCENARIOS, parse_chunk, results_markdown, safety_issues  # noqa: E402
from test_protocol import UCIClient  # noqa: E402


def run_scenario(client, scenario):
    client.send("ucinewgame")
    client.send("isready")
    client.read_until(lambda x: x == "readyok", timeout=120)
    client.send(f"setoption name KairosPosture value {scenario.posture}")
    start = client.kairos_log.stat().st_size if client.kairos_log.exists() else 0
    client.send(f"position {scenario.position}")
    client.send(f"go depth {scenario.depth}")
    lines = client.read_until(lambda x: x.startswith("bestmove "), timeout=120)
    with client.kairos_log.open(encoding="utf-8") as handle:
        handle.seek(start)
        chunk = handle.read()
    return parse_chunk(scenario.name, chunk, lines[-1])


def main():
    if not ENGINE.is_file() or not os.access(ENGINE, os.X_OK):
        print(f"missing pinned engine: {ENGINE}", file=sys.stderr)
        return 2
    client = UCIClient(allow_unverified=False, engine=str(ENGINE))
    results = []
    try:
        client.handshake()
        for scenario in SCENARIOS:
            result = run_scenario(client, scenario)
            results.append(result)
            print(
                f"{result.name}: bestmove={result.bestmove} rerank={result.reranked} "
                f"note={result.note} posture={result.posture}"
            )
    finally:
        client.close()

    issues = {result.name: safety_issues(result) for result in results}
    failed = {name: found for name, found in issues.items() if found}
    OUTPUT.write_text(results_markdown(results), encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    for name, found in failed.items():
        for issue in found:
            print(f"SAFETY ISSUE {name}: {issue}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

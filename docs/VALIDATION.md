# Validation

KAIROS is validated behaviourally. There is no Elo claim: the SPRT harness is
provided, but no controlled match result is published yet.

## Fast suite

```bash
python3 -m unittest discover -s tests -v
```

The mock/unit suite is a protocol fixture, not a chess engine. The real suite
runs only when `build/stockfish19` is present and skips otherwise. It checks the
pinned identity, the original NNUE hash, forced `Threads=1`, `KairosStyle=0`
passthrough, a real `searchmoves` rerank, WDL-saturation fallback, movetime
reservation, and `go infinite` → `stop`.

## Scenario suite

```bash
python3 scripts/run_scenarios.py
```

The runner starts the proxy on the pinned local Stockfish 19 build, isolates
each scenario with `ucinewgame`, and records the outcome in
[`SCENARIO_RESULTS.md`](SCENARIO_RESULTS.md). Scenarios cover:

- start position, Queen's Gambit, Italian, pawn endgame, rook endgame;
- forced Distill conversion and forced Fog;
- a mate-in-one position.

It exits non-zero when a safety check fails: malformed `bestmove`, a reranked
pick without verification, a pick that does not match `bestmove`, a verified
loss above the effective budget, a rerank after a mate score, or a rerank during
Distill conversion. Re-run it after changing thresholds, probes, or guards.

## SPRT harness

```bash
scripts/sprt.sh
```

Requires `cutechess-cli` (or `CUTECHESS_CLI`). The script plays pinned
Stockfish 19 against KAIROS with `Threads=1`, `Hash=32`, both colors, and SPRT
bounds `elo0=0`, `elo1=5`, `alpha=beta=0.05`. It writes PGN and KAIROS logs under
`sprt-results/`. Override `KAIROS_SPRT_STYLE`, `KAIROS_SPRT_TC`,
`KAIROS_SPRT_ROUNDS`, or `KAIROS_SPRT_OUT` as needed.

A completed match is the only basis for a strength statement. Until then, treat
every move-quality remark as a hypothesis.

## What is not validated

- The 1.5% corridor, result bands, 50 cp saturation margin, probe thresholds,
  posture constants, and EWMA alpha are engineering conventions, not tuned
  parameters.
- `KairosVariety` sampling is seeded and verified, but its strength effect is
  untested.
- Clock-controlled searches remain passthroughs.
- WASM artifacts are separate builds and are not covered by these tests.

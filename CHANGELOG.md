# Changelog

## v0.1.0 — 2026-11-23

First public release.

- Official Stockfish 19 (`sf_19`, commit
  `edb0d9db6731067ec50ce619ff372b463bc4dd5d`) native build with the original
  `nn-1a298aa575a0.nnue`.
- Standalone Python UCI proxy with forced `Threads=1`; `KairosStyle=0` is an
  exact Stockfish passthrough.
- Nine normalized features: `F_T`, `F_N`, `F_R`, `F_C`, `F_F`, `F_P`, `F_K`,
  `F_S`, `F_I`. Narrowness and prophylaxis are measured with bounded child
  searches and fall back neutrally when data is missing.
- Six postures (`Coil`, `Strike`, `Absorb`, `Reverse`, `Distill`, `Fog`) with
  the specification weight table, evidence-based softmax inference, two-move
  hysteresis, immediate Strike/Absorb overrides and a Distill conversion lock.
- `KairosPosture` and `KairosVariety` UCI options; Coil remains the default.
- Fragility Profile opponent model (EWMA by position class) and seeded softmax
  variety sampling, disabled in Strike/Distill and forced postures.
- Strength guards: WDL Soundness Corridor, result-band guard, WDL-saturation
  margin, `searchmoves` verification, rolling 10-move budget cap,
  third-repetition guard, 50-move reset guard and Distill skip when clearly
  winning.
- Long movetime split: 65% main, 25% probes, 10% verification; short searches
  keep 75% main and skip probes.
- Verbose rationale reports posture, confidence, mix, plan token, tension,
  narrowness, budget, pick, loss and all feature values.
- 84 tests (78 mock/unit, 6 real Stockfish 19), a scenario runner with recorded
  safety results in `docs/SCENARIO_RESULTS.md`, and an optional
  `scripts/sprt.sh` harness. No Elo result is claimed.
- GPL-3.0 license and third-party provenance.
- CI and release workflows, including official Stockfish 19 WebAssembly and
  optional Stockfish 19 Lite WebAssembly builds.

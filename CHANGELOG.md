# Changelog

## Unreleased

Personality implementation:

- Nine normalized features: `F_T`, `F_N`, `F_R`, `F_C`, `F_F`, `F_P`, `F_K`,
  `F_S`, `F_I`. Narrowness and prophylaxis are measured with bounded child
  searches and fall back neutrally when data is missing.
- Six postures (`Coil`, `Strike`, `Absorb`, `Reverse`, `Distill`, `Fog`) with
  the specification weight table, evidence-based softmax inference, two-move
  hysteresis, immediate Strike/Absorb overrides and a Distill conversion lock.
- `KairosPosture` and `KairosVariety` UCI options; Coil remains the default.
- Fragility Profile opponent model (EWMA by position class) and seeded softmax
  variety sampling, disabled in Strike/Distill and forced postures.
- Strength guards: rolling 10-move budget cap, third-repetition guard, 50-move
  reset guard, Distill skip when clearly winning, and the existing corridor,
  result-band, saturation, mate and verification guards.
- Long movetime split: 65% main, 25% probes, 10% verification; short searches
  keep 75% main and skip probes.
- Verbose rationale now reports posture, confidence, mix, plan token, tension,
  narrowness, budget, pick, loss and all feature values.
- Test suite expanded to 72 tests (66 mock/unit, 6 real Stockfish 19).

## v0.1.0 — 2026-11-22

Initial public prototype.

- Official Stockfish 19 (`sf_19`) native build with the original
  `nn-1a298aa575a0.nnue`.
- Standalone Python UCI proxy with forced `Threads=1`.
- Fixed Coil posture: WDL Soundness Corridor, result-band guard, WDL-saturation
  margin, and `searchmoves` verification.
- `KairosStyle=0` exact Stockfish passthrough.
- Feature subset: tension proxy (`F_T`), simplification proxy (`F_S`), and
  initiative proxy (`F_I`).
- 28 mock/unit tests and 6 real Stockfish 19 integration tests.
- GPL-3.0 license and third-party provenance.
- CI and release workflows, including official Stockfish 19 WebAssembly and
  optional Stockfish 19 Lite WebAssembly builds.

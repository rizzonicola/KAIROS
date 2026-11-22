# Changelog

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

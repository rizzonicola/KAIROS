# Audit of KAIROS 0.2.1 (Phase 0)

Method: reading the repository (zip `KAIROS-main`). **Not measured:** the sandbox used for this work
had no network, no Rust toolchain and no npm packages, so the v0.2.1 test suites (84 Python tests,
the Vitest suite) could not be run and no baseline timings exist. The statements below come from
reading the code.

## What v0.2.1 is

A personality layer around unmodified Stockfish: Stockfish (MultiPV 5) supplied every candidate;
KAIROS reranked near-equal ones with nine features and six postures and Stockfish verified the pick.
The web controller (`controller.ts`, about 1 500 lines) was a UCI-line state machine; a Python proxy
did the same natively.

## What worked (kept)

* WDL based expected score, result bands, saturation margin, rolling budget, repetition/50-move
  guards, posture inference with hysteresis, opponent Fragility Profile, softmax variety, restart
  logic in `EngineHost`. All logic of `parse_info`, postures, guards and probes is retained and
  still passes the frozen Python vectors (`web/tests/vectors/legacy-v0.2.1`).
* Strong fallback discipline: any doubt returned Stockfish's move.

## What the proxies got wrong or could not do

* **No own candidates.** Only Stockfish's MultiPV 5 could ever be played, so "disagreement" was bounded
  by what Stockfish already ranked highest.
* **Static feature proxies.** No SEE, no x-ray, no pins through pieces, no real key-file or lever
  analysis; tension, reserve and coordination were counts of attacked/defended squares. The
  README itself said so.
* **Two boards.** `chess.js` in the UI and a hand-rolled `Board` built from the `position` command
  inside the controller path; a correctness risk (castling/en-passant edge cases).
* **Budget ignored the posture.** The single-move budget was always `1.5% x style/100`; the spec
  table (Coil 1.5, Strike 3, Absorb 1, Reverse 2, Distill 0.5, Fog 4) was not applied.
* **One monolithic controller file** mixing handshake, probes, scoring, verification and fallback.
* **Time split** between main search, probes and verification was uncalibrated (it still is).
* **Python parts** (proxy, 84 tests, native build) duplicated the web logic and a parity oracle.

## Risks carried into 0.3

* Rust and WASM code was unverified at audit time; it is now compiled and tested (46 unit + 2 perft,
  WASM conformance; see `docs/VALIDATION.md`).
* Personality weights are small relative to typical expected-score differences, so the disagreement
  rate may be low until calibrated; the match harness measures it (`docs/VALIDATION.md`).
* The Lite network is weaker than the original network used by the removed native build; every
  document now says "Lite network only".

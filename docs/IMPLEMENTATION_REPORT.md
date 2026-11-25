# Implementation report (0.3.0)

Implementation is complete; measured results are in `docs/VALIDATION.md`. Items that were not executed
in this environment are marked explicitly.

## Phase 0 — audit and baseline
`docs/AUDIT.md` (from reading the code), `docs/ADR-0001-architecture.md`. Baseline run: `npm ci`,
`npm run build`, `npm test` (101/101), real Stockfish Lite smoke in Node and browser. **Not done:** the
TS-vs-Rust benchmark.

## Phase 1 — Python/native removal
Removed `kairos/`, Python tests, `run_kairos.sh`, native build, SPRT script, vector exporter, `vectors:check`,
Python/native CI and release steps. v0.2.1 vectors frozen. Old plans moved to `docs/history/`.

## Phase 2 — Rust core scaffold
`kairos-core/` (Cargo, toolchain pin, `types.rs`, `pos.rs`, wasm-bindgen API in `lib.rs`), TypeScript loader
(`core-wasm.ts`), `KairosCore` interface, perft tests (native and through the WASM boundary in
`tests/core.test.ts`). WASM size after `wasm-opt -Oz`: **1,418,257 bytes** (209.40 kB gzip), SHA-256
`1fa22d70b1e21702bdcdb3bece28e03d38b9848b0cc17a270f0b5bdc1f3763e4`.

## Phase 3 — real features
`attacks.rs` (geometry, SEE, landing loss), `features.rs` (Tension Index, nine features, pins, batteries, king
zones, forcing counts). Differences from the proxies: `docs/FEATURES_CHANGELOG.md`. The v0.3 fixture
`web/tests/vectors/v0.3/features.json` was regenerated from the Rust/WASM core (10 positions, 29 moves)
and is checked by `web/tests/core.test.ts`; the v0.2.1 vectors remain frozen and unenforced.

## Phase 4 — own search, proposer, plan
`search.rs` (ID, PVS, TT, quiescence, resumable steps), `eval.rs`, `propose.rs`, `plan.rs`. Tests written for mate in 1/2,
no hanging queen, legality under tiny budgets, resumability, plan lifecycle, proposer classes.

## Phase 5 — controller refactor and judge pipeline
`controller.ts` (handshake, options, passthrough, standalone), `pipeline/{run,baseline,judge,probe,verify,inputs}.ts`,
`scoring.ts`, `guards.ts` (`corridorCheck` shared by judge and verification), `uci.ts`, `types.ts`. Posture budgets
fixed. The mock engine supports `searchmoves`, MultiPV, WDL, depth control, partial iterations, bounds and holds.
101 tests pass with the real packages, the Rust/WASM core and Stockfish Lite.

## Phase 6 — UI
Not required by the owner ("only the engine"), but done: badge, Independence, undo, expandable rationale, mobile CSS.
Side selection already existed. Playwright: 6/6 browser tests pass (ready 101–108 ms, think ~1.46 s); both WASM
modules are served over HTTP. Browser memory and UI responsiveness were not measured.

## Phase 7 — validation
Match harness and statistics written. The 20-game run at 2000 ms/move is recorded in `docs/VALIDATION.md`:
0 W / 20 D / 0 L against Stockfish Lite, 12.80% disagreement, 7.91% out of Stockfish's top 3, rerank loss
3.02% mean. The fingerprint is mixed (Tension p ≈ 0.78, earlier queen trades, less late release than
Stockfish); with 20 games its p-values are descriptive only, not an Elo or identity claim.

## Phase 8 — packaging and CI
Scripts and launchers were run locally: WASM build, web build, UCI build and smoke test, browser suite. CI and
release workflows have **not** been executed on GitHub. The UCI engine (`web/tools/uci-node.ts`) is the primary
deliverable; its peak RSS in the smoke run was 136,776 KB (Node + Stockfish Lite + core, `Hash` 16 MB).

## Known weaknesses
Uncalibrated thresholds, time split and personality scale; standalone mode has no personality; UCI engine needs
Node >= 20; clock-based time controls below 1.5 s per move are played by plain Stockfish; `ponder` unsupported;
no opening book; exchange sacrifices are not measured by the fingerprint; browser memory and long-session UI
responsiveness are unmeasured.

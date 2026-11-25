# Verification handoff

> **Verification result (2026-11-25):** the checklist below was executed in a full environment. Measured
> numbers are in `docs/VALIDATION.md`. Summary: Rust 46 unit + 2 perft tests pass; WASM core 1,418,257
> bytes after `wasm-opt`; web 101/101 tests; browser 6/6 (ready 101–108 ms, think ~1.46 s); UCI build and
> smoke test pass (peak RSS 136,776 KB); v0.3 feature fixture regenerated and enforced; 20-game match
> complete (all draws; metrics in `docs/VALIDATION.md`). CI/release workflows were not executed on
> GitHub. The statuses below describe the pre-verification state and are kept for history.

A second agent with a full toolchain must verify this work. **Nothing below is marked COMPILED or TESTED
unless it was actually run**, and the sandbox that produced this code had no `rustc`/`cargo`, no network,
no npm registry and no Stockfish files.

## 1. Status

Legend: WRITTEN, SYNTAX-REVIEWED (re-read for type/ownership/borrow/import errors), COMPILED, TESTED.
"TS-CHECKED" = `tsc --noEmit` (TypeScript 6.0.3) passed against stubs for `chess.js`, `vitest` and the
wasm-bindgen glue. "SHIM-TESTED" = tests passed under a `node:test` shim of the vitest API.

| Item | Status |
|---|---|
| `kairos-core/Cargo.toml`, `rust-toolchain.toml` | WRITTEN (no Cargo.lock: generate it) |
| `kairos-core/src/types.rs`, `attacks.rs`, `eval.rs` | WRITTEN, SYNTAX-REVIEWED (PST arrays counted: 64 entries each; a script confirmed balanced brackets in every `.rs` file — this is not a parse) |
| `kairos-core/src/pos.rs` (cozy-chess wrapper) | WRITTEN, SYNTAX-REVIEWED; 10 `VERIFY-API` markers |
| `kairos-core/src/features.rs`, `plan.rs`, `propose.rs`, `search.rs`, `lib.rs` | WRITTEN, SYNTAX-REVIEWED |
| Rust unit tests and `tests/perft.rs` | WRITTEN (never run; expected values are the published perft counts) |
| `scripts/build_core.sh`, `fetch_engine.sh`, `build_uci.sh`, `build_web.sh`, launchers | WRITTEN, `bash -n` passed; not run |
| `web/src/*.ts` (controller, pipeline, scoring, guards, uci, core, core-wasm, worker, main, strings) | WRITTEN, TS-CHECKED (`main.ts` against a stub `chess.js` with known stub-only errors) |
| Controller pipeline | SHIM-TESTED (41 controller tests with scripted core/engine) |
| Frozen v0.2.1 vectors (parse_info, postures, guards, probes) | SHIM-TESTED |
| `web/tools/uci-node.ts` (UCI engine) | WRITTEN, TS-CHECKED; handshake output run against a stubbed glue (`uci` -> `uciok`, fatal exit without wasm); `convertGo` SHIM-TESTED; search path never run |
| `web/tools/match.ts`, `engine.ts`, `session.ts` | WRITTEN, TS-CHECKED; never run |
| `web/tests/core.test.ts`, `e2e.test.ts` | WRITTEN, TS-CHECKED; skipped until artefacts exist |
| `web/browser-tests/*.spec.ts` | WRITTEN (updated); never run |
| CI and release workflows | WRITTEN; never run |
| Docs | WRITTEN |

## 2. Commands to run, in order

```bash
# 0. toolchain
rustup toolchain install 1.85.0 --target wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100 --locked      # must equal kairos-core/Cargo.toml
sudo apt-get install binaryen                                   # wasm-opt (optional but expected)
# 1. Rust: expect compile errors first (see section 4), then all tests green
cd kairos-core && cargo generate-lockfile && cargo test --release     # includes perft: startpos d5, kiwipete d4, ...
cd ..
# 2. WASM build; expect kairos_core_bg.wasm (record its size) in web/src/core/pkg and web/public/engine
scripts/build_core.sh
# 3. Stockfish Lite files; then pin the printed sha256 in scripts/engine.lock
scripts/fetch_engine.sh
# 4. Web
cd web && npm ci && npm run build && npm test
#    expected: all suites green; core.test.ts and e2e.test.ts no longer skipped
# 5. UCI engine
cd .. && scripts/build_uci.sh test
(printf 'uci\nisready\nposition startpos moves e2e4\ngo movetime 2000\n') | dist/kairos-uci-test/kairos
#    expected: uciok, readyok, info lines, "info string kairos ...", bestmove <legal move>
# 6. Match harness (writes match-results/*.json); then fill docs/VALIDATION.md
cd web && node tools/run-ts.mjs tools/match.ts --games 20 --movetime 2000 --out ../match-results/first.json
# 7. Browser
npx playwright install chromium && npm run test:browser
# 8. Fixture regeneration (features changelog)
#    write a small script printing core.features(move) for the positions of the old features.json
#    and diff against docs/FEATURES_CHANGELOG.md
```

## 3. Not executed (and why)

Everything that needs `cargo`, `wasm-bindgen`, `wasm-opt`, the npm registry or Stockfish: Rust compile and
tests, perft, the WASM build and its size, `npm ci`/`npm run build`, real vitest, Playwright, the match
harness, the Phase 0 TS-vs-Rust benchmark, WASM size/performance/memory measurements, and any test of the
full UCI search path. Network was off; `chess.js`, `vitest`, `vite` were not installed.

## 4. Known risk spots

* **cozy-chess API assumptions** (`VERIFY-API` in `pos.rs`, `eval.rs`, `search.rs`, `propose.rs`): `Board::from_fen(&str, bool)`,
  `generate_moves` closure signature, `play_unchecked`, `hash`, `checkers().0`, `colors(..).0`/`pieces(..).0`
  (public `BitBoard.0`), `Square::ALL` + `file()/rank()` and bit index = `Square::ALL` index,
  `null_move()`, `halfmove_clock()`, public `Move` fields, **castling encoded as king-takes-own-rook**.
  `pos.rs::tests::square_layout_is_lerf` and `eval.rs` tests will expose layout mistakes quickly.
* wasm-bindgen 0.2.100: `init({ module_or_path })` accepting a `Response` or bytes; `&[f64]` argument;
  generated `.d.ts` names (`set_position`, ...) used by `core-wasm.ts`. `cargo` pins are exact; update both
  the crate and the CLI together.
* Search: the step/abort scheme re-enters an aborted iteration with a warm TT (tests:
  `search::tests::step_is_resumable`). Mate scores in TT are ply-adjusted.
* Features: normalisation scales and the personality scale are **uncalibrated**; the disagreement rate may
  turn out too low or too high. Measure with the match harness before tuning anything.
* `Pos` keeps its own castling/ep/clock bookkeeping beside cozy's board (for FEN output); the FEN
  round-trip tests and perft through the UCI layer guard it.
* The UCI engine converts clocks to `movetime`; personality needs >= 1.5 s per move.
* Browser: the init timer (10 s x 2) before the standalone switch; `EngineHost` restart semantics unchanged.
* Stockfish.js under Node (`tools/node-engine.ts`) is assumed to run as `node stockfish-19-lite-single.js`.

## 5. Files the verifier must obtain or produce

* `web/public/engine/stockfish-19-lite-single.js` and `.wasm` (`scripts/fetch_engine.sh`, or `scripts/build_wasm.sh lite`).
* `kairos-core/Cargo.lock` (commit it), the pinned SHA-256 in `scripts/engine.lock`, and an updated
  `web/package-lock.json` only if `npm ci` complains (no dependency was added).
* The full SHA-256 of the Lite network `nn-61e7af4bb97d.nnue` for `THIRD_PARTY.md`.

## 6. Delivery checklist (section 12) status

- [x] Python and native code removed; CI rewritten without them (CI itself not run).
- [ ] `kairos-core` compiled, perft-verified, WASM size reported — **unverified**.
- [ ] Stockfish Lite used as judge + verifier + safety net with KAIROS proposals outside the top 5 — logic written and
      mock-tested; real-engine test written, **not run**.
- [ ] Standalone mode with the real core — controller path SHIM-TESTED with a scripted core; own search **not run**.
- [x] Section 6 invariants enforced by tests (`controller.test.ts`, `assertSafety`) — SHIM-TESTED.
- [ ] Scenario suite, real-engine tests and match harness run; `docs/VALIDATION.md` filled — **not run**.
- [x] UI additions (side selection existed; Independence, undo, badge, rationale) — written, type-checked, browser not run.
- [ ] Static bundle builds from a clean checkout — scripts written, **not run**.
- [x] Docs updated.
- [x] Final report lists measured / not measured / weaknesses / files to supply.

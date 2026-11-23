# Changelog

## v0.2.1 — 2026-11-23

Reliability and transparency fixes for KAIROS Web Lite.

- Controller-worker failures now recreate the whole controller/engine stack
  once; a second failure blocks the page behind an explicit Retry.
- The watchdog sends `stop`, waits a two-second grace period, then recreates
  the stack once before blocking. Retry resets the restart budget.
- New Game cannot clear a blocked engine or its alert; the button is disabled
  while the Retry banner is shown, and side changes revert.
- Recoverable engine errors clear the thinking state and watchdog instead of
  leaving the page stuck.
- The rationale panel shows posture, confidence, plan, posture mix, rolling
  budget, measured loss, selected candidate and the nine personality features.
- Fallback rationales report the measured expected-score loss, `pick: 1`, and
  omit features from rejected candidates.
- `info` parsing accepts `+N` integers and rejects float depth, score and WDL
  values, matching the Python oracle.
- Python-generated vectors cover probe feature formulas and the new parser
  cases.
- End-to-end parity now includes a real MultiPV rerank and an exact
  `KairosStyle=0` passthrough against the Python oracle.
- `EngineHost.restart()` refuses to restart a terminated host.
- CI downloads the Lite archive under the name recorded in `SHA256SUMS`.
- README provenance now names `nmrugg/stockfish.js` `v19.0.1` and the Lite
  network instead of implying the pinned native build.

## v0.2.0 — 2026-11-23

KAIROS Web Lite, the primary browser target.

- Standalone TypeScript page running the KAIROS personality around Stockfish 19
  Lite single-threaded WASM; no Python, backend, `SharedArrayBuffer`, or
  COOP/COEP.
- Full native pipeline in the browser: MultiPV rerank, Soundness Corridor,
  result-band and WDL-saturation guards, optional probes, `searchmoves`
  verification, rolling budget, repetition and 50-move guards, Distill skip,
  seeded variety.
- `KairosStyle=0` remains an exact Stockfish bestmove passthrough.
- Structured rationale for every engine move, including fallbacks and
  passthroughs; stale-result filtering with request ids.
- Python parity vectors, a scripted controller suite, same-engine end-to-end
  tests against the Python oracle, and a Playwright browser smoke test.
- Release asset `kairos-lite-web-v0.2.0.tar.gz`; native archive no longer
  contains `__pycache__`.

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

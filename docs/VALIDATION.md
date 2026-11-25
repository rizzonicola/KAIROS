# Validation

Measured on 2026-11-25 (Linux x86_64, NixOS; Rust 1.85.0, wasm-bindgen 0.2.100, wasm-opt 133,
Node 24.22.2, Chromium 157.0.8103.78). Every number below comes from a run in this environment; anything
not run is listed as not measured.

## Build artefacts

| Artefact | Size | SHA-256 |
|---|---|---|
| `kairos_core_bg.wasm` | 1,418,257 bytes (209.40 kB gzip) | `1fa22d70b1e21702bdcdb3bece28e03d38b9848b0cc17a270f0b5bdc1f3763e4` |
| `stockfish-19-lite-single.js` | 28,230 bytes | `ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a` |
| `stockfish-19-lite-single.wasm` | 1,845,971 bytes | `ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de` |
| Stockfish Lite archive | 1,229,338 bytes (download) | `f0b4bece700b0133b5d60189966894717ed07117dcbaea6e29aa5cbb70babe4a` |
| Lite network `nn-61e7af4bb97d.nnue` | 1,166,381 bytes | `61e7af4bb97d51eeeb25d322916f86513b5cd3a827ce189c98c6e31946f99e5b` |

`scripts/build_core.sh` ran `cargo build --release --target wasm32-unknown-unknown` from
`kairos-core/` (so `rust-toolchain.toml` is honoured) and `wasm-opt -Oz`; the size above is the optimized
output copied to both `web/src/core/pkg` and `web/public/engine`.

## Test suites (executed)

| Suite | Command | Result |
|---|---|---|
| Rust unit tests | `cd kairos-core && cargo test --release` | 46 passed |
| Perft (raw board + UCI layer: startpos d5, Kiwipete d4, CPW 3-6) | same run (`tests/perft.rs`) | 2 passed |
| Controller, vectors, UCI clock, stats, WASM conformance, real Stockfish + core | `cd web && npm test` | 10 files, 101 tests passed (~9.5 s) |
| Browser smoke (move cycle, standalone fallback, style-0 passthrough, undo, stale reply, watchdog) | `cd web && npm run test:browser` | 6 tests passed (14.6 s) |
| UCI build + handshake | `scripts/build_uci.sh test` and a `uci`/`isready`/`go movetime 2000` pipe | `uciok`, `readyok`, legal `bestmove e7e6 ponder d2d4`, `info string kairos fallback ...` |

The WASM conformance suite includes perft through the WASM boundary (startpos d4 = 197,281; Kiwipete
d3 = 97,862), legal-move/FEN agreement with chess.js over 150 random games, and the regenerated v0.3
feature fixture (10 positions, 29 moves). The real-engine suite runs Stockfish Lite under Node and
checks style-0 passthrough, scenario safety, a real `searchmoves` judge outside Stockfish's top 5, and
saturated winning positions.

## Browser measurements

| Metric | Result |
|---|---|
| Ready time (page load to first `ready`) | 101–108 ms (two runs) |
| Think time (default 2 s budget, first reply) | 1,457–1,458 ms (two runs) |
| Both WASM modules served over HTTP | 200 (`stockfish-19-lite-single.wasm`, `kairos_core_bg.wasm`) |
| Browser JS heap / WASM memory | not measured |

## UCI engine

| Metric | Result |
|---|---|
| Peak RSS (Node + Stockfish Lite + core, `Hash` 16 MB; `/usr/bin/time -v`) | 136,776 KB |
| Handshake and first search | `uciok`, `readyok`, `info string kairos ...`, legal `bestmove` |
| `KairosStyle=0` passthrough | same `bestmove e7e5 ponder g1f3` as plain Stockfish at 2000 ms (after `e2e4`) |
| Clock command (`go wtime 60000 btime 60000`) | legal `bestmove e7e6 ponder d2d4` |
| Sub-1.5 s move (`go movetime 500`) | `info string kairos stockfish time-too-low ...`, legal `bestmove e2e4` |
| Missing `kairos_core_bg.wasm` | `info string fatal: ...`, exit status 1 |
| Missing Stockfish files | `info string KAIROS standalone: own search only (Stockfish not available)`, legal `bestmove b8c6` |
| `ponder` | unsupported (documented) |

## Match harness

Command:

```bash
cd web && node tools/run-ts.mjs tools/match.ts --games 20 --movetime 2000 --out ../match-results/first.json
```

It plays KAIROS against plain Stockfish Lite at identical movetime, both colours, fixed openings, and
reports score and game length; **disagreement rate** (played != Stockfish best); **out-of-top-3 rate**;
verified-loss distribution (mean, p95); blunder rate (analysis drop > 150 cp per 1000 moves); and the
identity fingerprint (mean Tension Index at plies 20-40, late-release rate, first queen-trade ply,
narrowness faced by the opponent). **No Elo claim is made.** With fewer than 500 games the p-values are
descriptive only (the specification's p < 0.01 claim needs 500+ games).

| Metric | Result |
|---|---|
| Config | 20 games, 2000 ms/move, style 50, independence 50, variety 0, analysis depth 10 |
| Games | 20 complete: 0 W / 20 D / 0 L, 10/20 points, mean 142.45 plies |
| Disagreement rate | 12.80% (1,383 KAIROS moves) |
| Out-of-top-3 rate | 7.91% |
| Reranks | 177, of which 173 came from a KAIROS proposal |
| Verified loss, all moves (mean / p95) | 0.39% / 0% |
| Verified loss, rerank moves (mean / p95) | 3.02% / 20.0% |
| Blunders per 1000 moves (KAIROS / Stockfish) | 0.72 / 1.44 (drop > 150 cp at depth 10) |
| Fingerprint: Tension Index, plies 20-40 | KAIROS 1.63, Stockfish 1.67 (p ≈ 0.78) |
| Fingerprint: late-release rate | KAIROS 4.4%, Stockfish 9.7% |
| Fingerprint: opponent narrowness (Stockfish facing KAIROS / KAIROS facing Stockfish) | 0.195 / 0.257 (p ≈ 8e-6) |
| Fingerprint: first queen-trade ply | KAIROS 49.1, Stockfish 57.4 |

In this sample KAIROS drew every game against Stockfish Lite at the same 2 s/move and lost no game. The
identity fingerprint is mixed: Tension at plies 20-40 is statistically indistinguishable, KAIROS released
captures less often (not later), traded queens earlier, and the positions it left Stockfish were *less*
narrow than the ones it faced. The narrowness p-value uses clustered plies from 20 games and is not a
population claim. These are descriptive numbers, not evidence of personality strength or of the
specification's identity thresholds.

## Not measured

* Browser memory, long-session UI responsiveness, mobile hardware.
* Match fingerprint p-values and any Elo estimate (20 games are descriptive only).
* Time split (35/30/20/15 with probes, 40/32/14x2 without) and every threshold (corridor, bands, margins,
  EWMA constants, personality scale) remain uncalibrated conventions; change them only with measurements
  recorded here.

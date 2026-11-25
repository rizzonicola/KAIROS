# KAIROS — The Tension Economist

KAIROS is a **UCI chess engine with a personality**, used like Stockfish: point any
UCI GUI, `cutechess-cli` or bot wrapper at the `kairos` launcher. It plays sound
moves, but it does not blindly follow the engine's first line: it builds its own
candidate moves from a plan (tension, narrowness, reserve pieces, prophylaxis),
lets **Stockfish 19 Lite** judge them with `go ... searchmoves`, and plays a
non-best move only when a verification search proves it is within a small
expected-score budget. A browser page (optional) runs the same engine locally.

> **Status: 0.3.0 — verified locally (2026-11-25).** Rust unit tests and perft pass, the WASM core is
> built and conformance-tested, the web suite is 101/101, the browser suite 6/6 and the UCI engine
> builds and answers a real search. Measured numbers and what remains unmeasured are in
> [`docs/VALIDATION.md`](docs/VALIDATION.md). No Elo or strength claim is made anywhere.

## What it is

- **Own board and features** — a Rust core (`kairos-core/`, compiled to WebAssembly)
  built on the `cozy-chess` move generator owns the board, SEE, attack maps, pins,
  king zones, the nine features, a persistent *plan token*, a candidate proposer and a
  small interruptible search.
- **Stockfish as judge, verifier and safety net** — Stockfish 19 Lite (single thread,
  unmodified) scores KAIROS' candidates in one `searchmoves` search and verifies the
  pick. It never decides alone, and any uncertainty returns *Stockfish's* best move.
- **Standalone fallback** — without Stockfish (missing file, crash) KAIROS keeps playing
  legal, tactically sane chess with its own shallow search, and says so (`info string`).
- **Six postures** — Coil, Strike, Absorb, Reverse, Distill, Fog — inferred from the game.
- `KairosStyle 0` is an exact Stockfish passthrough.

KAIROS is **not** a stronger Stockfish and not a Stockfish replacement: playing strength
comes from Stockfish; KAIROS chooses *which* sound move.

## Use it as a UCI engine

```bash
scripts/build_core.sh          # Rust -> WASM (needs rustup, wasm-bindgen-cli 0.2.100)
scripts/fetch_engine.sh        # pinned Stockfish 19 Lite files (verifies SHA-256)
cd web && npm ci && cd ..
scripts/build_uci.sh 0.3.0     # dist/kairos-uci-0.3.0.tar.gz   (runs with Node >= 20)
tar xzf dist/kairos-uci-0.3.0.tar.gz && ./kairos-uci-0.3.0/kairos
```

Details, options and `cutechess-cli` examples: [`docs/UCI.md`](docs/UCI.md).
Personality searches need at least 1.5 s per move; shorter limits are played by plain
Stockfish.

## Optional browser page

`scripts/build_web.sh <tag>` produces `kairos-web-<tag>.tar.gz` (any static host, no special
headers, no `SharedArrayBuffer`, mobile-first). See [`web/README-WEB.md`](web/README-WEB.md).

## Layout

| Path | Content |
|---|---|
| `kairos-core/` | Rust crate: board service, SEE/features, plan, proposer, own search, perft tests |
| `web/src/` | Controller (staged pipeline), core interface, worker plumbing, UI |
| `web/tools/` | UCI engine (`uci-node.ts`), match harness, Node helpers |
| `web/tests/` | Vitest suites (mock engine/core, frozen v0.2.1 vectors, core and real-engine tests) |
| `scripts/` | build, fetch and packaging scripts |
| `KAIROS_SPECIFICATION.md` | design bible (v0.3 appendix at the end) |
| `docs/` | audit, ADR, features changelog, validation, handoff |

## Provenance

Stockfish.js `v19.0.1` (Stockfish 19, Lite network `nn-61e7af4bb97d.nnue`), unmodified;
Rust crates `cozy-chess` (MIT) and `wasm-bindgen` (MIT/Apache-2.0). See
[`THIRD_PARTY.md`](THIRD_PARTY.md). Licence: GPL-3.0 (`LICENSE`).

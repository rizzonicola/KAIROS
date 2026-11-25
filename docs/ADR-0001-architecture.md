# ADR-0001: Architecture of KAIROS 0.3

Status: accepted (decision gate **not** benchmarked, see below)

## Context

The owner wants an engine that feels like its own: it must propose its own candidate moves, use
Stockfish only as judge/verifier/safety net, stay playable without Stockfish, and run as a plain UCI
engine (and optionally in a browser) with Stockfish 19 Lite single-threaded WASM.

## Options

A. TypeScript only; B. Rust core to WASM beside Stockfish Lite; C. fork Stockfish; D. Go/TinyGo core.

## Decision

**B.** A `kairos-core` Rust crate (`cozy-chess` for legal moves, `wasm-bindgen` for the API) owns the
board, SEE/features, plan, proposer and a small interruptible search; the TypeScript controller owns
the UCI state machine and the Stockfish pipeline. The core sits behind the `KairosCore` TypeScript
interface (`web/src/core.ts`), so another backend (a TypeScript core, Plan B) could be swapped in and
cross-checked in tests. Tests use a scripted `MockCore`.

Rejected: C (heavy toolchain, decision still inside Stockfish), D (GC and larger/less predictable WASM),
A as the primary path (duplicate board logic, slower search); A remains the documented Plan B.

## Phase 0 benchmark

The planned TS-vs-Rust search benchmark was **not run**. The WASM size was measured on 2026-11-25:
**1,418,257 bytes** (209.40 kB gzip), SHA-256 `1fa22d70b1e21702bdcdb3bece28e03d38b9848b0cc17a270f0b5bdc1f3763e4`.
No speed comparison exists, so the decision still rests partly on engineering judgement; if the WASM
speed proves unacceptable, revisit this ADR.

## Consequences

* Two WASM files (Stockfish Lite, `kairos_core_bg.wasm`) in two workers (web) or a worker plus a child
  process (UCI). No `SharedArrayBuffer`, no threads, no special headers.
* The own search is deliberately modest (scope guard): iterative deepening, PVS, TT, quiescence,
  killer/history ordering. No null move, no tuning, no strength goal.
* Stockfish's soundness verdict is never overridden: every non-best move is verified with a measured
  loss inside the corridor (`guards.ts: corridorCheck`, enforced by `tests/controller.test.ts`).

# Third-party components

KAIROS is licensed under GPL-3.0. The release artifacts include or depend on the
following components. This file records provenance; it is not a substitute for
the licenses themselves.

## Stockfish 19 Lite (Stockfish.js WebAssembly build) — judge, verifier and safety net

- Upstream: <https://github.com/nmrugg/stockfish.js>
- Tag: `v19.0.1`
- Commit: `0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`
- License: GPL-3.0 for the engine; MIT for the non-engine glue. The distributed
  engine artifacts are GPL-3.0 because they contain Stockfish.
- Lite network: `nn-61e7af4bb97d.nnue`, downloaded by the upstream build script
  from the Stockfish Fishtest network server.

KAIROS uses only the `lite-single` artefact (single thread, no `SharedArrayBuffer`) and runs it
unmodified, as a Web Worker (browser) or a Node child process (UCI engine). It uses the Lite network,
which is weaker than the original Stockfish 19 network; the original network is not used. The network
file `nn-61e7af4bb97d.nnue` has SHA-256
`61e7af4bb97d51eeeb25d322916f86513b5cd3a827ce189c98c6e31946f99e5b` (1,166,381 bytes, downloaded from
the Stockfish Fishtest network server on 2026-11-25). The release archive hash is pinned in
`scripts/engine.lock`.

## Emscripten

- Upstream: <https://github.com/emscripten-core/emscripten>
- Used to compile the WebAssembly artifacts.
- License: MIT / University of Illinois Open Source License.

## Node.js

- Upstream: <https://nodejs.org/>
- Runs the UCI engine and the tests. Node.js is not distributed in the release archives (>= 20 required).

## Rust crates (compiled into `kairos_core_bg.wasm`)

- `cozy-chess` 0.3.4 — <https://github.com/analog-hors/cozy-chess> — MIT. Legal move generation, hashing, FEN.
- `wasm-bindgen` 0.2.100 — <https://github.com/rustwasm/wasm-bindgen> — MIT OR Apache-2.0. JS bindings.
  The `wasm-bindgen` CLI version must equal the crate pin. Transitive dependencies are listed in the
  committed `kairos-core/Cargo.lock`.

## npm packages (build/test only; the UCI engine bundle contains only the TypeScript sources)

`chess.js` (BSD-2-Clause, UI input), `vite`, `vitest`, `typescript`, `@playwright/test`, `@types/node`;
`esbuild` (MIT) is used by Vite and directly by `web/tools/bundle-uci.mjs`.

## References

- Stockfish compiling guide:
  <https://official-stockfish.github.io/docs/stockfish-wiki/Compiling-from-source.html>
- Stockfish Fishtest networks:
  <https://tests.stockfishchess.org/nns>
- GPL-3.0:
  <https://www.gnu.org/licenses/gpl-3.0.html>

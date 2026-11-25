# WebAssembly components

KAIROS ships two WebAssembly modules and no native binary.

| File | Origin | Purpose |
|---|---|---|
| `engine/stockfish-19-lite-single.js` + `.wasm` | `nmrugg/stockfish.js` tag `v19.0.1` (Stockfish 19), Lite, single thread | judge, verifier, safety net |
| `engine/kairos_core_bg.wasm` | `kairos-core/` (Rust, `wasm32-unknown-unknown`, wasm-bindgen 0.2.100) | board, features, plan, proposals, own search |

**Network:** Lite only (`nn-61e7af4bb97d.nnue`, embedded in the Stockfish.js build), SHA-256
`61e7af4bb97d51eeeb25d322916f86513b5cd3a827ce189c98c6e31946f99e5b` (1,166,381 bytes). The original
network of the removed native build is not used anywhere.

**Provenance and integrity.** `scripts/fetch_engine.sh` downloads the Lite single-thread archive of the
KAIROS `v0.1.0` release, checks it against the release `SHA256SUMS`, and compares it with the hash pinned in
`scripts/engine.lock` (set `KAIROS_REQUIRE_PIN=1` to refuse unpinned artefacts). The pinned archive SHA-256
is `f0b4bece700b0133b5d60189966894717ed07117dcbaea6e29aa5cbb70babe4a`; the extracted files have SHA-256
`ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a` (JS) and
`ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de` (WASM). `scripts/build_wasm.sh lite`
rebuilds the same files from source (Emscripten 6.0.9). The Stockfish files and network are never modified.

**Requirements.** The page and the UCI engine need no `SharedArrayBuffer`, no COOP/COEP, no threads. All
asset URLs are relative (`base: "./"`), so sub-path hosting works; `file://` does not load WebAssembly.

**Loading the core.** `core-wasm.ts` fetches `engine/kairos_core_bg.wasm` and lets the wasm-bindgen glue
use `WebAssembly.instantiateStreaming`, falling back to `arrayBuffer()` when the server sends the wrong
MIME type (the glue does this, and `loadWasmCore` retries once from bytes). Under Node (UCI engine, tests)
the bytes are read from disk.

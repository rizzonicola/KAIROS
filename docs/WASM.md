# WebAssembly builds

Release WebAssembly artifacts are **Stockfish 19 engines**, not the Python KAIROS
personality layer. They are useful for web/Node.js frontends that need a local
engine. The native KAIROS wrapper still requires Python and a native Stockfish
binary.

## Flavors

| Flavor | Source | Threads | Network | Cross-origin isolation |
|---|---|---:|---|---|
| `stockfish-19-wasm32` | official Stockfish `sf_19` | yes | original `nn-1a298aa575a0.nnue` | required |
| `stockfish-19-wasm32-relaxed-simd` | official Stockfish `sf_19` | yes | original network | required |
| `stockfish-19-lite` | `nmrugg/stockfish.js` `v19.0.1` | yes | lite `nn-61e7af4bb97d.nnue` | required |
| `stockfish-19-lite-single` | `nmrugg/stockfish.js` `v19.0.1` | no | lite network | **not required** |

The official builds are compiled with `ARCH=wasm32` (or
`wasm32-relaxed-simd`) and `EXTRALDFLAGS="--preload-file nn-1a298aa575a0.nnue"`.
The lite builds are compiled by the upstream `stockfish.js` build script with
`--lite` and, for the single-threaded flavor, `--single-threaded`.

The lite flavors use a different, smaller network. They are intentionally
separate from the pinned native KAIROS engine and must not be described as
using the original Stockfish 19 network.

## Node.js smoke test

Official multithreaded build:

```bash
printf 'uci\nisready\nposition startpos\ngo depth 8\nquit\n' | node stockfish.js
```

Lite single-threaded build:

```bash
printf 'uci\nisready\nposition startpos\ngo depth 8\nquit\n' | node stockfish-19-lite-single.js
```

The engine should print `id name Stockfish 19`, `uciok`, `readyok`, and a
`bestmove` line. The official `stockfish.js` expects its `.wasm`, `.data`, and
network files next to it.

## Browser

Serve the files with correct MIME types:

- `.js` → `text/javascript`
- `.wasm` → `application/wasm`
- `.data` → `application/octet-stream`

For the multithreaded flavors, the server must also send:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The `lite-single` flavor runs without those headers. It is the recommended
starting point for a simple browser integration. See the
[`stockfish.js` examples](https://github.com/nmrugg/stockfish.js/tree/master/examples)
for a worker/loader implementation; the generated lite files use the same
`postMessage` interface as the upstream project.

## Build locally

Install Emscripten (the release workflow uses `6.0.9`), then:

```bash
source /path/to/emsdk/emsdk_env.sh
./scripts/build_wasm.sh official wasm32
./scripts/build_wasm.sh official wasm32-relaxed-simd
./scripts/build_wasm.sh lite
```

Artifacts are written to `dist/`. The script verifies the official Stockfish
tag/commit/network before compiling and pins the `stockfish.js` tag for the lite
builds.

## License

The WebAssembly artifacts contain Stockfish and are GPL-3.0. See
[`../LICENSE`](../LICENSE) and [`../THIRD_PARTY.md`](../THIRD_PARTY.md).

# Releasing

The release workflow is `.github/workflows/release.yml`. It runs when a GitHub
release is published, and can also be started manually with an existing tag.

## Create a release

```bash
git tag -a v0.1.0 -m "KAIROS 0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "KAIROS 0.1.0" --notes-file CHANGELOG.md
```

Publishing the release starts two build jobs:

1. **Native Linux x86-64** — builds official Stockfish 19 with
   `scripts/build_stockfish19.sh`, runs the full test suite, and packages
   KAIROS, the launcher, the engine, tests, and docs.
2. **WebAssembly** — installs Emscripten, builds official Stockfish 19 for
   `wasm32` and `wasm32-relaxed-simd`, then builds the `stockfish.js` v19.0.1
   lite and lite-single flavors.

The publish job adds the archives and `SHA256SUMS` to the release. No secrets
are needed beyond `GITHUB_TOKEN`; the workflow has `contents: write`.

## Manual re-run

```bash
gh workflow run release.yml -f tag=v0.1.0
```

The tag must already have a published GitHub release, because the final job
uploads assets to it.

## Artifact layout

| Asset | Build |
|---|---|
| `kairos-<tag>-linux-x86_64.tar.gz` | Native KAIROS + official Stockfish 19. |
| `stockfish-19-wasm32.tar.gz` | Official Stockfish 19, multithreaded WASM. |
| `stockfish-19-wasm32-relaxed-simd.tar.gz` | Official Stockfish 19, relaxed SIMD WASM. |
| `stockfish-19-lite.tar.gz` | `stockfish.js` lite, multithreaded. |
| `stockfish-19-lite-single.tar.gz` | `stockfish.js` lite, single-threaded, no `SharedArrayBuffer`. |
| `SHA256SUMS` | SHA-256 of every archive. |

The lite artifacts use a smaller network and are separate from the validated
native build. Do not describe them as using the original Stockfish 19 network.

## Local reproduction

```bash
./scripts/build_stockfish19.sh
python3 -m unittest discover -s tests -v

source /path/to/emsdk/emsdk_env.sh
./scripts/build_wasm.sh official wasm32
./scripts/build_wasm.sh official wasm32-relaxed-simd
./scripts/build_wasm.sh lite
```

The scripts pin the upstream tags and commits and fail on a mismatch. They do
not install compilers or Emscripten automatically.

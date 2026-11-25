# Releasing

The release workflow is `.github/workflows/release.yml`. It runs when a GitHub
release is published, and can also be started manually with an existing tag.

## Create a release

```bash
git tag -a v0.1.0 -m "KAIROS 0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "KAIROS 0.1.0" --notes-file CHANGELOG.md
```

Publishing the release starts one job that builds the Rust core, downloads and verifies the pinned Stockfish 19
Lite files (`scripts/engine.lock` must hold a real hash: the job runs with `KAIROS_REQUIRE_PIN=1`), runs all tests,
packages `kairos-uci-<tag>.tar.gz` (the UCI engine) and `kairos-web-<tag>.tar.gz` (the optional page), writes
`SHA256SUMS` and attaches everything to the release. No secrets are needed beyond `GITHUB_TOKEN`.

## Manual re-run

```bash
gh workflow run release.yml -f tag=v0.1.0
```

The tag must already have a published GitHub release, because the final job
uploads assets to it.

## Artifact layout

| Asset | Content |
|---|---|
| `kairos-uci-<tag>.tar.gz` | the UCI engine (`kairos` launcher, bundled engine, Stockfish Lite, `kairos_core_bg.wasm`) |
| `kairos-web-<tag>.tar.gz` | the optional browser page |
| `SHA256SUMS` | SHA-256 of both archives |

The Stockfish files in both archives are the unmodified Lite single-thread build; they use the Lite network.

## Local reproduction

```bash
scripts/build_core.sh              # Rust -> WASM (+ wasm-opt when installed)
scripts/fetch_engine.sh            # or: source /path/to/emsdk/emsdk_env.sh && scripts/build_wasm.sh lite
(cd kairos-core && cargo test --release)
(cd web && npm ci && npm test)
scripts/build_uci.sh <tag> && scripts/build_web.sh <tag>
```

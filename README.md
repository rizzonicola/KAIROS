# KAIROS — The Tension Economist

[![CI](https://github.com/rizzonicola/KAIROS/actions/workflows/ci.yml/badge.svg)](https://github.com/rizzonicola/KAIROS/actions/workflows/ci.yml)

KAIROS is a small personality layer around **official, unmodified Stockfish 19**.
For bounded analysis searches it asks Stockfish for several near-equal moves,
then reranks them inside a WDL-based **Soundness Corridor**. Stockfish remains
the only source of candidate moves, legality, and verification.

> **Status:** prototype 0.1. The engine builds and passes real Stockfish 19
> integration tests. The personality features, thresholds, and time model are
> still incomplete. No Elo claim is made.

## What it is

- A standalone UCI proxy (`kairos/uci_proxy.py`) that runs Stockfish as a child
  process and forces `Threads=1`.
- A fixed **Coil** posture: prefer tension, avoid unnecessary simplification,
  keep initiative — but only among moves Stockfish already considers sound.
- `KairosStyle=0` is an exact passthrough: it returns Stockfish's best move.

It is **not** a modified Stockfish, a retrained network, or an anti-cheat tool.
The original `nn-1a298aa575a0.nnue` is kept byte-for-byte.

## Architecture

```text
Chess GUI / UCI client
        |
        v
  run_kairos.sh
        |
        v
  kairos/uci_proxy.py  ---- log ----> kairos.log
        |
        | UCI subprocess; Threads=1; original NNUE
        v
  Stockfish 19 (official sf_19, unmodified)
```

## Quick start

Requirements: Python 3.10+, Git, GNU Make, and G++.

```bash
git clone https://github.com/rizzonicola/KAIROS.git
cd KAIROS
./scripts/build_stockfish19.sh
./run_kairos.sh
```

The build script clones `official-stockfish/Stockfish` at tag `sf_19`, verifies
the exact commit and clean tracked source, downloads the original network,
checks its SHA-256, and refuses to continue on any mismatch. It then builds the
native `ARCH=x86-64` engine and writes `build/stockfish19`.

Use an existing Stockfish 19 binary instead:

```bash
STOCKFISH19_EXECUTABLE=/path/to/stockfish ./run_kairos.sh
```

## UCI options

| Option | Default | Meaning |
|---|---:|---|
| `KairosStyle` | `50` | `0` disables reranking; `1–100` scales the corridor and feature weights. |
| `KairosVerbose` | `false` | Emit a one-line `info string` rationale after a verified non-best pick. |

The posture is fixed to **Coil** in this prototype.

## How a move is chosen

For `go depth N`, and for `go movetime M` with `M >= 1500 ms` and exactly one
limit:

1. Stockfish searches with `MultiPV=5` and WDL enabled.
2. Candidates must have WDL and an exact (not bound) score at the same depth.
3. The expected score is `(W + D/2) / 1000`. A candidate is eligible only inside
   the Coil corridor: `1.5% × KairosStyle/100` expected-score loss.
4. Candidates in a worse result band are rejected. When WDL is saturated at
   `1000 0 0` or `0 0 1000`, a 50 cp safety margin is also applied.
5. The feature subset scores the remaining moves:
   - `F_T` — pawn levers plus absolute pins (a Tension Index proxy).
   - `F_S` — net captured material minus promotion gain (a simplification proxy).
   - `F_I` — check, queen capture, or direct attack on the enemy queen.
6. The best non-Stockfish candidate is re-searched with `searchmoves` at
   `depth + 2` (or 10% extra movetime) against Stockfish's best.
7. Any missing data, mate score, bound score, corridor failure, result-band
   downgrade, stop, timeout, or failed verification falls back to Stockfish's
   original best move.

Clock-controlled, infinite, ponder, node/mate-limited, perft, low-movetime, and
multi-limit searches are passed through without reranking.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

**34 tests:** 28 mock/unit tests and 6 real Stockfish 19 tests. Real tests skip
automatically when `build/stockfish19` is absent. The mock fixture is a protocol
fixture, not a chess engine.

## Release artifacts

Every GitHub release is built by `.github/workflows/release.yml`:

| Artifact | Contents |
|---|---|
| `kairos-<tag>-linux-x86_64.tar.gz` | Native KAIROS + official Stockfish 19 (original NNUE). |
| `stockfish-19-wasm32.tar.gz` | Official Stockfish 19 WebAssembly, multithreaded. |
| `stockfish-19-wasm32-relaxed-simd.tar.gz` | Same, with relaxed SIMD. |
| `stockfish-19-lite-single.tar.gz` | Stockfish 19 Lite WASM, single-threaded, no `SharedArrayBuffer` requirement. |
| `stockfish-19-lite.tar.gz` | Stockfish 19 Lite WASM, multithreaded. |

The `lite` flavors follow the [`stockfish.js`](https://github.com/nmrugg/stockfish.js)
definition: a smaller network (`nn-61e7af4bb97d.nnue`) and a smaller download.
They are optional browser/Node.js artifacts, **not** the pinned native KAIROS
engine. The native build always uses the original `nn-1a298aa575a0.nnue`.

The official WASM builds need cross-origin isolation (`COOP: same-origin`,
`COEP: require-corp`) for threads. The `lite-single` build does not. See
[`docs/WASM.md`](docs/WASM.md) for usage.

## Source pin

- Repository: <https://github.com/official-stockfish/Stockfish>
- Tag: `sf_19`
- Commit: `edb0d9db6731067ec50ce619ff372b463bc4dd5d`
- Network: `nn-1a298aa575a0.nnue`
- NNUE SHA-256: `1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2`

See [`docs/STOCKFISH_SOURCE_LOCK.md`](docs/STOCKFISH_SOURCE_LOCK.md).

## Limitations

- `F_T`, `F_S`, and `F_I` are proxies, not full SEE/x-ray/key-file analysis.
- The 1.5% corridor, 0.45/0.55 result bands, and 50 cp saturation margin are
  engineering conventions and are not calibrated.
- No cumulative budget, repetition awareness, or 50-move handling.
- No adaptive postures, narrowness, reserve, release value, or opponent model.
- No Elo/SPRT result.
- No independent watchdog if the Stockfish process itself hangs.

## License and credits

KAIROS is licensed under **GPL-3.0**; see [`LICENSE`](LICENSE). It uses and
distributes Stockfish 19, which is also GPL-3.0. The optional Lite WebAssembly
builds use [`nmrugg/stockfish.js`](https://github.com/nmrugg/stockfish.js) at
tag `v19.0.1`. See [`THIRD_PARTY.md`](THIRD_PARTY.md) for provenance and
licenses.

Stockfish: <https://github.com/official-stockfish/Stockfish>

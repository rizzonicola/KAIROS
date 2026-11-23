# KAIROS — The Tension Economist

[![CI](https://github.com/rizzonicola/KAIROS/actions/workflows/ci.yml/badge.svg)](https://github.com/rizzonicola/KAIROS/actions/workflows/ci.yml)

KAIROS is a small personality layer around **official, unmodified Stockfish 19**.
For bounded analysis searches it asks Stockfish for several near-equal moves,
then reranks them inside a WDL-based **Soundness Corridor**. Stockfish remains
the only source of candidate moves, legality, and verification.

> **Status:** prototype 0.2. The native proxy and the standalone KAIROS Web Lite
> browser page both pass their test suites. The nine-feature personality, six
> postures, probe layer, opponent model and strength guards are implemented.
> Thresholds and time budgets are still uncalibrated, and no Elo claim is made.

## What it is

- A standalone UCI proxy (`kairos/uci_proxy.py`) that runs Stockfish as a child
  process and forces `Threads=1`.
- Six postures — **Coil, Strike, Absorb, Reverse, Distill, Fog** — inferred from
  expected score, trend, king pressure, tension, forcing density, game phase and
  an opponent Fragility Profile. Coil remains the default and the fallback.
- Nine normalized features, including measured child-search probes for
  narrowness (`F_N`) and prophylaxis (`F_P`).
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

## KAIROS Web Lite

`kairos-lite-web-v0.2.1.tar.gz` is the primary browser target: the KAIROS
personality around Stockfish 19 Lite single-threaded WASM, running entirely in
the page. It needs no Python, no backend, no `SharedArrayBuffer`, and no
COOP/COEP headers.

Download it from the
[v0.2.1 release](https://github.com/rizzonicola/KAIROS/releases/tag/v0.2.1),
extract it, and serve the directory with any static file server:

```bash
tar -xzf kairos-lite-web-v0.2.1.tar.gz
cd kairos-lite-web-v0.2.1
python3 -m http.server 8000
```

Open <http://localhost:8000>. You play White against the engine as Black, with a
2000 ms think time, style 50, posture Auto and variety 0. Think time is
selectable from 1500 to 10000 ms. `KairosStyle=0` returns Stockfish's exact best
move; every other pick is verified against Stockfish and falls back on any
uncertainty. No Elo claim is made. See
[`web/README-WEB.md`](web/README-WEB.md) for controls and engine provenance.

## UCI options

| Option | Default | Meaning |
|---|---:|---|
| `KairosStyle` | `50` | `0` disables reranking; `1–100` scales the corridor, feature weights and time budget. |
| `KairosPosture` | `Auto` | `Auto`, or force one of `Coil`, `Strike`, `Absorb`, `Reverse`, `Distill`, `Fog`. |
| `KairosVariety` | `0` | Softmax temperature for near-equal picks; `0` is deterministic. Forced postures and Strike/Distill always stay deterministic. |
| `KairosVerbose` | `false` | Emit a one-line `info string kairos ...` rationale after a verified non-best pick. |

`KAIROS_SEED` can be set in the environment to make `KairosVariety` sampling
reproducible. Coil is the default posture and the fallback when inference is
uncertain.

## How a move is chosen

For `go depth N`, and for `go movetime M` with `M >= 1500 ms` and exactly one
limit:

1. Stockfish searches with `MultiPV=5` and WDL enabled. For long movetime
   searches (`M >= 3000 ms`), about 65% goes to the main search, 25% to probes
   and 10% to verification; short searches keep the 75%/10% split and skip
   probes.
2. Candidates must have WDL and an exact (not bound) score at the same depth.
3. The expected score is `(W + D/2) / 1000`. A candidate is eligible only inside
   the posture budget: `1.5% × KairosStyle/100` expected-score loss, further
   capped by the rolling 10-move budget (2.5× the single-move budget).
4. Candidates in a worse result band are rejected. When WDL is saturated at
   `1000 0 0` or `0 0 1000`, a 50 cp safety margin is also applied.
5. The nine features score the remaining moves:
   - `F_T` tension, `F_R` reserve, `F_C` coordination, `F_F` flexibility,
     `F_K` king margin, `F_S` simplification, `F_I` initiative — static proxies.
   - `F_N` narrowness and `F_P` prophylaxis — measured with child searches at
     `depth - 3` (depth searches with `N >= 6`) or inside the probe budget.
     Missing or mate-scored probes fall back neutrally or abort the rerank.
6. Posture evidence is inferred from the position and the opponent model;
   softmax produces a mix, with two-move hysteresis, immediate Strike/Absorb
   overrides and a Distill conversion lock. `KairosVariety` can sample among
   near-equal moves, but never in Strike/Distill or a forced posture.
7. The pick is re-searched with `searchmoves` at `depth + 2` (or 10% of the
   original movetime) against Stockfish's best.
8. Any missing data, mate score, bound score, corridor failure, result-band
   downgrade, repetition/50-move guard, exhausted budget, stop, timeout, or
   failed verification falls back to Stockfish's original best move. In Distill
   with a clearly winning evaluation (`>= 0.90` expected), the wrapper plays
   Stockfish's best without reranking.

Clock-controlled, infinite, ponder, node/mate-limited, perft, low-movetime, and
multi-limit searches are passed through without reranking.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

**84 tests:** 78 mock/unit tests and 6 real Stockfish 19 tests. Real tests skip
automatically when `build/stockfish19` is absent. The mock fixture is a protocol
fixture, not a chess engine.

Behavioural scenario checks and the optional SPRT harness are described in
[`docs/VALIDATION.md`](docs/VALIDATION.md). No Elo result is claimed.

## Release artifacts

Every GitHub release is built by `.github/workflows/release.yml`:

| Artifact | Contents |
|---|---|
| `kairos-<tag>-linux-x86_64.tar.gz` | Native KAIROS + official Stockfish 19 (original NNUE). |
| `stockfish-19-wasm32.tar.gz` | Official Stockfish 19 WebAssembly, multithreaded. |
| `stockfish-19-wasm32-relaxed-simd.tar.gz` | Same, with relaxed SIMD. |
| `stockfish-19-lite-single.tar.gz` | Stockfish 19 Lite WASM, single-threaded, no `SharedArrayBuffer` requirement. |
| `stockfish-19-lite.tar.gz` | Stockfish 19 Lite WASM, multithreaded. |
| `kairos-lite-web-<tag>.tar.gz` | The KAIROS Web Lite personality page wrapping `stockfish-19-lite-single`. |

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

- The static features are proxies, not full SEE/x-ray/key-file analysis.
- `F_N` and `F_P` are bounded child-search probes. They are approximate,
  budget-dependent, and neutral or abortive when data is missing.
- The 1.5% corridor, 0.45/0.55 result bands, 50 cp saturation margin, 0.90
  Distill skip, posture thresholds and EWMA constants are engineering
  conventions and are not calibrated.
- The opponent model observes only the positions the GUI sends; it is not a
  full move-history model.
- No Elo/SPRT result. No strength claim is supported.
- No independent watchdog if the Stockfish process itself hangs.

## License and credits

KAIROS is licensed under **GPL-3.0**; see [`LICENSE`](LICENSE). It uses and
distributes Stockfish 19, which is also GPL-3.0. The optional Lite WebAssembly
builds use [`nmrugg/stockfish.js`](https://github.com/nmrugg/stockfish.js) at
tag `v19.0.1`. See [`THIRD_PARTY.md`](THIRD_PARTY.md) for provenance and
licenses.

Stockfish: <https://github.com/official-stockfish/Stockfish>

# KAIROS as a UCI engine

KAIROS runs as a normal UCI engine over stdin/stdout. It needs **Node.js >= 20** (the Rust
core is WebAssembly and Stockfish Lite is a WebAssembly build; no native binary is involved).

```text
kairos-uci-<tag>/
  kairos            launcher (Linux/macOS)       kairos.cmd   launcher (Windows)
  kairos-uci.mjs    the engine (one bundled file)
  engine/stockfish-19-lite-single.js|.wasm   engine/kairos_core_bg.wasm
```

Point the GUI at `kairos` (or `kairos.cmd`). From a checkout: `cd web && npm run uci`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `KairosStyle` | 50 | 0 = exact Stockfish passthrough; scales the per-move loss budget (budget = posture budget x style/100) |
| `KairosIndependence` | 50 | 0 = only Stockfish's top-3 moves are considered; 100 = up to 7 KAIROS-proposed candidates are judged too |
| `KairosPosture` | Auto | Auto, or force one of Coil, Strike, Absorb, Reverse, Distill, Fog |
| `KairosVariety` | 0 | softmax variety among eligible moves (0 = deterministic) |
| `KairosVerbose` | false | forward diagnostic lines as `info string` |
| `KairosInfoStrings` | true | print one `info string kairos ...` line per move (kind, reason, posture, plan, loss) |
| `Hash` | 16 | MB for Stockfish (1-64) |
| `MoveOverhead` | 100 | ms subtracted when converting clocks into a think time |
| `StockfishPath` | `<empty>` | path to `stockfish-19-lite-single.js` (also `KAIROS_STOCKFISH`); default is `engine/` next to the engine |
| `Threads`, `MultiPV`, `UCI_ShowWDL` | fixed | 1, 1 and on; KAIROS needs WDL for its corridor |

## Time handling

`go movetime` / `go depth` are used as given. `go wtime/btime/winc/binc/movestogo` is converted to a
bounded `movetime` (about `time/movestogo + 0.75*inc`, never above half of the remaining time minus
`MoveOverhead`). **Personality searches need >= 1.5 s per move**; below that KAIROS returns plain
Stockfish moves (the info string says `time-too-low`). `go infinite` and other unsupported limits are
exact Stockfish passthrough; `ponder` is not offered.

## cutechess-cli example

```bash
cutechess-cli \
  -engine name=KAIROS cmd=/path/to/kairos proto=uci option.KairosStyle=60 option.KairosIndependence=70 st=2 \
  -engine name=Stockfish cmd=stockfish proto=uci option.Threads=1 st=2 \
  -each timemargin=500 -rounds 20 -repeat -games 2 -pgnout kairos.pgn
```

(`st=` sends `go movetime`.) For a self-contained harness that also reports the disagreement rate,
out-of-top-3 rate, verified-loss distribution and identity fingerprint see `docs/VALIDATION.md`.

## Failure behaviour

* Stockfish files missing or the process dying: KAIROS prints `info string ... standalone` and keeps
  playing with its own search (legal, avoids hanging pieces within its horizon, finds short mates).
* `kairos_core_bg.wasm` missing: the engine prints `info string fatal: ...` and exits with status 1.
* Any internal error during `go` is answered with `bestmove 0000` instead of hanging the GUI.

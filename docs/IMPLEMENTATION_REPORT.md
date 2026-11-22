# KAIROS implementation report — prototype 0.1

## Executive result

The prototype now runs against a real, locally built official Stockfish 19 (`sf_19`) and has real-engine integration tests. The wrapper remains an independent Python UCI process; Stockfish source, search and NNUE are unmodified.

Verified facts:

- Tag `sf_19`, commit `edb0d9db6731067ec50ce619ff372b463bc4dd5d`, zero modified tracked files.
- Engine identifies as `id name Stockfish 19`.
- Default network `nn-1a298aa575a0.nnue`, SHA-256 `1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2`.
- Built binary SHA-256 `75c1e915b0dd6768795f726230fb5d35e828c08e92c4a7d0584521d0bcbde89d` (build-dependent).
- `Threads=1` is forced; Stockfish emits `info string Using 1 thread`.
- `KairosStyle=0` matched direct Stockfish exactly at depth 8 from the start position.
- A real depth-10 rerank was verified: `g1f3` (Stockfish best) → `c2c4`, verification loss `0.0000%`, using `go depth 12 searchmoves g1f3 c2c4`.
- 34 tests pass: 28 mock/unit tests and 6 real Stockfish 19 tests.

No Elo or strength claim is made.

## Environment

- OS: NixOS 26.05 (Yarara), Linux 7.3.4 x86_64.
- Compiler: `g++ (GCC) 15.3.0`.
- Python: 3.13.18 (standard library only).
- Git: 2.54.0; GNU Make: 4.4.1; 16 CPUs.
- No `python-chess`; the feature module deliberately does not generate or validate legal moves.

## Deliverables and status

| Task | Status | Evidence / reason |
|---|---|---|
| Official `sf_19` checkout | COMPLETED AND TESTED | Exact tag and commit verified; tracked source clean. |
| Native Stockfish 19 build | COMPLETED AND TESTED | `JOBS=16 bash scripts/build_stockfish19.sh`; `id name Stockfish 19`. |
| Original NNUE integrity | COMPLETED AND TESTED | Measured SHA-256 matches the value pinned in the build script. |
| Independent UCI wrapper | COMPLETED AND TESTED against Stockfish 19 | Real handshake, `isready`, `position`, `go`, `stop`, `quit`. |
| Force one thread | COMPLETED AND TESTED | Wrapper sends `setoption name Threads value 1`; engine reports `Using 1 thread`. |
| Neutral `KairosStyle=0` | COMPLETED AND TESTED | Exact bestmove equality with a direct Stockfish depth-8 search. |
| MultiPV/WDL retrieval | COMPLETED AND TESTED | Real WDL lines parsed; WDL enabled before any batched `go`. |
| Soundness corridor and fallback | COMPLETED AND TESTED | Real accepted rerank plus mock tests for missing data, mate, bounds, depth mismatch, stop and rejection. |
| Real `searchmoves` verification | COMPLETED AND TESTED | `go depth 12 searchmoves g1f3 c2c4`; accepted `c2c4` at `0.0000%` verified loss. |
| Verification output isolation | COMPLETED AND TESTED | Verification `info` lines are suppressed from UCI stdout; test asserts no depth-12 leak. |
| Movetime allocation | COMPLETED AND TESTED | `go movetime 2000` becomes main `1500` ms; real search returned in 1.50 s. |
| WDL-saturation guard | COMPLETED AND TESTED | Old bug position now returns Stockfish best `e4d5`, not the 153 cp worse `e1d2` at depth 10. |
| Bound-score rejection | COMPLETED AND TESTED | `lowerbound`/`upperbound` scores are not used as exact candidates. |
| `F_T` tension | PARTIALLY IMPLEMENTED | Pawn levers plus exact absolute pins; no near-zero-SEE captures, x-rays or key files. |
| `F_S` simplification | PARTIALLY IMPLEMENTED | Net captured material minus promotion gain; not a full exchange/SEE sequence. |
| `F_I` initiative | PARTIALLY IMPLEMENTED | Check, queen capture, or direct attack on the enemy queen; broader threats missing. |
| Time controls | PARTIALLY IMPLEMENTED | Clock searches remain direct passthrough; no calibrated time-allocation model. |
| Adaptive postures | NOT IMPLEMENTED | Fixed Coil only; no softmax, hysteresis, opponent model or plan token. |
| Cumulative budget / repetition / 50-move | NOT IMPLEMENTED | Per-move corridor only. |
| Elo / SPRT validation | NOT IMPLEMENTED | Requires controlled self-play under identical resources. |

## Real-engine defects found and fixed

1. **WDL saturation hid centipawn losses.** In `4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1`, WDL was `1000 0 0` for several moves while Stockfish's depth-10 best was 153 cp better than `e1d2`. The wrapper could pick the worse move. The corridor now applies an explicit 50 cp margin when baseline expected score is `>= 0.99` or `<= 0.01`, in both the main selection and verification. The position now returns Stockfish best `e4d5`.
2. **Bound scores were parsed as exact.** `score cp N lowerbound|upperbound` now invalidates the candidate record. Bound scores never participate in reranking.
3. **Batched GUI commands could outrun `uciok`.** A GUI sending `uci`, `position`, `go` together could reach `go` before the wrapper enabled `UCI_ShowWDL`, producing missing WDL and fallback. Input commands are now buffered until `uciok`, then replayed after the wrapper's options are sent.
4. **Verification info leaked to the GUI.** Internal verification `info` lines (MultiPV=2, deeper search) are now suppressed; only the final `bestmove` and the optional KAIROS rationale are emitted.
5. **Multiple limits were treated as depth-only.** `go depth N movetime M` is now a direct passthrough instead of silently dropping one limit.
6. **Feature gaps.** `F_T` now counts absolute pins in addition to mutually attacking pawn pairs; `F_S` subtracts promotion gain; `F_I` adds queen captures and direct attacks on the enemy queen.

## Current search behavior

Personality reranking applies to `go depth N` and `go movetime M >= 1500`, with exactly one limit:

1. Request MultiPV=5 from Stockfish; require WDL for every compared candidate.
2. Build the fixed Coil corridor of `1.5% * KairosStyle/100` expected score.
3. Reject candidates outside the corridor, in a lower result band, bound-scored, or (when WDL is saturated) more than 50 cp worse.
4. Score with `F_T=+2`, `F_S=-1`, `F_I=+1` at `0.1%` expected score per weight unit, scaled by style.
5. Require a strict advantage over Stockfish's best; ties stay with Stockfish.
6. Verify every non-best pick with `searchmoves` at depth+2 (depth search) or 10% of the original movetime, with MultiPV=2.
7. Fall back to Stockfish's best on stop, mate, missing data, depth mismatch, corridor/result-band failure, saturation-margin failure, or missing verification records.

Clock-controlled, ponder, infinite, node/mate-limited, perft, low-movetime and multi-limit searches are passthroughs.

## Test results

### Mock/unit suite — 28 passed

- `tests/test_chess_features.py` (8): FEN/history, castling, promotion, pawn levers, absolute pins, promotion-aware simplification, check and queen-threat initiative.
- `tests/test_protocol.py` (20): handshake/Threads/WDL option, identity refusal, neutral passthrough, rerank/verify, depth mismatch, mate, missing WDL, verification rejection, movetime allocation, clock passthrough, stop/quit, batched handshake ordering, bound rejection, main and verification saturation, verification-info suppression, multi-limit bypass, `parse_info` and limit parsing.

### Real Stockfish 19 suite — 6 passed

`tests/test_real_stockfish.py` skips automatically when `build/stockfish19` is absent.

- Identity, NNUE SHA-256 and forced single thread.
- `KairosStyle=0` bestmove equality with a direct Stockfish depth-8 search.
- Real rerank and `searchmoves` verification on `rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2` at depth 10: `g1f3` → `c2c4`, verified loss `0.0000%`, no depth-12 info leak.
- Real WDL-saturation fallback on the pawn-endgame position: `e4d5` returned, no verification attempted.
- Movetime reservation: `go movetime 2000` → main `go movetime 1500`, returned in 1.50 s.
- Real `go infinite` → `stop` → `bestmove`, then `quit` exit code 0.

Full suite: `Ran 34 tests in 6.259s — OK`.

## Validation commands

```bash
bash -n scripts/build_stockfish19.sh run_kairos.sh
python3 -m py_compile kairos/*.py tests/*.py
JOBS=16 bash scripts/build_stockfish19.sh
python3 -m unittest discover -s tests -v
```

The build script refuses a wrong tag/commit, modified tracked source, missing or wrong-hash NNUE, a non-Stockfish-19 identity, or a mismatched default `EvalFile`.

## Distribution and release automation

The repository is prepared for GitHub under `rizzonicola/KAIROS`. `.github/workflows/ci.yml` builds the pinned native engine and runs all tests. `.github/workflows/release.yml` runs on a published release (or manual dispatch) and attaches:

- `kairos-<tag>-linux-x86_64.tar.gz` — native KAIROS, launcher, engine, tests, and docs.
- `stockfish-19-wasm32.tar.gz` and `stockfish-19-wasm32-relaxed-simd.tar.gz` — official Stockfish 19 WebAssembly with the original network.
- `stockfish-19-lite.tar.gz` and `stockfish-19-lite-single.tar.gz` — optional Stockfish 19 Lite WebAssembly from `nmrugg/stockfish.js` v19.0.1 with its smaller network.
- `SHA256SUMS`.

The lite artifacts are separate browser/Node.js builds; they are not the validated native KAIROS engine. See `docs/WASM.md` and `docs/RELEASING.md`.

## Known limitations and untested areas

1. `F_T` is not the full Tension Index: near-zero-SEE captures, x-rays and contested key files are missing. Absolute pins are exact only for the current position, not future lines.
2. `F_S` is a material-delta proxy, not an exchange sequence or full SEE.
3. `F_I` covers checks, queen captures and direct queen attacks only.
4. The 1.5% corridor, 0.45/0.55 result bands and 50 cp saturation margin are engineering conventions and have not been calibrated against a scenario suite.
5. Verification at depth+2 or 10% movetime is a safety check, not proof of soundness.
6. Clock-controlled searches bypass personality; no time-allocation model exists.
7. No cumulative 10-move budget, repetition awareness or 50-move-rule handling.
8. Only the fixed Coil posture exists; no posture inference, softmax, hysteresis, conversion lock, opponent model or plan token.
9. No Narrowness, Reserve, Release Value, prophylaxis or full coordination features.
10. No Elo/SPRT benchmark; no strength claim is supported.
11. The binary hash is build-dependent. Real tests are calibrated to this pinned build and skip when it is absent.
12. Movetime verification was not observed in the tested 2 s position because Stockfish's 1.5 s best move was already the Coil candidate; the depth-search test covers the real verification path.
13. There is no independent watchdog if the Stockfish subprocess itself hangs; verification relies on Stockfish's bounded depth/movetime and the `stop` path.

## Next five prioritized tasks

1. **Calibrate the corridor and guards** on a curated scenario suite with real Stockfish 19: measure rerank rate, accepted/rejected verification rate, movetime behavior, and tune the 1.5% budget, 0.45/0.55 bands and 50 cp saturation margin. Do not widen the corridor merely to increase reranks.
2. **Complete reliable Tension Index components**: near-zero-SEE captures, x-rays and key-file tension, each with direct tests. Only then extend `F_S` to exchange sequences and `F_I` to broader forcing moves.
3. **Add cumulative budget, repetition and 50-move awareness** with explicit tests, so repeated style choices cannot silently spend more than the intended rolling budget.
4. **Measure and then add Narrowness/Reserve probes** using child MultiPV searches; record latency and rerank impact before enabling them.
5. **Run controlled self-play/SPRT** against Stockfish 19 with identical threads, hash and time controls. Only after that consider posture inference and any strength claim.

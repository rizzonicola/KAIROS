# OPENClODE LOCAL HANDOFF

## 1. What is already completed

- Read and decomposed the supplied KAIROS v1.0 specification.
- Inspected the environment: NixOS 26.05 x86-64, G++ 15.3.0, Python 3.13.18, GNU Make 4.4.1, Git 2.54.0, 16 CPUs.
- Cloned the official Stockfish repository at exact tag `sf_19`, commit `edb0d9db6731067ec50ce619ff372b463bc4dd5d`.
- Built the native x86-64 engine with the pinned upstream `build` target; confirmed `id name Stockfish 19`.
- Verified the original `nn-1a298aa575a0.nnue`; measured SHA-256 `1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2`.
- Recorded binary SHA-256 `75c1e915b0dd6768795f726230fb5d35e828c08e92c4a7d0584521d0bcbde89d` (build-dependent).
- Confirmed tracked Stockfish source is clean and forced `Threads=1` (engine reports `Using 1 thread`).
- Implemented a standalone UCI proxy in `kairos/uci_proxy.py` with fixed-Coil MultiPV reranking, WDL corridor, result-band/mate guards, deeper `searchmoves` verification and safe fallback.
- Implemented a dependency-free FEN/UCI-move feature module in `kairos/chess_features.py`.
- Fixed real-engine defects: WDL saturation, bound-score parsing, batched handshake ordering, verification-info leakage and multi-limit passthrough.
- Improved features: pawn levers plus absolute pins (`F_T`), net captured material minus promotion gain (`F_S`), check/queen capture/queen threat (`F_I`).
- Added real-engine integration tests in `tests/test_real_stockfish.py` (skip when the pinned build is absent).
- Hardened `scripts/build_stockfish19.sh` with tag, commit, clean-source, NNUE-hash, identity and `EvalFile` checks.
- No Stockfish source, search routine or NNUE was modified or replaced.

## 2. What still needs implementation or verification

- Calibrate the 1.5% corridor, 0.45/0.55 result bands and 50 cp WDL-saturation margin with a scenario suite.
- Complete the Tension Index: near-zero-SEE captures, x-rays and key-file tension.
- Extend `F_S` beyond material delta and `F_I` beyond checks/queen threats.
- Add cumulative rolling budget, repetition awareness and 50-move-rule handling.
- Add measured Narrowness and Reserve probes only after latency/correctness tests.
- Implement all six blended postures, softmax inference, hysteresis, conversion lock, opponent Fragility Profile, plan token, variety control and a time-allocation model.
- Run controlled self-play/SPRT against Stockfish 19 under identical resources. Do not claim Elo before that.

## 3. Exact files needing attention

- `kairos/uci_proxy.py` — corridor/guard calibration, cumulative budget, repetition handling, time allocation.
- `kairos/chess_features.py` — remaining T/S/I components; keep it non-generating and dependency-free.
- `tests/mock_stockfish.py` — deterministic protocol fixture only; never a chess engine.
- `tests/test_protocol.py` and `tests/test_chess_features.py` — retain and extend.
- `tests/test_real_stockfish.py` — real-engine tests; keep the skip guard for missing builds.
- `scripts/build_stockfish19.sh` — integrity checks and build metadata.
- `README.md`, `docs/IMPLEMENTATION_REPORT.md`, `docs/STOCKFISH_SOURCE_LOCK.md` — update after behavior changes.

## 4. Commands and results in this workspace

```bash
$ git -C third_party/Stockfish describe --tags --exact-match
sf_19
$ git -C third_party/Stockfish rev-parse HEAD
edb0d9db6731067ec50ce619ff372b463bc4dd5d
$ git -C third_party/Stockfish status --porcelain --untracked-files=no
(no output)
$ JOBS=16 bash scripts/build_stockfish19.sh
Built and identified Stockfish 19 successfully.
Engine SHA256: 75c1e915b0dd6768795f726230fb5d35e828c08e92c4a7d0584521d0bcbde89d
NNUE SHA256: 1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2
$ bash -n scripts/build_stockfish19.sh run_kairos.sh
(exit 0)
$ python3 -m py_compile kairos/*.py tests/*.py
(exit 0)
$ python3 -m unittest discover -s tests -v
Ran 34 tests in 6.259s
OK
```

Real rerank evidence:

```text
position fen rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2
go depth 10
verify candidate=c2c4 versus sf_best=g1f3 budget=0.750%
-> go depth 12 searchmoves g1f3 c2c4
accepted pick=c2c4 verified_loss=0.0000%
bestmove c2c4
```

`KairosStyle=0` at depth 8 from the start position matched a direct Stockfish search exactly.

## 5. Technical decisions not to repeat or undo

- Use only the exact official tag `sf_19`; it resolves to `edb0d9db6731067ec50ce619ff372b463bc4dd5d`.
- Do not substitute a development build, another tag, or an unofficial network for the native KAIROS engine. Browser/WASM artifacts are separate release outputs and are not the validated native engine.
- Keep `nn-1a298aa575a0.nnue` unchanged; the build script pins its SHA-256.
- Keep Stockfish source/search/NNUE unmodified. KAIROS remains an external UCI process.
- Force `Threads=1`; default Hash is 32 MB but user changes are allowed.
- Use WDL expected score for the corridor. Centipawns are used only for the saturation safety margin when WDL is pinned at 1000/0, never as the corridor loss itself. Require Stockfish WDL; if absent, fall back.
- Never generate candidate moves. Only rank root moves returned by Stockfish MultiPV and verify a non-best choice using `searchmoves`.
- Keep result-band, mate and saturation guards. Failed or missing verification must fall back to the original Stockfish best.
- `KairosStyle=0` must remain exact bestmove passthrough.
- Clock-controlled, infinite, ponder, node/mate-limited, perft, low-movetime and multi-limit searches remain passthroughs until time allocation is calibrated.
- Do not widen the corridor merely to produce more alternative moves.
- Do not interpret mock-engine tests as evidence of real chess legality or engine strength.

## 6. Next five engineering tasks (priority order)

1. **Calibrate the corridor and guards** with a curated scenario suite on real Stockfish 19; measure rerank/acceptance rates and tune the 1.5% budget, result bands and 50 cp saturation margin.
2. **Complete reliable Tension Index components** (near-zero-SEE captures, x-rays, key files) with direct tests; then extend `F_S` and `F_I`.
3. **Add cumulative budget, repetition and 50-move awareness** with explicit tests.
4. **Measure and add Narrowness/Reserve probes** via child MultiPV searches; record latency and rerank impact before enabling.
5. **Run controlled self-play/SPRT** against Stockfish 19 with identical threads/hash/time; only then consider posture inference and any strength claim.

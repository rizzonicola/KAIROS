# KAIROS Web Lite — design

Date: 2026-11-23
Status: proposed
Target release: v0.2.0

## Intent

KAIROS Web Lite is a standalone browser page that plays chess with the KAIROS
personality around **Stockfish 19 Lite, single-threaded WebAssembly**. It is the
primary target of the project. The native Python proxy remains the reference
implementation and the validation oracle.

The page must run on a normal phone browser without a backend, without Python,
without `SharedArrayBuffer`, and without cross-origin isolation.

## Goals

- Play a complete game in the browser against KAIROS Web Lite.
- Preserve the native personality contract: Soundness Corridor, result-band
  guard, WDL-saturation margin, `searchmoves` verification, rolling budget,
  repetition and 50-move guards, mate guard, Distill skip.
- `KairosStyle=0` returns Stockfish's exact best move.
- Every non-best pick is verified. Any uncertainty falls back to Stockfish's
  best move.
- Explain each move: posture, confidence, mix, plan token, nine features,
  budget, loss, pick.
- Work on desktop and mobile with no special headers.
- Ship as a tested release asset with documentation.

## Non-goals

- No Python, Pyodide, Rust, Go, or additional WASM module in v1.
- No Stockfish source, search, or NNUE changes.
- No multithreaded engine, no `SharedArrayBuffer`.
- No online play, accounts, backend, or database.
- No opening book, custom FEN editor, or PGN export in v1.
- No Elo claim or strength promise.
- No corridor widening to manufacture personality moves.

## Anti-goals

- A page that only works in desktop Chrome.
- A wrapper that silently bypasses verification or hides engine errors.
- A second personality implementation with no parity tests.
- A bundle that needs a build server or special response headers to run.

## Decision log

| Decision | Source |
|---|---|
| Standalone KAIROS page, not a drop-in UCI engine | user |
| One language: TypeScript/JavaScript | user accepted designer recommendation |
| Browser target: Stockfish 19 Lite single-threaded | user |
| Personality must run in the browser, not only native | user |
| Native Python proxy stays as reference oracle | designer |
| Vanilla TypeScript + Vite, no UI framework | designer |
| `chess.js` for legal moves; KAIROS board for features | designer |
| Two workers plus a main-thread string relay | designer |
| Separate app/engine files; no single-file bundle in v1 | designer |
| Default think time 2000 ms, style 50, posture Auto, variety 0 | designer |
| Release asset `kairos-lite-web-<tag>.tar.gz`, version v0.2.0 | designer |
| Every engine move carries a structured rationale, including fallbacks and passthrough | designer |
| UI think time 1500–10000 ms; below 1500 ms is not offered | designer |
| CI downloads the pinned `stockfish-19-lite-single` prebuilt from v0.1.0 | designer |
| `go`/`bestmove` carry a `requestId`; the UI drops stale results | designer |
| Watchdog lives in the main-thread relay that owns the engine worker | designer |

## Architecture

```
┌──────────────────────────────┐
│ Main thread (UI)             │
│  index.html, app.ts          │
│  chess.js game state         │
│  board rendering, controls   │
└──────────┬───────────────────┘
           │ typed postMessage
┌──────────▼───────────────────┐
│ kairos-worker.ts             │
│  UCI controller state machine│
│  features, postures, guards  │
│  probes and verification     │
└──────────┬───────────────────┘
           │ raw UCI lines, relayed by the main thread
┌──────────▼───────────────────┐
│ stockfish-19-lite-single.js  │
│  Web Worker + .wasm          │
└──────────────────────────────┘
```

The main thread relays small UCI strings between the two workers. No chess
computation happens on the UI thread. Nested workers are avoided so older
mobile browsers keep working.

### Message protocol

UI to controller:

```ts
type UiCommand =
  | { type: "init"; options?: Partial<KairosOptions>; seed?: number }
  | { type: "newgame" }
  | { type: "setoption"; name: string; value: string }
  | { type: "position"; command: string }
  | { type: "go"; command: string; requestId?: number }
  | { type: "stop" }
  | { type: "quit" };
```

Controller to UI:

```ts
type ControllerEvent =
  | { type: "ready"; engine: string }
  | { type: "engine-info"; depth: number; multipv: number; score?: string; wdl?: [number, number, number]; requestId?: number }
  | { type: "bestmove"; move: string; ponder?: string; rationale: Rationale; requestId?: number }
  | { type: "log"; line: string }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "quit" };
```

`requestId` is echoed from `go` to every `bestmove` and `engine-info`. The UI
drops results whose id is no longer current, so a new game never applies a move
from the cancelled search.

`Rationale` always exists:

```ts
interface Rationale {
  kind: "rerank" | "fallback" | "stockfish";
  reason: string;              // "verified", "corridor", "style-zero", ...
  posture: Posture;
  confidence: number;
  mix: Partial<Record<Posture, number>>;
  plan: string;
  budgetPct: number;
  lossPct: number;
  pick: number;                // 1-based MultiPV index, 0 when not reranked
  sfBest: string;
  features?: Features;         // present for reranked and eligible fallbacks
}
```

Only an accepted rerank has `kind: "rerank"`. Fallbacks report the guard that
fired; passthrough reports `style-zero` or the unsupported-search reason. This
is a web-only improvement over the Python proxy, which emits its verbose
rationale only for accepted picks.

Controller and engine exchange `{ type: "engine-send", line }` and
`{ type: "engine-line", line }`; the main thread forwards them unchanged.

### Controller states

`idle`, `main`, `probe`, `verify`, `stopping`, `dead`.

- **init**: send `uci`; collect engine options; require `id name` to contain
  `Stockfish 19` unless `?dev=1`; force `Threads=1`, `Hash=32`, `MultiPV=1`,
  `UCI_ShowWDL=true`; send `isready`; emit `ready`.
- **position**: store the command and update repetition counts. During a search,
  queue it and stop the current search.
- **go**: passthrough when style is 0, the search is unsupported, or the engine
  is not ready. Otherwise run the personality pipeline.
- **stop**: send `stop`; on `bestmove`, return the engine's best and process the
  next queued command.
- **quit**: stop, terminate the engine, and disable the page.

Unsupported searches pass through exactly as in the native proxy: clock controls,
`infinite`, `ponder`, `perft`, `nodes`, `mate`, multiple limits, and movetime
below 1500 ms.

### Personality pipeline

The port mirrors `kairos/uci_proxy.py`, `kairos/chess_features.py`, and
`kairos/postures.py`. Those files are normative for constants, formulas, and
guard order. Summary:

1. Main search with `MultiPV=5` and WDL.
2. Baseline is Stockfish's best; require the same completed depth, WDL, exact
   score, and no mate.
3. Corridor: `1.5% * style / 100`; rolling 10-move cap at `2.5x`.
4. Reject candidates outside the corridor, in a lower result band, or beyond
   the 50 cp saturation margin. Apply repetition and 50-move guards.
5. Compute the nine features. Probe `F_N` and `F_P` for the top four candidates
   plus one null move when depth ≥ 6 or movetime ≥ 3000 ms.
6. Infer posture evidence, update the Fragility Profile, apply hysteresis,
   immediate overrides, and the Distill lock.
7. Score `-loss + 0.1 * style * Σ(w * F)`; in deterministic mode require a
   strict advantage over Stockfish's best.
8. Verify with `searchmoves` at depth + 2 or 10% of the original movetime.
9. Fall back on stop, timeout, mate, missing WDL, bound score, corridor or band
   failure, saturation failure, probe mate, exhausted budget, or missing
   verification records.
10. In Distill with expected score ≥ 0.90, return Stockfish's best without
    reranking.

Every bestmove emits a `Rationale`. Accepted reranks use `kind: "rerank"`;
every fallback reports the guard that fired; style-zero and unsupported-search
passthroughs report `kind: "stockfish"` with the reason.

### Timing

- UI sends `go movetime <thinkTime>`; default 2000 ms, range 1500–10000 ms.
  The controller still treats movetime below 1500 ms as a Stockfish passthrough
  for protocol completeness, but the UI never offers it.
- Main search: 75% below 3000 ms, 65% at or above.
- Verification: 10%.
- Probes: 25% at or above 3000 ms, split across labels; disabled below.
- Depth searches: probes at depth - 3 when depth ≥ 6; verification at depth + 2.
- Stop or a new game cancels the search and falls back to the current best.

## Features and postures

Port the Python modules one-to-one, keeping names and constants:

- `chess_features.ts`: `Board`, FEN parse/serialize, `apply_uci`,
  `position_key`, `resets_halfmove`, `pawn_lever_count`, `pin_count`,
  `tension_count`, `captured_value`, `material_delta`, `move_gives_check`,
  `move_threatens_enemy_queen`, `king_zone`, `pseudo_moves`, `safe_mobility`,
  `pawn_breaks`, `reserve_count`, `coordination`, `king_margin`,
  `material_balance`, `phase`, `null_move_fen`, `forcing_density`,
  `board_from_position_command`, `position_stats`, `candidate_features`.
- `postures.ts`: `POSTURES`, `FEATURES`, `WEIGHTS`, `Evidence`,
  `PostureController`, `plan_token`, `one_hot`, `normalize`, `dominant`,
  `weighted_features`, `softmax`, `sample_index`, `score_trend`,
  `evidence_from_stats`, `position_class`, `update_fragility`,
  `variety_temperature`, `infer_mix`.
- `controller.ts`: `Candidate`, `Search`, `parse_info`, `result_band`,
  `is_saturated`, `supported_personality_search`, `repetition_blocked`,
  `fifty_move_blocked`, the main/probe/verify state machine, and the rationale.

The RNG for `KairosVariety` must be seedable and deterministic for a given seed.
The exact algorithm is a builder call; it does not need to match Python's
`random.Random`, because sampled picks still pass verification. Document it.

## UI

- Responsive single page: board on the left/top, panel on the right/bottom.
- Board: CSS grid, Unicode pieces, click/tap to move, legal destination dots,
  last-move highlight, check highlight, promotion picker.
- Panel:
  - status: ready/thinking, depth, evaluation;
  - posture badge, confidence, mix bars;
  - plan token, rationale, budget and loss;
  - nine feature bars;
  - controls: new game, flip, side, style, posture, variety, think time;
  - move list.
- Default: player White, engine Black, think time 2000 ms, style 50, posture
  Auto, variety 0.
- Mobile: board fits the viewport width; controls stack; touch targets at least
  44 px.
- Accessibility: labelled buttons, visible focus, `aria-live` status; board
  squares expose file/rank labels. A full screen-reader chess experience is out
  of scope for v1.

## Error handling

- Engine load failure: blocking error with a retry button.
- Engine identity mismatch: refuse unless `?dev=1`.
- Missing WDL, bound score, or mate score: fall back to Stockfish's best.
- Watchdog: the main-thread relay owns the engine worker, so it also owns the
  timer. No `bestmove` within movetime + 10 s (or 30 s for depth searches)
  triggers `stop`; if the worker is still stuck after 2 s, terminate and
  recreate the whole worker stack once.
- Worker crash or engine load failure: recreate once automatically; on a second
  failure, disable the engine and show a retry button. A manual retry resets the
  failure counter.

## Parity and tests

- **Vector exporter** `scripts/export_web_vectors.py` imports the Python
  reference and writes JSON fixtures under `web/tests/vectors/`:
  - board/FEN/apply/position key/halfmove reset;
  - feature values for curated positions and moves;
  - position stats;
  - posture inference, hysteresis, EWMA, variety temperature;
  - `parse_info` samples;
  - corridor and guard cases.
- **Vitest** loads the vectors and compares with a small tolerance. It also
  drives the controller with a scripted mock engine ported from
  `tests/mock_stockfish.py`: rerank, verification rejection, mate, missing WDL,
  saturation, budget, repetition, 50-move, Distill skip, variety.
- **Same-engine end-to-end**: run the Python proxy against the Lite WASM engine
  under Node and the TypeScript controller against the same engine; compare the
  final move and rationale on deterministic positions at fixed depth. Skip when
  the engine is absent.
- **Browser smoke**: one Playwright Chromium test loads the built page, waits for
  ready, plays one move, and asserts a bestmove and a rationale.
- **CI**: a `web` job runs the vector freshness check, `npm test`, builds the
  page, and runs the Playwright smoke test. It downloads the pinned
  `stockfish-19-lite-single.tar.gz` from the v0.1.0 release and verifies its
  SHA-256 instead of building Emscripten on every run. The release workflow
  builds the same engine from source in the `wasm` job.

## Packaging and release

- `web/` contains `package.json`, `tsconfig.json`, `vite.config.ts`,
  `index.html`, `src/`, and test vectors.
- `scripts/build_web.sh` requires an engine directory
  (`KAIROS_LITE_ENGINE_DIR`, default `dist/stockfish-19-lite-single`), copies
  the engine into `web/public/engine` before `npm ci` and `npm run build`,
  copies the committed `web/README-WEB.md`, and packages
  `dist/kairos-lite-web-<tag>.tar.gz`.
- The release workflow gets a new `web` job that needs `wasm`, downloads the
  Lite artifact, builds the page, and uploads the archive. The publish job
  includes it in `SHA256SUMS`.
- The archive contains `index.html`, `assets/`, `engine/stockfish-19-lite-single.js`,
  `engine/stockfish-19-lite-single.wasm`, `LICENSE`, `THIRD_PARTY.md`, and
  `README-WEB.md`.
- Serve it with any static file server. No COOP/COEP headers are required.
- Release version: v0.2.0.

## Performance targets

- Engine ready in under 5 s on a mid-range phone over a cold 4G load.
- A 2000 ms move returns within 2.5 s after the engine is ready.
- Feature computation under 50 ms per move for all candidates.
- No long task over 100 ms on the UI thread while the engine thinks.
- Measure with `performance.now()`; record the results in the web README.

These are targets to measure, not guarantees. The single-threaded Lite engine is
slower than the native build; the default think time and disabled probes are the
main mitigation.

## Risks

- **Parity drift**: generated vectors plus same-engine end-to-end tests.
- **Slow low-end devices**: default 2000 ms and no probes; document the tradeoff.
- **WASM loading/MIME**: test with a static server and in CI.
- **Two board implementations**: `chess.js` owns legality; the KAIROS board owns
  features. The parity vectors and the same-engine end-to-end tests compare the
  two on the same move history; no runtime FEN cross-check is needed.
- **Worker differences**: test Chrome, Firefox, and Safari; no `SharedArrayBuffer`.
- **UI scope creep**: v1 is a demo, not a full chess site.

## What is left to the builder

- Visual design, CSS, and layout details.
- Additional test fixtures beyond the generated vectors.
- The seeded PRNG algorithm.
- Exact wording of errors and rationale strings.
- The static server used for local development.
- Browser support matrix details.
- Future work: single-file bundle, PGN/FEN export, multithreaded Lite, optional
  persistence of settings.

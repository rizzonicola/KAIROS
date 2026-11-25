# KAIROS Web Lite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone browser page that plays the KAIROS personality around Stockfish 19 Lite single-threaded WASM, with the native Python proxy as the parity oracle.

**Architecture:** Vanilla TypeScript + Vite. The main thread owns `chess.js`, rendering, and relays raw UCI strings between two workers: `kairos-worker` (controller, features, postures, guards) and `stockfish-19-lite-single.js` (engine). No nested workers, no `SharedArrayBuffer`, no backend.

**Tech Stack:** TypeScript 5.9, Vite 8, Vitest 5, Playwright 1.65, chess.js 1.4, Node 22+.

**Spec:** `docs/superpowers/specs/2026-11-23-kairos-web-design.md`

## Global Constraints

- Browser runtime is TypeScript/JavaScript only. No Python, Pyodide, Rust, Go, or extra WASM module. Stockfish stays the only WASM compute.
- Engine: `stockfish-19-lite-single.js` + `.wasm`; no `SharedArrayBuffer`, COOP/COEP, or backend.
- `KairosStyle=0` must return Stockfish's exact bestmove.
- Every non-best pick must pass `searchmoves` verification; any uncertainty returns Stockfish's bestmove.
- No corridor widening; no Elo or strength claim.
- Constants copied verbatim from the Python reference: `SATURATION_EXPECTED=0.99`, `SATURATION_CP_MARGIN=50`, `HALFMOVE_ALERT=90`, `DISTILL_SKIP_EXPECTED=0.90`, `BUDGET_WINDOW=10`, `BUDGET_MULTIPLIER=2.5`, `INERTIA_MARGIN=0.15`, `INERTIA_STREAK=2`, `SOFTMAX_TEMPERATURE=0.20`, `DISTILL_ENTER=0.80`, `DISTILL_EXIT=0.65`, `FRAGILITY_ALPHA=0.3`, `MAX_VARIETY_TAU=0.10`.
- Budget and timing: single-move budget `1.5 * style / 100`; main share `0.75` below 3000 ms, `0.65` at or above; verification `10%`; probes `25%`; minimums `100/50/25` ms; probes at `depth-3` (min 1) and verification at `depth+2`; MultiPV `5` main, `3` candidate probe, `1` null probe, `2` verification; movetime below `1500` is passthrough.
- Defaults: player White, engine Black, think time 2000 ms, style 50, posture Auto, variety 0.
- UI think-time options: 1500, 2000, 3000, 5000, 10000 ms; default 2000.
- All user-facing text in English.
- Release asset `kairos-lite-web-v0.2.0.tar.gz`; version 0.2.0.
- Commit after every task; run the task's tests before committing.

## Review Focus

1. A stale `bestmove` from a cancelled search must never be applied after a new game. The controller echoes `requestId`; the UI drops mismatches.
2. An illegal, absent, or `(none)` engine move must be refused without corrupting the game. `applyEngineMove` returns null and the UI reports it.
3. Engine load failure (missing `.wasm`, wrong MIME, worker crash) must show a blocking error with retry, not a silent hang. Init timeout plus one automatic restart.
4. Missing WDL, bound score, mate, depth mismatch, saturation, or verification failure must return Stockfish's exact bestmove.
5. A malformed or unsupported position command must not crash the controller; it must still return a legal engine move.
6. A think time below 1500 ms is a Stockfish passthrough; the UI does not offer it, but the controller labels it `stockfish` with reason `time-too-low` if it arrives.

## File Map

- `scripts/export_web_vectors.py` — generates JSON parity fixtures from the Python reference; `--check` detects stale fixtures.
- `scripts/build_web.sh` — copies the Lite engine, builds, packages the release archive.
- `web/package.json`, `web/package-lock.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/playwright.config.ts`, `web/index.html`.
- `web/src/chess-features.ts` — `Board`, FEN, move application, nine features, position stats.
- `web/src/postures.ts` — weights, softmax, hysteresis, Fragility Profile, variety.
- `web/src/controller.ts` — UCI state machine, guards, main/probe/verify pipeline, rationale.
- `web/src/protocol.ts` — shared worker message types.
- `web/src/kairos-worker.ts` — worker entry around `KairosController`.
- `web/src/engine-host.ts` — engine worker wiring and one-restart policy.
- `web/src/game.ts` — chess.js helpers: position command, legal engine move application.
- `web/src/main.ts`, `web/src/style.css` — UI and game loop.
- `web/tests/` — Vitest unit, parity, controller, performance, E2E tests and fixtures.
- `web/browser-tests/smoke.spec.ts` — Playwright smoke.
- `web/README-WEB.md` — release archive readme.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml` — web job and release asset.
- `README.md`, `docs/WASM.md`, `CHANGELOG.md` — docs and release notes.

---

### Task 1: Web scaffold

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.ts`, `web/src/style.css`, `web/tests/scaffold.test.ts`, `web/public/engine/.gitkeep`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable Vite app; `npm test` and `npm run build` work from `web/`.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "kairos-lite-web",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:browser": "playwright test",
    "vectors:check": "python3 ../scripts/export_web_vectors.py --check"
  },
  "dependencies": {
    "chess.js": "^1.4.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.65.1",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vite": "^8.3.8",
    "vitest": "^5.1.1"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json` and `web/vite.config.ts`**

`tsconfig.json`: `target ES2022`, `module ESNext`, `moduleResolution Bundler`, `lib ["ES2022","DOM","DOM.Iterable"]`, `strict true`, `noEmit true`, `skipLibCheck true`, `types ["vite/client","node"]`, include `src`, `tests`, `browser-tests`, `vite.config.ts`, `playwright.config.ts`.

`vite.config.ts` imports `defineConfig` from `vitest/config`; sets `base: "./"`, `build.target: "es2022"`, `worker.format: "es"`, and `test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 120000, hookTimeout: 120000 }`.

- [ ] **Step 3: Create the page shell and placeholder**

`web/index.html` has `<div id="app"></div>` and `<script type="module" src="/src/main.ts"></script>`. `main.ts` renders a placeholder heading; `style.css` sets a dark, responsive base.

- [ ] **Step 4: Write the failing scaffold test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("index.html exposes the app root and module entry", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('id="app"');
    expect(html).toContain('type="module"');
  });
});
```

- [ ] **Step 5: Install and verify**

Run: `cd web && npm install && npm test && npm run build`
Expected: one test passes; `dist/index.html` and `dist/assets/` exist.

- [ ] **Step 6: Ignore build products**

Append to `.gitignore`: `/web/node_modules/`, `/web/dist/`, `/web/test-results/`, `/web/playwright-report/`, `/web/public/engine/*.js`, `/web/public/engine/*.wasm`.

- [ ] **Step 7: Commit**

```bash
git add .gitignore web
git commit -m "feat(web): scaffold TypeScript Vite app"
```

---

### Task 2: Chess features port

**Files:**
- Create: `web/src/chess-features.ts`, `web/tests/chess-features.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `STARTPOS_FEN`; `Board` with `fromFen`, `toFen`, `applyUci`, `resetsHalfmove`, `pawnLeverCount`, `pinCount`, `tensionCount`, `capturedValue`, `materialDelta`, `moveGivesCheck`, `moveThreatensEnemyQueen`, `kingSquare`, `kingZone`, `isAttackedByPawn`, `pseudoMoves`, `safeMobility`, `pawnBreaks`, `reserveCount`, `coordination`, `kingMargin`, `materialBalance`, `phase`, `positionKey`, `nullMoveFen`, `forcingDensity`, `kingAttacked`, `attacksSquare`; `boardFromPositionCommand`; `positionStats`; `candidateFeatures`; types `Features`, `PositionStats`.

- [ ] **Step 1: Write failing tests ported from `tests/test_chess_features.py`**

Cover every case in that file: tension `c2c4`, capture `F_S`, check `F_I`, history reconstruction, castling/promotion, pins, promotion simplification, queen threat, reserve/coordination, pawn break/king margin, phase/material, null move, halfmove reset, explicit probe features, position stats. Use the same FENs and expected values.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run tests/chess-features.test.ts`
Expected: FAIL because `../src/chess-features` does not exist.

- [ ] **Step 3: Port `kairos/chess_features.py` one-to-one**

Keep the Python formulas and clamps. Use `squares: (string | null)[]` indexed `a1=0`; camelCase method names; `positionStats` returns `{ tension, ownKingAttackers, ownKingDefenders, enemyKingAttackers, enemyKingDefenders, phase, materialBalance }`. `candidateFeatures(board, move, probes?)` returns `{ T, F_T, F_N, F_R, F_C, F_F, F_P, F_K, F_S, F_I }`; `F_N`/`F_P` come only from `probes`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run tests/chess-features.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/chess-features.ts web/tests/chess-features.test.ts
git commit -m "feat(web): port chess board and nine features"
```

---

### Task 3: Postures port

**Files:**
- Create: `web/src/postures.ts`, `web/tests/postures.test.ts`

**Interfaces:**
- Consumes: `Features` and `PositionStats` from `chess-features.ts`.
- Produces: `POSTURES`, `Posture`, `FEATURES`, `FeatureName`, `WEIGHTS`, `Mix`, `Evidence`, `PostureController` (`mix`, `update`, `reset`), `planToken`, `oneHot`, `normalize`, `dominant`, `weightedFeatures`, `softmax`, `sampleIndex`, `scoreTrend`, `evidenceFromStats`, `positionClass`, `updateFragility`, `varietyTemperature`, `inferMix`, `mulberry32`.

- [ ] **Step 1: Write failing tests ported from `tests/test_postures.py`**

Cover the weight table, weighted features, plan tokens, trend, evidence normalization, all inference cases, position classes, fragility EWMA, variety rules, hysteresis (two-move inertia, immediate Strike override, Distill lock/exit), forced posture, and `sampleIndex` argmax/exploration.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run tests/postures.test.ts`
Expected: FAIL because `../src/postures` does not exist.

- [ ] **Step 3: Port `kairos/postures.py` one-to-one**

Keep the weight table and constants exactly. `Mix` is `Record<Posture, number>`. `dominant` preserves tuple order on ties. `sampleIndex` uses `rng() * total` and `threshold <= upto`. Add `mulberry32(seed): () => number`; document that it is seed-stable but not Python-compatible.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run tests/postures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/postures.ts web/tests/postures.test.ts
git commit -m "feat(web): port postures, inference and hysteresis"
```

### Task 4: Parity vector exporter

**Files:**
- Create: `scripts/export_web_vectors.py`, `web/tests/vectors.test.ts`, `web/tests/vectors/*.json`
- Modify: `web/package.json` (already has `vectors:check`)

**Interfaces:**
- Consumes: the Python `chess_features`, `postures`, and `uci_proxy` modules.
- Produces: five JSON fixtures with the schemas below; `python3 scripts/export_web_vectors.py --check` exits 1 when fixtures are stale.

- [ ] **Step 1: Write the exporter**

`scripts/export_web_vectors.py` inserts `kairos/` into `sys.path`, imports `Board`, `board_from_position_command`, `candidate_features`, `position_stats` and the posture/controller functions plus `parse_info`, `result_band`, `is_saturated`, `supported_personality_search`, `repetition_blocked`, `fifty_move_blocked`. It writes `web/tests/vectors/` with `indent=2, sort_keys=True`.

Schemas (all keys camelCase):
- `board.json`: `{ "cases": [{ "fen", "move", "fenAfter", "positionKey", "halfmoveReset", "capturedValue", "materialDelta", "givesCheck", "threatensQueen" }] }`
- `features.json`: `{ "cases": [{ "fen", "moves": [...], "stats": {...}, "features": { "<move>": {...} } }] }`
- `postures.json`: `{ "weights", "planTokens", "trend": [...], "evidence": [...], "inference": [...], "classes": [...], "fragility": [...], "variety": [...], "controller": [...] }`
- `parse_info.json`: `{ "cases": [{ "line", "candidate" | null }] }`
- `guards.json`: `{ "resultBand": [...], "saturation": [...], "repetition": [...], "fiftyMove": [...], "supported": [...] }`

Use the FENs and moves from `tests/test_chess_features.py`, the evidence cases from `tests/test_postures.py`, and the parse/guard cases from `tests/test_protocol.py`. Do not export sampled `sampleIndex` results; the PRNG differs by design.

- [ ] **Step 2: Generate the fixtures**

Run: `python3 scripts/export_web_vectors.py`
Expected: five JSON files in `web/tests/vectors/`.

- [ ] **Step 3: Write the failing parity test**

`web/tests/vectors.test.ts` loads each JSON and asserts:
- board cases: `Board.fromFen(fen).applyUci(move)` matches `fenAfter`, `positionKey`, `halfmoveReset`, `capturedValue`, `materialDelta`, `givesCheck`, `threatensQueen`;
- feature cases: `positionStats` and every `candidateFeatures` match within `1e-9`;
- posture cases: weights, plan tokens, trend, evidence, inference mix, class, fragility, variety temperature, controller steps match within `1e-9`;
- parse cases: `parseInfo` matches the candidate or null;
- guard cases: result band, saturation, repetition, fifty-move, supported-search match.

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd web && npx vitest run tests/vectors.test.ts`
Expected: FAIL until `chess-features.ts` and `postures.ts` match the vectors.

- [ ] **Step 5: Add the freshness check and verify**

Implement `--check` by generating all files into memory and comparing bytes with the committed files; on mismatch print `stale vectors: run python3 scripts/export_web_vectors.py` and exit 1. Run `python3 scripts/export_web_vectors.py --check` and `cd web && npx vitest run tests/vectors.test.ts`. Expected: check exits 0; test passes.

- [ ] **Step 6: Commit**

```bash
git add scripts/export_web_vectors.py web/tests/vectors web/tests/vectors.test.ts
git commit -m "test(web): add Python parity vectors"
```

---

### Task 5: Controller primitives and guards

**Files:**
- Create: `web/src/controller.ts` (first half), `web/tests/controller-primitives.test.ts`

**Interfaces:**
- Consumes: `Board`, `boardFromPositionCommand` from `chess-features.ts`.
- Produces: `Candidate`, `ScoreKind`, `expectedScore`, `parseInfo`, `resultBand`, `isSaturated`, `supportedPersonalitySearch`, `repetitionBlocked`, `fiftyMoveBlocked`.

- [ ] **Step 1: Write failing tests**

Port `ParseInfoTests` and `GuardTests` from `tests/test_protocol.py`:
- exact cp score parses `scoreKind`, `scoreValue`, `wdl`, `pv`, `multipv`, `depth`;
- `lowerbound`/`upperbound` return null;
- missing pv, missing wdl, zero-sum wdl, missing depth or score return null;
- result bands at 0.55, 0.45, 0.50;
- saturation at 0.99/0.01;
- supported search: `go depth 4`, `go movetime 2000` true; `go depth 4 movetime 1000`, `go movetime 1000 depth 4`, clock, infinite, nodes, mate, perft false;
- repetition and fifty-move guards from `GuardTests`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run tests/controller-primitives.test.ts`
Expected: FAIL because the exports do not exist.

- [ ] **Step 3: Implement the primitives**

Port `parse_info`, `result_band`, `is_saturated`, `supported_personality_search`, `repetition_blocked`, `fifty_move_blocked` one-to-one. `supportedPersonalitySearch` returns `{ supported, kind, amount, reason }`. `repetitionBlocked` takes `Map<string, number> | Record<string, number>`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run tests/controller-primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/controller.ts web/tests/controller-primitives.test.ts
git commit -m "feat(web): add UCI parsing and safety guards"
```

---

### Task 6: Controller handshake and passthrough

**Files:**
- Modify: `web/src/controller.ts`
- Create: `web/tests/mock-engine.ts`, `web/tests/controller-basic.test.ts`

**Interfaces:**
- Consumes: the Task 5 primitives.
- Produces: `EnginePort`, `KairosOptions`, `Rationale`, `ControllerEvent`, `UiCommand`, `KairosController` with `handleCommand(command)` and `handleEngineLine(line)`.

Pin these public types:

```ts
export interface EnginePort { send(line: string): void; }
export interface KairosOptions {
  style: number; posture: Posture | "Auto"; variety: number;
  verbose: boolean; allowUnverifiedEngine: boolean;
}
export interface Rationale {
  kind: "rerank" | "fallback" | "stockfish";
  reason: string;
  posture: Posture; confidence: number; mix: Mix; plan: string;
  budgetPct: number; lossPct: number; pick: number; sfBest: string;
  features?: Features;
}
export type ControllerEvent =
  | { type: "ready"; engine: string }
  | { type: "engine-info"; depth: number; multipv: number; score: string; wdl?: [number, number, number]; requestId?: number }
  | { type: "bestmove"; move: string; ponder?: string; rationale: Rationale; requestId?: number }
  | { type: "log"; line: string }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "quit" };
export type UiCommand =
  | { type: "init"; options?: Partial<KairosOptions>; seed?: number }
  | { type: "newgame" }
  | { type: "setoption"; name: string; value: string }
  | { type: "position"; command: string }
  | { type: "go"; command: string; requestId?: number }
  | { type: "stop" }
  | { type: "quit" };
export class KairosController {
  constructor(port: EnginePort, emit: (event: ControllerEvent) => void);
  handleCommand(command: UiCommand): void;
  handleEngineLine(line: string): void;
}
```

- [ ] **Step 1: Write the mock engine**

`web/tests/mock-engine.ts` implements `EnginePort` and queues output with `queueMicrotask`. It handles `uci` (id `Stockfish 19 Mock`, options Threads/Hash/MultiPV/UCI_ShowWDL), `isready`, `setoption`, `position`, `go`, `stop`, `quit`, and logs every received line. `normal` returns `bestmove e2e4` for a plain search; `searchmoves` returns two info lines and the first searchmove. Add a `tick()` helper: `new Promise(resolve => setTimeout(resolve, 0))`.

- [ ] **Step 2: Write failing basic tests**

- `init` sends `uci`, then forces `Threads 1`, `Hash 32`, `MultiPV 1`, `UCI_ShowWDL true`, then `isready`; `ready` carries the engine id.
- `allowUnverifiedEngine: false` with id `KAIROS Mock Fixture (not Stockfish)` emits a non-recoverable `error` and no `ready`.
- `style: 0` with `go depth 4` sends no `MultiPV 5` and emits `bestmove e2e4` with `rationale.kind === "stockfish"` and reason `style-zero`.
- Clock, multiple limits, `infinite`, `nodes`, `mate`, `perft`, and `movetime 1000` passthrough with reason from `supportedPersonalitySearch`.
- `position` updates the stored command; `newgame` resets counts and sends `ucinewgame`.
- `stop` during passthrough forwards `stop`; `quit` emits `quit`.
- `go` with `requestId: 7` echoes `requestId: 7` on `bestmove`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && npx vitest run tests/controller-basic.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the handshake and passthrough state machine**

Buffer non-`init`/`quit` commands until `readyok`, as Python does during `uci`. On `uciok`, collect options and send the four forced options plus `isready`. Passthrough sends `setoption name MultiPV value 1`, then the original `go`; on `bestmove`, emit with a `stockfish` rationale. `stop` sets `stopRequested` and sends `stop`. `quit` either sends `quit` immediately or stops first and emits `quit` after the search finishes. Implement `newgame` reset and deferred-command handling; `position`/`go`/unknown `setoption` during a search are deferred and stop the search.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run tests/controller-basic.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/controller.ts web/tests/mock-engine.ts web/tests/controller-basic.test.ts
git commit -m "feat(web): add controller handshake and passthrough"
```

---

### Task 7: Personality pipeline

**Files:**
- Modify: `web/src/controller.ts`, `web/tests/mock-engine.ts`
- Create: `web/tests/controller-personality.test.ts`

**Interfaces:**
- Consumes: `KairosController`, `PostureController`, `positionStats`, `candidateFeatures`, primitives.
- Produces: the full main/probe/verify pipeline and `Rationale.kind` values `rerank`/`fallback`.

- [ ] **Step 1: Extend the mock scenarios**

Add scenarios keyed exactly as `tests/mock_stockfish.py`: `normal`, `reject-verify`, `mate-main`, `no-wdl`, `depth-mismatch`, `saturated-main`, `saturated-verify`, `bound-main`, `probe-mate`, `verify-loss`, `winning-main`. Use the fixture FEN `4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1` and the child/null probe FEN branches. Log all commands.

- [ ] **Step 2: Write failing pipeline tests**

Port the mock protocol tests:
- Coil rerank: MultiPV 5, `searchmoves e1d2 c2c4`, final `c2c4`, rationale `kind: "rerank"`, posture COIL, plan `hold-tension`, budget/loss/features present.
- Probes on `go depth 6`: null + candidate probes, MultiPV 3, `go depth 3`, `F_N=1.0`, `F_P=0.25`, no probe info forwarded, final `c2c4`.
- `probe-mate` falls back to `e1d2`.
- Movetime split: 2000 → main 1500, verify 200; 4000 → main 2600, probes 333, verify 400.
- Variety: seed 1 and seed 0 produce deterministic picks; a non-best pick still triggers `searchmoves`; forced postures and Strike/Distill disable sampling.
- Cumulative budget: style 100 with `verify-loss`, four searches; first three accepted, fourth `e1d2`, four `searchmoves` calls.
- Fifty-move guard keeps `c2c4` at halfmove 90.
- Distill skip with `winning-main`: `e1d2`, no `searchmoves`, no `go depth 3`.
- Fallbacks: depth mismatch, any mate, missing WDL, bound score, saturated main, saturated verify, verification rejection; all `e1d2` with `rationale.kind === "fallback"` and the matching reason.
- Stop during main, probe, and verify returns the Stockfish best.
- Deferred `position`/`go` during a search runs after the stop and uses the new `requestId`.
- Malformed position (`position fen nonsense`) still returns a legal bestmove with a fallback rationale.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && npx vitest run tests/controller-personality.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the pipeline**

Port `Search`, `_update_posture`, `_eligible_candidates`, `_probe_features`, `_score_candidates`, `_probes_enabled`, `_start_probes`, `_send_probe`, `_advance_probe`, `_finish_probe`, `_finish_probes`, `_finish_scoring`, `_finish_main`, `_finish_verification`, `_search_finished`, `_track_positions`, `_handle_setoption`. Keep the Python guard order exactly. Every exit path emits a `Rationale`: rerank after verification, fallback with the guard reason, or stockfish for passthrough. Emit `engine-info` only for main/passthrough info lines; suppress probe and verify info. Keep `spentHistory` and set its last entry to the verified loss on acceptance.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run tests/controller-personality.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd web && npm test`
Expected: all previous tests still pass.

```bash
git add web/src/controller.ts web/tests/mock-engine.ts web/tests/controller-personality.test.ts
git commit -m "feat(web): port KAIROS main, probe and verification pipeline"
```

### Task 8: Worker protocol, controller worker and engine host

**Files:**
- Create: `web/src/protocol.ts`, `web/src/kairos-worker.ts`, `web/src/engine-host.ts`, `web/tests/engine-host.test.ts`

**Interfaces:**
- Consumes: `KairosController`, `UiCommand`, `ControllerEvent`.
- Produces: `WorkerRequest`, `WorkerResponse`, `EngineHost`.

Pin these:

```ts
// protocol.ts
export type WorkerRequest = UiCommand | { type: "engine-line"; line: string };
export type WorkerResponse = ControllerEvent | { type: "engine-send"; line: string };

// engine-host.ts
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}
export class EngineHost {
  constructor(factory: () => WorkerLike, onLine: (line: string) => void, onError: (error: Error) => void);
  send(line: string): void;
  terminate(): void;
  restart(): boolean; // false on the second consecutive failure
}
```

- [ ] **Step 1: Write the failing engine-host test**

Use two fake `WorkerLike` objects. Assert: `onLine` receives a line from `worker.onmessage`; `onError` receives `worker.onerror`; `send` posts the string; `restart()` terminates the old worker, creates a new one, and returns true; a second `restart()` returns false; `terminate()` stops forwarding.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run tests/engine-host.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `protocol.ts`, `engine-host.ts`, `kairos-worker.ts`**

`EngineHost` wires `onmessage` to `onLine(String(event.data))` and `onerror` to `onError(new Error(...))`. `restart()` returns false when `restarts >= 1`; a successful later `send` does not reset the counter. `kairos-worker.ts` casts `self` to a minimal `{ postMessage, onmessage }` shape (do not add the WebWorker lib), routes `engine-line` to `controller.handleEngineLine`, and routes other messages to `controller.handleCommand`. The controller port posts `{ type: "engine-send", line }`; every controller event is posted unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run tests/engine-host.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/protocol.ts web/src/kairos-worker.ts web/src/engine-host.ts web/tests/engine-host.test.ts
git commit -m "feat(web): add controller worker and engine host"
```

---

### Task 9: Game helpers and UI

**Files:**
- Create: `web/src/game.ts`, `web/tests/game.test.ts`
- Modify: `web/src/main.ts`, `web/src/style.css`, `web/index.html`

**Interfaces:**
- Consumes: `chess.js`, `EngineHost`, `WorkerRequest`/`WorkerResponse`.
- Produces: `positionCommand(game)`, `applyEngineMove(game, uci)`, and the full page.

Pin these:

```ts
export function positionCommand(game: Chess): string; // "position startpos [moves ...]"
export function applyEngineMove(game: Chess, uci: string): Move | null;
```

- [ ] **Step 1: Write failing game-helper tests**

- `positionCommand(new Chess()) === "position startpos"`.
- After `e2e4 e7e5`, the command is `position startpos moves e2e4 e7e5`.
- `applyEngineMove(game, "e2e4")` applies and returns the move.
- `applyEngineMove(game, "e2e5")`, `"0000"`, `"(none)"`, and `""` return null and leave the FEN unchanged.
- A promotion move `a7a8q` applies and the board has a queen on a8.
- A promotion UCI missing the piece (`a7a8`) tries queen and succeeds when legal.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run tests/game.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the helpers and the page**

`main.ts` creates the controller worker (`new Worker(new URL("./kairos-worker.ts", import.meta.url), { type: "module" })`) and the engine worker (`new Worker(new URL("engine/stockfish-19-lite-single.js", document.baseURI))`). Relay: controller `engine-send` → engine `postMessage`; engine message → controller `{ type: "engine-line", line: String(data) }`.

The page: 8x8 CSS grid with Unicode pieces, click/tap selection, legal destination dots from `game.moves({ verbose: true })`, last-move highlight, check highlight, promotion picker, move list, status with `aria-live`, and reset/flip/side/style/posture/variety/think-time controls. Default `playerColor = "w"`, `style = 50`, `posture = "Auto"`, `variety = 0`, `thinkTime = 2000`. Think-time options are 1500/2000/3000/5000/10000.

The game loop: after a player move, send `position` and `go movetime <thinkTime>` with `requestId = ++counter`; arm the watchdog at `thinkTime + 10000`; on `bestmove`, ignore mismatched ids, clear the watchdog, apply with `applyEngineMove`, and if it returns null show a blocking alert and disable engine moves for the game. On `ready`, if it is the engine's turn, ask. On new game, increment the request counter, reset the board, send `newgame`, then ask only if the engine is to move. On `query ?dev=1`, pass `allowUnverifiedEngine: true`.

Engine load: wait for `ready`; if not ready within 10 s, show a retry banner. On engine worker error, call `host.restart()`; if false, show the banner and stop. The retry button creates a fresh controller and engine worker, resets the failure counter, and re-inits with the current settings. Expose `window.__kairos = { lastThinkMs, readyMs }` for the browser test.

- [ ] **Step 4: Run the tests and the build**

Run: `cd web && npx vitest run tests/game.test.ts && npm run build`
Expected: PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/game.ts web/src/main.ts web/src/style.css web/index.html web/tests/game.test.ts
git commit -m "feat(web): add board, controls and game loop"
```

---

### Task 10: Build script and release archive

**Files:**
- Create: `scripts/build_web.sh`, `web/README-WEB.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `web/` and an engine directory.
- Produces: `dist/kairos-lite-web-<tag>.tar.gz`.

- [ ] **Step 1: Write `scripts/build_web.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-dev}"
ENGINE_DIR="${KAIROS_LITE_ENGINE_DIR:-${ROOT}/dist/stockfish-19-lite-single}"
JS="${ENGINE_DIR}/stockfish-19-lite-single.js"
WASM="${ENGINE_DIR}/stockfish-19-lite-single.wasm"
[[ -f "${JS}" && -f "${WASM}" ]] || {
  echo "ERROR: ${JS} and ${WASM} are required." >&2
  echo "Build with ./scripts/build_wasm.sh lite or set KAIROS_LITE_ENGINE_DIR." >&2
  exit 1
}
mkdir -p "${ROOT}/web/public/engine"
cp "${JS}" "${WASM}" "${ROOT}/web/public/engine/"
(cd "${ROOT}/web" && npm ci && npm run build)
pkg="kairos-lite-web-${TAG}"
rm -rf "${ROOT}/dist/${pkg}"
mkdir -p "${ROOT}/dist/${pkg}"
cp -r "${ROOT}/web/dist/." "${ROOT}/dist/${pkg}/"
cp "${ROOT}/LICENSE" "${ROOT}/THIRD_PARTY.md" "${ROOT}/dist/${pkg}/"
cp "${ROOT}/web/README-WEB.md" "${ROOT}/dist/${pkg}/README-WEB.md"
tar -C "${ROOT}/dist" -czf "${ROOT}/dist/${pkg}.tar.gz" "${pkg}"
echo "Built ${ROOT}/dist/${pkg}.tar.gz"
```

- [ ] **Step 2: Write `web/README-WEB.md`**

Cover: what it is (KAIROS personality around Stockfish 19 Lite single-threaded), serve with any static server and no COOP/COEP, controls and defaults, the 1500 ms personality floor, no Elo claim, engine provenance/license, development commands, and the measured performance table (fill after Task 11).

- [ ] **Step 3: Build the archive with the pinned engine**

Extract `stockfish-19-lite-single.tar.gz` from the v0.1.0 release into `/tmp/opencode/kairos-engine`, then:

Run: `KAIROS_LITE_ENGINE_DIR=/tmp/opencode/kairos-engine/stockfish-19-lite-single ./scripts/build_web.sh v0.2.0`
Expected: `dist/kairos-lite-web-v0.2.0.tar.gz`; `tar -tzf` lists `index.html`, `assets/`, `engine/stockfish-19-lite-single.js`, `.wasm`, `LICENSE`, `THIRD_PARTY.md`, `README-WEB.md`.

- [ ] **Step 4: Verify relative asset paths**

Run: `tar -xOf dist/kairos-lite-web-v0.2.0.tar.gz kairos-lite-web-v0.2.0/index.html | grep -E 'src="\./assets|href="\./assets'`
Expected: matches relative `./assets/...` paths, so the page works under any static subpath.

- [ ] **Step 5: Commit**

```bash
git add scripts/build_web.sh web/README-WEB.md .gitignore
git commit -m "build(web): package KAIROS Web Lite release"
```

### Task 11: Browser smoke and performance

**Files:**
- Create: `web/playwright.config.ts`, `web/browser-tests/smoke.spec.ts`, `web/tests/performance.test.ts`
- Modify: `web/README-WEB.md`

**Interfaces:**
- Consumes: the built page and `web/public/engine` from Task 10.
- Produces: browser evidence and a measured performance line in the README.

- [ ] **Step 1: Write the Playwright config**

`testDir: "./browser-tests"`, `timeout: 60000`, `use.baseURL: "http://127.0.0.1:4173"`, `webServer: { command: "npm run preview -- --port 4173 --strictPort", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI, timeout: 30000 }`.

- [ ] **Step 2: Write the smoke tests**

- Happy path: collect `page.on("console")` errors and `pageerror`; goto `/`; wait for `#status` to contain `Ready` (30 s); click `[data-square="e2"]` then `[data-square="e4"]`; wait for `#move-list` to contain `e4` and for the engine reply (two plies); assert `#rationale` is visible; assert `await page.evaluate(() => window.__kairos.lastThinkMs)` is greater than 0; assert no console errors except favicon.
- Load failure: `page.route("**/stockfish-19-lite-single.wasm", route => route.abort())`; goto `/`; expect `#error-banner` visible within 15 s and `#retry` present.
- Stale move: start a game, click New Game while the engine is thinking, assert the board is back at start and the engine replies to the new game only (move list contains exactly the engine's first move, no move from the old game).

- [ ] **Step 3: Write the performance test**

`web/tests/performance.test.ts` loads `features.json`, builds each board, calls `positionStats` and `candidateFeatures` for every listed move under `performance.now()`, logs `features: <ms> ms / <n> cases`, and asserts the average is below 50 ms.

- [ ] **Step 4: Run the browser and performance tests**

Run: `cd web && npx playwright install chromium && npm run test:browser && npx vitest run tests/performance.test.ts`
Expected: both smoke tests pass (the second may take up to 15 s), stale-move test passes, performance assertion passes.

- [ ] **Step 5: Record the measurement**

Replace the placeholder performance row in `web/README-WEB.md` with the measured feature time and the observed think time from `__kairos.lastThinkMs`.

- [ ] **Step 6: Commit**

```bash
git add web/playwright.config.ts web/browser-tests web/tests/performance.test.ts web/README-WEB.md
git commit -m "test(web): add browser smoke and performance checks"
```

---

### Task 12: Same-engine end-to-end parity

**Files:**
- Create: `web/tests/node-engine.ts`, `web/tests/e2e.test.ts`

**Interfaces:**
- Consumes: `KairosController`, `NodeEnginePort`, the Python proxy, the Lite engine.
- Produces: the strongest parity check: the same engine, two implementations, same final move.

- [ ] **Step 1: Write the Node engine port**

`NodeEnginePort implements EnginePort` spawns `node <enginePath>`, reads stdout by line, exposes `onLine`, `send`, and `terminate`. Reject on spawn error.

- [ ] **Step 2: Write the failing E2E test**

Locate the engine from `KAIROS_LITE_ENGINE` or `web/public/engine/stockfish-19-lite-single.js`; `test.skip` when absent. For each of two positions (the fixture FEN and `position startpos moves e2e4 e7e5`), run:
- TS: init with `allowUnverifiedEngine: false`, style 50, Auto, variety 0, seed 1; `position`; `go depth 5`; collect the `bestmove` and rationale.
- Python: spawn `python3 kairos/uci_proxy.py --engine "node <engine>" --log ""`; send `uci`, `isready`, `setoption name KairosVerbose value true`, the position, `go depth 5`; collect the `info string kairos ...` rationale and `bestmove`; quit.

Assert the moves are equal. When both sides emitted a rationale, assert the posture and plan are equal. Timeout 120 s.

- [ ] **Step 3: Run the test to verify it fails or skips**

Run: `cd web && KAIROS_LITE_ENGINE=public/engine/stockfish-19-lite-single.js npx vitest run tests/e2e.test.ts`
Expected: FAIL on a real port bug, or SKIP if the engine is absent. With the engine present and the port correct: PASS.

- [ ] **Step 4: Fix any parity drift**

If the moves differ, compare the handshake option order, the position string, the MultiPV sequence, the probe labels/order, and the verification `searchmoves` string. Fix the TS side; never change the Python oracle to match a bug.

- [ ] **Step 5: Run the full suite and commit**

Run: `cd web && KAIROS_LITE_ENGINE=public/engine/stockfish-19-lite-single.js npm test`
Expected: all tests pass; E2E runs rather than skips.

```bash
git add web/tests/node-engine.ts web/tests/e2e.test.ts
git commit -m "test(web): add same-engine parity with the Python proxy"
```

---

### Task 13: CI and release workflows

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `scripts/build_web.sh`, `web/`, the v0.1.0 Lite asset.
- Produces: a required `web` CI job and the `kairos-lite-web-<tag>.tar.gz` release asset.

- [ ] **Step 1: Add the CI web job**

```yaml
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with: { python-version: "3.12" }
      - uses: actions/setup-node@v7
        with: { node-version: "22" }
      - name: Vector freshness
        run: python3 scripts/export_web_vectors.py --check
      - name: Download pinned Lite engine
        run: |
          set -euo pipefail
          mkdir -p "${RUNNER_TEMP}/kairos-engine"
          curl -L --fail -o "${RUNNER_TEMP}/kairos-engine/lite.tar.gz" \
            https://github.com/rizzonicola/KAIROS/releases/download/v0.1.0/stockfish-19-lite-single.tar.gz
          curl -L --fail -o "${RUNNER_TEMP}/kairos-engine/SHA256SUMS" \
            https://github.com/rizzonicola/KAIROS/releases/download/v0.1.0/SHA256SUMS
          cd "${RUNNER_TEMP}/kairos-engine"
          grep 'stockfish-19-lite-single.tar.gz' SHA256SUMS | sha256sum -c -
          tar -xzf lite.tar.gz
      - name: Install
        run: cd web && npm ci
      - name: Build and package
        env:
          KAIROS_LITE_ENGINE_DIR: ${{ runner.temp }}/kairos-engine/stockfish-19-lite-single
        run: ./scripts/build_web.sh ci
      - name: Tests
        env:
          KAIROS_LITE_ENGINE: ${{ github.workspace }}/web/public/engine/stockfish-19-lite-single.js
        run: cd web && npm test
      - name: Browser smoke
        run: |
          cd web
          npx playwright install --with-deps chromium
          npm run test:browser
```

The build step copies the engine into `web/public/engine` before tests, so E2E and the browser smoke both use the same pinned files.

- [ ] **Step 2: Add the release web job**

```yaml
  web:
    name: KAIROS Web Lite
    needs: [wasm]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.release.tag_name || inputs.tag }}
      - uses: actions/setup-node@v7
        with: { node-version: "22" }
      - uses: actions/download-artifact@v8
        with: { name: wasm, path: ${{ runner.temp }}/wasm }
      - name: Extract Lite engine
        run: |
          set -euo pipefail
          mkdir -p "${RUNNER_TEMP}/kairos-engine"
          tar -xzf "${RUNNER_TEMP}/wasm/stockfish-19-lite-single.tar.gz" -C "${RUNNER_TEMP}/kairos-engine"
      - name: Build page
        env:
          KAIROS_LITE_ENGINE_DIR: ${{ runner.temp }}/kairos-engine/stockfish-19-lite-single
        run: ./scripts/build_web.sh "${TAG}"
      - uses: actions/upload-artifact@v7
        with:
          name: web
          path: dist/kairos-lite-web-*.tar.gz
          if-no-files-found: error
```

- [ ] **Step 3: Include the web asset in publish**

Change `needs: [native, wasm]` to `needs: [native, wasm, web]` on the publish job. The existing `sha256sum -- *.tar.gz` picks up the web archive automatically.

- [ ] **Step 4: Exclude `__pycache__` from the native archive**

Before the native `tar`, add `find "dist/${pkg}" -type d -name __pycache__ -prune -exec rm -rf {} +`.

- [ ] **Step 5: Validate and commit**

Run: `bash -n scripts/build_web.sh` and `python3 -c "import yaml, pathlib; [yaml.safe_load(pathlib.Path(p).read_text()) for p in ('.github/workflows/ci.yml', '.github/workflows/release.yml')]"` (if PyYAML is unavailable, skip the second command and rely on the next push).
Expected: shell syntax clean.

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: build and test KAIROS Web Lite"
```

---

### Task 14: Documentation and release notes

**Files:**
- Modify: `README.md`, `docs/WASM.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the built archive and measured performance.
- Produces: public documentation for v0.2.0.

- [ ] **Step 1: Update `README.md`**

Add a `KAIROS Web Lite` section: download `kairos-lite-web-v0.2.0.tar.gz`, extract, serve with any static server, open the page; no COOP/COEP; defaults; controls; style 0 = pure Stockfish; every other pick verified; no Elo claim. Link the release asset and `web/README-WEB.md`.

- [ ] **Step 2: Update `docs/WASM.md`**

Clarify that the raw WASM archives are Stockfish engines, while `kairos-lite-web-<tag>.tar.gz` is the KAIROS personality page wrapping `stockfish-19-lite-single`. Add the archive layout and the no-headers requirement.

- [ ] **Step 3: Add the CHANGELOG entry**

```markdown
## v0.2.0 — 2026-11-23

KAIROS Web Lite, the primary browser target.

- Standalone TypeScript page running the KAIROS personality around Stockfish 19
  Lite single-threaded WASM; no Python, backend, `SharedArrayBuffer`, or
  COOP/COEP.
- Full native pipeline in the browser: MultiPV rerank, Soundness Corridor,
  result-band and WDL-saturation guards, optional probes, `searchmoves`
  verification, rolling budget, repetition and 50-move guards, Distill skip,
  seeded variety.
- `KairosStyle=0` remains an exact Stockfish bestmove passthrough.
- Structured rationale for every engine move, including fallbacks and
  passthroughs; stale-result filtering with request ids.
- Python parity vectors, a scripted controller suite, same-engine end-to-end
  tests against the Python oracle, and a Playwright browser smoke test.
- Release asset `kairos-lite-web-v0.2.0.tar.gz`; native archive no longer
  contains `__pycache__`.
```

- [ ] **Step 4: Verify version consistency**

Run: `grep -n '"version"' web/package.json` and check `CHANGELOG.md`.
Expected: both say `0.2.0`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/WASM.md CHANGELOG.md
git commit -m "docs: document KAIROS Web Lite v0.2.0"
```

---

### Task 15: Full verification and release preparation

**Files:** none; verification only.

- [ ] **Step 1: Run the Python suite**

Run: `python3 -m unittest discover -s tests`
Expected: 84 tests pass.

- [ ] **Step 2: Run the web unit, parity and E2E suite**

Run: `cd web && KAIROS_LITE_ENGINE=public/engine/stockfish-19-lite-single.js npm test`
Expected: all tests pass, E2E included.

- [ ] **Step 3: Rebuild and inspect the archive**

Run: `KAIROS_LITE_ENGINE_DIR=/tmp/opencode/kairos-engine/stockfish-19-lite-single ./scripts/build_web.sh v0.2.0 && tar -tzf dist/kairos-lite-web-v0.2.0.tar.gz`
Expected: the archive contains the page, assets, engine, README, LICENSE, THIRD_PARTY.

- [ ] **Step 4: Run the browser smoke**

Run: `cd web && npm run test:browser`
Expected: happy path, load failure, and stale-move tests pass.

- [ ] **Step 5: Check the tree**

Run: `git status --short && git log --oneline -5`
Expected: clean tree; all task commits present.

- [ ] **Step 6: Release (after user confirmation)**

Do not tag or publish automatically. Report the verification results, then on confirmation:

```bash
git tag -a v0.2.0 -m "KAIROS 0.2.0"
git push origin v0.2.0
gh release create v0.2.0 --title "KAIROS 0.2.0" --notes-file CHANGELOG.md
```

The release workflow builds the native archive, the four Stockfish WASM archives, and `kairos-lite-web-v0.2.0.tar.gz`, then attaches all assets and `SHA256SUMS`.

---

## Self-Review

- **Spec coverage:** intent/goals → Tasks 9, 11, 14; non-goals/constraints → Global Constraints; architecture → Tasks 8-9; message protocol → Task 8; controller states → Tasks 6-7; personality pipeline → Task 7; timing → Tasks 6-7; features/postures → Tasks 2-3; UI → Task 9; errors → Tasks 6, 8, 9, 11; parity/tests → Tasks 2-5, 7, 11-12; packaging → Tasks 10, 13; performance → Task 11; risks → Review Focus and tests.
- **Rationale:** every bestmove path emits one; accepted picks are `rerank`, fallbacks name the guard, passthroughs name `style-zero`/unsupported reason.
- **Think time:** UI floor 1500 ms; controller still labels below-floor movetime as `time-too-low` passthrough.
- **CI engine:** pinned v0.1.0 prebuilt with SHA-256; release builds from source in `wasm`.
- **Type consistency:** `KairosController` uses the same `Candidate`, `Rationale`, `Features`, `Mix` names across Tasks 5-9; worker messages use `engine-send`/`engine-line` consistently.
- **Review Focus tests:** stale id → Task 6 requestId echo and Task 11 stale-move test; illegal move → Task 9; load failure → Task 8 restart test and Task 11 abort test; missing WDL/bound/mate → Task 7; malformed position → Task 7; time-too-low → Task 6.

## Execution Handoff

The user already chose native execution in this session, so use `superpowers:executing-plans`. Implement tasks in order, commit after each, and stop only if a task's tests reveal a design conflict that changes the spec.


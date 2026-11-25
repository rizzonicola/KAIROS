import { KairosController, type ControllerEvent, type KairosOptions, type Rationale } from "../src/controller";
import { MockCore, proposal, type MockCoreScript } from "./mock-core";
import { MockEngine, mv, type MockEngineOptions, type MockMove } from "./mock-engine";

export const ROOT = "position startpos moves e2e4 e7e5";

/** Root moves in true order: close enough that the corridor admits several. */
export const ROOT_MOVES: MockMove[] = [
  mv("g1f3", 0.54, 30),
  mv("b1c3", 0.538, 28),
  mv("f1c4", 0.537, 27),
  mv("h2h3", 0.536, 26),
  mv("d2d4", 0.52, 15),
  mv("d2d3", 0.5, 0),
  mv("a2a3", 0.47, -20),
  mv("f1b5", 0.44, -40),
];

export const GOOD_FEATURES = { F_T: 1, F_R: 1, F_F: 1, F_C: 1, F_K: 1, F_I: 1 };

export const DEFAULT_PROPOSALS = [
  proposal("h2h3", "edge", GOOD_FEATURES),
  proposal("d2d4", "lever", { F_T: 1 }),
];

export interface StampedEvent {
  event: ControllerEvent;
  /** Number of UCI lines already sent to the engine when the event was emitted. */
  sentCount: number;
}

export interface Harness {
  controller: KairosController;
  engine: MockEngine;
  core: MockCore;
  events: StampedEvent[];
  deferred: (() => void)[];
  clock: { now: number };
  position(command?: string): void;
  go(command: string, requestId?: number): void;
  flush(): void;
  bestmoves(): { move: string; rationale: Rationale; sentCount: number }[];
  last(): { move: string; rationale: Rationale; sentCount: number };
}

export interface HarnessConfig {
  engine?: Partial<MockEngineOptions>;
  core?: MockCoreScript;
  options?: Partial<KairosOptions>;
}

export function makeHarness(config: HarnessConfig = {}): Harness {
  const engine = new MockEngine({
    root: ROOT_MOVES,
    rootPosition: ROOT,
    ...config.engine,
  });
  const core = new MockCore({
    features: { h2h3: GOOD_FEATURES, d2d4: { F_T: 1 } },
    proposals: DEFAULT_PROPOSALS,
    ...config.core,
  });
  const events: StampedEvent[] = [];
  const deferred: (() => void)[] = [];
  const clock = { now: 0 };
  const controller = new KairosController(
    engine,
    (event) => events.push({ event, sentCount: engine.sent.length }),
    core,
    { defer: (fn) => deferred.push(fn), now: () => clock.now },
  );
  engine.connect((line) => controller.handleEngineLine(line));
  controller.handleCommand({ type: "init", options: config.options ?? {}, seed: 1 });
  const bestmoves = () =>
    events.flatMap((stamped) =>
      stamped.event.type === "bestmove"
        ? [
            {
              move: stamped.event.move,
              rationale: stamped.event.rationale,
              sentCount: stamped.sentCount,
            },
          ]
        : [],
    );
  return {
    controller,
    engine,
    core,
    events,
    deferred,
    clock,
    position: (command = ROOT) => controller.handleCommand({ type: "position", command }),
    go: (command, requestId = 1) => controller.handleCommand({ type: "go", command, requestId }),
    flush: () => {
      let guard = 0;
      while (deferred.length > 0 && guard < 10_000) {
        const next = deferred.shift();
        next?.();
        guard += 1;
      }
    },
    bestmoves,
    last: () => {
      const all = bestmoves();
      return all[all.length - 1];
    },
  };
}

/**
 * Safety properties that must hold for every emitted move (spec section 6):
 *  - a rerank is never emitted without a verification search that contained
 *    both Stockfish's best and the played move,
 *  - the verified loss is within the effective budget,
 *  - anything else is Stockfish's best move.
 * Calling this from every scenario makes the build fail if a rerank slips out
 * unverified.
 */
export interface SafetySubject {
  engine: { sent: string[] };
  bestmoves(): { move: string; rationale: Rationale; sentCount: number }[];
}

export function assertSafety(h: SafetySubject): void {
  for (const played of h.bestmoves()) {
    const r = played.rationale;
    if (r.kind === "rerank") {
      const sentBefore = h.engine.sent.slice(0, played.sentCount);
      const verifications = sentBefore.filter((line) => {
        const tokens = line.split(/\s+/);
        const at = tokens.indexOf("searchmoves");
        const moves = at >= 0 ? tokens.slice(at + 1) : [];
        return moves.length === 2 && moves.includes(r.sfBest) && moves.includes(played.move);
      });
      if (verifications.length === 0) {
        throw new Error(`rerank to ${played.move} was emitted without a verification search`);
      }
      if (played.move === r.sfBest) {
        throw new Error("a rerank must differ from Stockfish's best");
      }
      if (r.lossPct > r.budgetPct + 1e-9) {
        throw new Error(`verified loss ${r.lossPct} exceeds budget ${r.budgetPct}`);
      }
    } else if (r.kind === "fallback" || r.kind === "stockfish") {
      if (r.sfBest !== "" && played.move !== r.sfBest) {
        throw new Error(`${r.kind} (${r.reason}) must play Stockfish's best, played ${played.move}`);
      }
    }
  }
}

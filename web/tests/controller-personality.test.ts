import { describe, expect, it } from "vitest";
import {
  KairosController,
  type ControllerEvent,
  type KairosOptions,
} from "../src/controller";
import { MockEngine, tick, type MockEngineOptions } from "./mock-engine";

const FIXTURE = "position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1";
const STOPPED_POSITION = "position startpos moves e2e4";

interface RunOptions {
  engine?: MockEngineOptions;
  options?: Partial<KairosOptions>;
  seed?: number;
  go: string;
  position?: string;
}

function make(engineOptions: MockEngineOptions = {}) {
  const events: ControllerEvent[] = [];
  const engine = new MockEngine(engineOptions);
  const controller = new KairosController(engine, (event) => events.push(event));
  engine.onLine = (line) => controller.handleEngineLine(line);
  return { engine, controller, events };
}

async function init(
  controller: KairosController,
  options: Partial<KairosOptions> = {},
  seed?: number,
): Promise<void> {
  controller.handleCommand({ type: "init", options, seed });
  await tick();
}

async function run({
  engine: engineOptions,
  options,
  seed,
  go,
  position = FIXTURE,
}: RunOptions) {
  const harness = make(engineOptions);
  await init(harness.controller, options, seed);
  harness.controller.handleCommand({ type: "position", command: position });
  harness.controller.handleCommand({ type: "go", command: go, requestId: 11 });
  await tick();
  return harness;
}

function bestmoves(events: ControllerEvent[]) {
  return events.filter(
    (event): event is Extract<ControllerEvent, { type: "bestmove" }> =>
      event.type === "bestmove",
  );
}

function lastBestmove(events: ControllerEvent[]) {
  const best = bestmoves(events).at(-1);
  if (!best) {
    throw new Error("expected a bestmove event");
  }
  return best;
}

function searchmoves(engine: MockEngine): string[] {
  return engine.received.filter((line) => line.includes(" searchmoves "));
}

describe("personality pipeline", () => {
  it("reranks inside the corridor and verifies against Stockfish", async () => {
    const { engine, events } = await run({ go: "go depth 4" });
    const best = lastBestmove(events);
    expect(best.move).toBe("c2c4");
    expect(best.requestId).toBe(11);
    expect(best.rationale.kind).toBe("rerank");
    expect(best.rationale.reason).toBe("verified");
    expect(best.rationale.posture).toBe("Coil");
    expect(best.rationale.plan).toBe("hold-tension");
    expect(best.rationale.confidence).toBeGreaterThan(0);
    expect(best.rationale.budgetPct).toBeCloseTo(0.75, 9);
    expect(best.rationale.lossPct).toBeCloseTo(0, 9);
    expect(best.rationale.pick).toBe(2);
    expect(best.rationale.sfBest).toBe("e1d2");
    expect(best.rationale.features).toBeDefined();

    expect(engine.received).toContain("setoption name MultiPV value 5");
    expect(engine.received).toContain("setoption name MultiPV value 2");
    expect(engine.received).toContain("go depth 6 searchmoves e1d2 c2c4");
  });

  it("probes narrowness and prophylaxis at depth-3, then suppresses probe info", async () => {
    const { engine, events } = await run({ go: "go depth 6" });
    const best = lastBestmove(events);
    expect(best.move).toBe("c2c4");
    expect(best.rationale.features?.F_N).toBeCloseTo(1.0, 9);
    expect(best.rationale.features?.F_P).toBeCloseTo(0.25, 9);

    expect(engine.received).toContain("setoption name MultiPV value 3");
    expect(engine.received).toContain("go depth 3");
    expect(engine.received).toContain("go depth 8 searchmoves e1d2 c2c4");

    const infos = events.filter((event) => event.type === "engine-info");
    expect(infos.length).toBeGreaterThan(0);
    for (const info of infos) {
      if (info.type === "engine-info") {
        expect(info.depth).not.toBe(3);
        expect(info.depth).not.toBe(8);
      }
    }
  });

  it("falls back when a probe sees mate", async () => {
    const { engine, events } = await run({
      engine: { scenario: "probe-mate" },
      go: "go depth 6",
    });
    const best = lastBestmove(events);
    expect(best.move).toBe("e1d2");
    expect(best.rationale.kind).toBe("fallback");
    expect(best.rationale.reason).toBe("probe-uncertainty");
    expect(searchmoves(engine)).toHaveLength(0);
  });

  it("splits a 2000 ms movetime into main and verification, without probes", async () => {
    const { engine, events } = await run({ go: "go movetime 2000" });
    expect(lastBestmove(events).move).toBe("c2c4");
    expect(engine.received).toContain("go movetime 1500");
    expect(engine.received).toContain(
      "go movetime 200 searchmoves e1d2 c2c4",
    );
    expect(engine.received).not.toContain("setoption name MultiPV value 3");
  });

  it("splits a 4000 ms movetime into main, probes and verification", async () => {
    const { engine, events } = await run({ go: "go movetime 4000" });
    expect(lastBestmove(events).move).toBe("c2c4");
    expect(engine.received).toContain("go movetime 2600");
    expect(engine.received).toContain("go movetime 333");
    expect(engine.received).toContain(
      "go movetime 400 searchmoves e1d2 c2c4",
    );
  });

  it("samples variety deterministically and still verifies a non-best pick", async () => {
    const picks = new Map<number, string>();
    for (const seed of [0, 1]) {
      const first = await run({
        options: { variety: 100 },
        seed,
        go: "go depth 4",
      });
      const second = await run({
        options: { variety: 100 },
        seed,
        go: "go depth 4",
      });
      expect(lastBestmove(second.events).move).toBe(
        lastBestmove(first.events).move,
      );
      picks.set(seed, lastBestmove(first.events).move);
    }

    const nonBest = [...picks.entries()].filter(([, move]) => move !== "e1d2");
    expect(nonBest.length).toBeGreaterThan(0);
    for (const [seed, move] of nonBest) {
      const { engine } = await run({
        options: { variety: 100 },
        seed,
        go: "go depth 4",
      });
      expect(searchmoves(engine)).toContain(
        `go depth 6 searchmoves e1d2 ${move}`,
      );
    }
  });

  it("disables sampling for a forced posture", async () => {
    const seeded = await run({
      options: { variety: 100, posture: "Coil" },
      seed: 0,
      go: "go depth 4",
    });
    const other = await run({
      options: { variety: 100, posture: "Coil" },
      seed: 1,
      go: "go depth 4",
    });
    expect(lastBestmove(other.events).move).toBe(
      lastBestmove(seeded.events).move,
    );
  });

  it("caps cumulative spending and rejects the fourth verified loss", async () => {
    const { engine, controller, events } = make({ scenario: "verify-loss" });
    await init(controller, { style: 100 });
    for (let index = 0; index < 4; index++) {
      controller.handleCommand({ type: "position", command: FIXTURE });
      controller.handleCommand({ type: "go", command: "go depth 4" });
      await tick();
    }
    expect(bestmoves(events).map((event) => event.move)).toEqual([
      "c2c4",
      "c2c4",
      "c2c4",
      "e1d2",
    ]);
    expect(searchmoves(engine)).toHaveLength(4);
    const last = lastBestmove(events);
    expect(last.rationale.kind).toBe("fallback");
    expect(last.rationale.reason).toBe(
      "verification-outside-corridor-or-result-band",
    );
    expect(last.rationale.budgetPct).toBeCloseTo(0.75, 9);
    expect(last.rationale.lossPct).toBeCloseTo(1.0, 9);
    expect(last.rationale.pick).toBe(1);
    expect(last.rationale.features).toBeUndefined();
  });

  it("keeps the pawn break near the fifty-move limit", async () => {
    const { events } = await run({
      position:
        "position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 90 1",
      go: "go depth 4",
    });
    expect(lastBestmove(events).move).toBe("c2c4");
  });

  it("skips reranking when Distill sees a clearly winning position", async () => {
    const { engine, events } = await run({
      engine: { scenario: "winning-main" },
      options: { posture: "Distill" },
      go: "go depth 6",
    });
    const best = lastBestmove(events);
    expect(best.move).toBe("e1d2");
    expect(best.rationale.kind).toBe("fallback");
    expect(best.rationale.reason).toBe("distill-conversion");
    expect(searchmoves(engine)).toHaveLength(0);
    expect(engine.received).not.toContain("go depth 3");
  });
});

describe("fallbacks", () => {
  const cases: [MockEngineOptions["scenario"], string][] = [
    ["depth-mismatch", "no-eligible-rerank"],
    ["mate-main", "mate-score"],
    ["no-wdl", "no-eligible-rerank"],
    ["bound-main", "no-eligible-rerank"],
    ["saturated-main", "no-eligible-rerank"],
    ["saturated-verify", "saturated-score-margin"],
    ["reject-verify", "verification-outside-corridor-or-result-band"],
  ];

  for (const [scenario, reason] of cases) {
    it(`returns Stockfish's best for ${scenario}`, async () => {
      const { engine, events } = await run({
        engine: { scenario },
        go: "go depth 4",
      });
      const best = lastBestmove(events);
      expect(best.move).toBe("e1d2");
      expect(best.rationale.kind).toBe("fallback");
      expect(best.rationale.reason).toBe(reason);
      expect(best.rationale.pick).toBe(1);
      expect(best.rationale.features).toBeUndefined();
      if (scenario === "reject-verify") {
        expect(best.rationale.lossPct).toBeCloseTo(5.0, 9);
      }
      if (scenario === "saturated-verify" || scenario === "reject-verify") {
        expect(searchmoves(engine)).toContain(
          "go depth 6 searchmoves e1d2 c2c4",
        );
      } else {
        expect(searchmoves(engine)).toHaveLength(0);
      }
    });
  }
});

describe("stops", () => {
  it("falls back when stopped during the main search", async () => {
    const { engine, controller, events } = make({ hold: "main" });
    await init(controller);
    controller.handleCommand({ type: "position", command: FIXTURE });
    controller.handleCommand({ type: "go", command: "go depth 4" });
    await tick();
    controller.handleCommand({ type: "stop" });
    await tick();

    expect(engine.received).toContain("stop");
    const best = lastBestmove(events);
    expect(best.move).toBe("e1d2");
    expect(best.rationale.kind).toBe("fallback");
    expect(best.rationale.reason).toBe("stopped-during-main");
  });

  it("falls back when stopped during a probe", async () => {
    const { engine, controller, events } = make({ hold: "probe" });
    await init(controller);
    controller.handleCommand({ type: "position", command: FIXTURE });
    controller.handleCommand({ type: "go", command: "go depth 6" });
    await tick();
    expect(engine.received).toContain("go depth 3");
    controller.handleCommand({ type: "stop" });
    await tick();

    const best = lastBestmove(events);
    expect(best.move).toBe("e1d2");
    expect(best.rationale.kind).toBe("fallback");
    expect(best.rationale.reason).toBe("stopped-during-probe");
  });

  it("falls back when stopped during verification", async () => {
    const { engine, controller, events } = make({ hold: "verify" });
    await init(controller);
    controller.handleCommand({ type: "position", command: FIXTURE });
    controller.handleCommand({ type: "go", command: "go depth 4" });
    await tick();
    expect(searchmoves(engine).length).toBeGreaterThan(0);
    controller.handleCommand({ type: "stop" });
    await tick();

    const best = lastBestmove(events);
    expect(best.move).toBe("e1d2");
    expect(best.rationale.kind).toBe("fallback");
    expect(best.rationale.reason).toBe("stopped-during-verification");
  });
});

describe("defensive paths", () => {
  it("runs a deferred position and go after the stopped search", async () => {
    const { engine, controller, events } = make({ hold: "main" });
    await init(controller);
    controller.handleCommand({ type: "position", command: FIXTURE });
    controller.handleCommand({ type: "go", command: "go depth 4", requestId: 1 });
    await tick();

    controller.handleCommand({
      type: "position",
      command: STOPPED_POSITION,
    });
    controller.handleCommand({ type: "go", command: "go depth 4", requestId: 2 });
    await tick();
    // The new go stops the held search; its bestmove releases the queue.
    expect(lastBestmove(events).requestId).toBe(1);
    expect(engine.received).toContain("stop");
    expect(engine.received).toContain(STOPPED_POSITION);

    controller.handleCommand({ type: "stop" });
    await tick();
    expect(lastBestmove(events).requestId).toBe(2);
  });

  it("returns a legal move for a malformed position command", async () => {
    const { events } = await run({
      position: "position fen nonsense",
      go: "go depth 4",
    });
    const best = lastBestmove(events);
    expect(best.move).toBe("e2e4");
    expect(best.rationale.kind).toBe("fallback");
  });
});

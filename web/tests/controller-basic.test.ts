import { describe, expect, it } from "vitest";
import {
  KairosController,
  type ControllerEvent,
  type KairosOptions,
} from "../src/controller";
import { MockEngine, tick } from "./mock-engine";

function make(engineOptions: { id?: string; hold?: boolean } = {}) {
  const events: ControllerEvent[] = [];
  const engine = new MockEngine(engineOptions);
  const controller = new KairosController(engine, (event) => events.push(event));
  engine.onLine = (line) => controller.handleEngineLine(line);
  return { engine, controller, events };
}

async function start(
  controller: KairosController,
  options: Partial<KairosOptions> = {},
): Promise<void> {
  controller.handleCommand({ type: "init", options });
  await tick();
}

function lastBestmove(events: ControllerEvent[]) {
  const best = [...events].reverse().find((event) => event.type === "bestmove");
  if (!best || best.type !== "bestmove") {
    throw new Error("expected a bestmove event");
  }
  return best;
}

describe("handshake", () => {
  it("forces Threads, Hash, MultiPV and UCI_ShowWDL before isready", async () => {
    const { engine, controller, events } = make();
    await start(controller);
    expect(engine.received).toEqual([
      "uci",
      "setoption name Threads value 1",
      "setoption name Hash value 32",
      "setoption name MultiPV value 1",
      "setoption name UCI_ShowWDL value true",
      "isready",
    ]);
    expect(events).toEqual([{ type: "ready", engine: "Stockfish 19 Mock" }]);
  });

  it("refuses a backend that is not Stockfish 19 by default", async () => {
    const { engine, controller, events } = make({
      id: "KAIROS Mock Fixture (not Stockfish)",
    });
    await start(controller);
    const error = events.find((event) => event.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.recoverable).toBe(false);
      expect(error.message).toContain("Stockfish 19");
    }
    expect(events.some((event) => event.type === "ready")).toBe(false);
    expect(engine.received).toEqual(["uci"]);
  });

  it("accepts an unverified backend when asked", async () => {
    const { controller, events } = make({ id: "KAIROS Mock Fixture (not Stockfish)" });
    await start(controller, { allowUnverifiedEngine: true });
    expect(events).toContainEqual({
      type: "ready",
      engine: "KAIROS Mock Fixture (not Stockfish)",
    });
  });
});

describe("passthrough", () => {
  it("returns Stockfish's move for style zero and echoes the request id", async () => {
    const { engine, controller, events } = make();
    await start(controller, { style: 0 });
    controller.handleCommand({
      type: "position",
      command: "position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1",
    });
    controller.handleCommand({ type: "go", command: "go depth 4", requestId: 7 });
    await tick();

    expect(engine.received).not.toContain("setoption name MultiPV value 5");
    expect(engine.received).toContain("go depth 4");
    const best = lastBestmove(events);
    expect(best.move).toBe("e2e4");
    expect(best.requestId).toBe(7);
    expect(best.rationale.kind).toBe("stockfish");
    expect(best.rationale.reason).toBe("style-zero");
    expect(best.rationale.posture).toBe("Coil");
    expect(best.rationale.plan).toBe("hold-tension");
  });

  it("passes unsupported searches through with the guard reason", async () => {
    const cases: [string, string][] = [
      ["go wtime 60000 btime 60000 winc 1000 binc 1000", "unsupported-or-clock-search"],
      ["go depth 4 movetime 1000", "multiple-or-missing-limits"],
      ["go infinite", "unsupported-or-clock-search"],
      ["go nodes 1000", "unsupported-or-clock-search"],
      ["go mate 3", "unsupported-or-clock-search"],
      ["go perft 5", "unsupported-or-clock-search"],
      ["go movetime 1000", "time-too-low"],
    ];
    for (const [command, reason] of cases) {
      const { engine, controller, events } = make();
      await start(controller);
      controller.handleCommand({ type: "go", command });
      await tick();
      expect(lastBestmove(events).rationale.kind, command).toBe("stockfish");
      expect(lastBestmove(events).rationale.reason, command).toBe(reason);
      expect(engine.received).toContain(command);
    }
  });

  it("forwards stop and still returns the engine move", async () => {
    const { engine, controller, events } = make({ hold: true });
    await start(controller, { style: 0 });
    controller.handleCommand({ type: "go", command: "go depth 4", requestId: 3 });
    await tick();
    controller.handleCommand({ type: "stop" });
    await tick();

    expect(engine.received).toContain("stop");
    const best = lastBestmove(events);
    expect(best.move).toBe("e2e4");
    expect(best.requestId).toBe(3);
  });

  it("defers position and go until the stopped search reports its bestmove", async () => {
    const { engine, controller, events } = make({ hold: true });
    await start(controller, { style: 0 });
    controller.handleCommand({ type: "go", command: "go depth 4", requestId: 1 });
    await tick();
    controller.handleCommand({
      type: "position",
      command: "position startpos moves e2e4",
    });
    controller.handleCommand({ type: "go", command: "go depth 4", requestId: 2 });
    await tick();

    expect(engine.received.filter((line) => line === "stop")).toHaveLength(1);
    expect(engine.received).toContain("position startpos moves e2e4");
    expect(lastBestmove(events).requestId).toBe(1);

    controller.handleCommand({ type: "stop" });
    await tick();
    expect(lastBestmove(events).requestId).toBe(2);
  });
});

describe("session commands", () => {
  it("forwards positions and starts a new game", async () => {
    const { engine, controller } = make();
    await start(controller);
    controller.handleCommand({
      type: "position",
      command: "position startpos moves e2e4",
    });
    expect(engine.received).toContain("position startpos moves e2e4");
    controller.handleCommand({ type: "newgame" });
    expect(engine.received).toContain("ucinewgame");
  });

  it("quits immediately when no search is running", async () => {
    const { engine, controller, events } = make();
    await start(controller);
    controller.handleCommand({ type: "quit" });
    expect(engine.received).toContain("quit");
    expect(events.at(-1)).toEqual({ type: "quit" });
  });

  it("stops before quitting an active search", async () => {
    const { engine, controller, events } = make({ hold: true });
    await start(controller, { style: 0 });
    controller.handleCommand({ type: "go", command: "go depth 4" });
    await tick();
    controller.handleCommand({ type: "quit" });

    expect(engine.received).toContain("stop");
    expect(engine.received).not.toContain("quit");
    expect(events.some((event) => event.type === "quit")).toBe(false);

    await tick();
    expect(engine.received).toContain("quit");
    expect(events.at(-1)).toEqual({ type: "quit" });
  });
});

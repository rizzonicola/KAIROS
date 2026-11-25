import { dirname } from "node:path";
import { KairosController, type ControllerEvent, type EnginePort, type KairosOptions, type Rationale } from "../src/controller";
import type { WasmCore } from "../src/core-wasm";
import { loadCoreAuto } from "./node-core";
import { NodeEnginePort } from "./node-engine";

export interface Played {
  move: string;
  rationale: Rationale;
  sentCount: number;
}

/** KAIROS (Rust core + controller) driving a real Stockfish Lite under Node. */
export class KairosSession {
  private constructor(
    private readonly port: NodeEnginePort,
    readonly controller: KairosController,
    readonly core: WasmCore,
    readonly engine: { sent: string[] },
    readonly played: Played[],
    private readonly waiters: ((event: ControllerEvent) => void)[],
  ) {}

  static async start(enginePath: string, options: Partial<KairosOptions>, seed = 7): Promise<KairosSession> {
    const port = await NodeEnginePort.start(enginePath);
    const core = await loadCoreAuto(dirname(enginePath));
    const sent: string[] = [];
    const played: Played[] = [];
    const waiters: ((event: ControllerEvent) => void)[] = [];
    const recording: EnginePort = {
      send: (line) => {
        sent.push(line);
        port.send(line);
      },
    };
    const controller = new KairosController(
      recording,
      (event) => {
        if (event.type === "bestmove") {
          played.push({ move: event.move, rationale: event.rationale, sentCount: sent.length });
        }
        for (const waiter of waiters.splice(0)) {
          waiter(event);
        }
      },
      core,
      { defer: (fn) => void setImmediate(fn) },
    );
    port.onLine = (line) => controller.handleEngineLine(line);
    const session = new KairosSession(port, controller, core, { sent }, played, waiters);
    const ready = session.next((e) => e.type === "ready");
    controller.handleCommand({ type: "init", options, seed });
    await ready;
    return session;
  }

  bestmoves(): Played[] {
    return this.played;
  }

  next(predicate: (event: ControllerEvent) => boolean): Promise<ControllerEvent> {
    return new Promise((resolve) => {
      const listener = (event: ControllerEvent): void => {
        if (predicate(event)) {
          resolve(event);
        } else {
          this.waiters.push(listener);
        }
      };
      this.waiters.push(listener);
    });
  }

  async move(position: string, go: string): Promise<Played> {
    const done = this.next((e) => e.type === "bestmove" || e.type === "error");
    this.controller.handleCommand({ type: "position", command: position });
    this.controller.handleCommand({ type: "go", command: go, requestId: this.played.length + 1 });
    const event = await done;
    if (event.type === "error") {
      throw new Error(event.message);
    }
    return this.played[this.played.length - 1];
  }

  newGame(): void {
    this.controller.handleCommand({ type: "newgame" });
  }

  close(): void {
    this.controller.handleCommand({ type: "quit" });
    this.port.terminate();
  }
}

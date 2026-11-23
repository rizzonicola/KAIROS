import type { EnginePort } from "../src/controller";

export interface MockEngineOptions {
  /** Engine id reported during `uci`. */
  id?: string;
  /** Emit info lines but hold the bestmove until `stop`. */
  hold?: boolean;
}

/** Deterministic UCI fixture. Not a chess engine; tests controller logic only. */
export class MockEngine implements EnginePort {
  onLine: ((line: string) => void) | null = null;
  readonly received: string[] = [];

  private readonly id: string;
  private readonly hold: boolean;
  private readonly outbox: string[] = [];
  private scheduled = false;
  private searching = false;
  private position = "position startpos";

  constructor(options: MockEngineOptions = {}) {
    this.id = options.id ?? "Stockfish 19 Mock";
    this.hold = options.hold ?? false;
  }

  send(line: string): void {
    this.received.push(line);
    this.handle(line.trim());
  }

  private emit(line: string): void {
    this.outbox.push(line);
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const lines = this.outbox.splice(0);
      for (const line of lines) {
        this.onLine?.(line);
      }
    });
  }

  private handle(line: string): void {
    const [command] = line.split(/\s+/);
    if (command === "uci") {
      this.emit(`id name ${this.id}`);
      this.emit("option name Threads type spin default 1 min 1 max 1024");
      this.emit("option name Hash type spin default 16 min 1 max 33554432");
      this.emit("option name MultiPV type spin default 1 min 1 max 500");
      this.emit("option name UCI_ShowWDL type check default false");
      this.emit("uciok");
      return;
    }
    if (command === "isready") {
      this.emit("readyok");
      return;
    }
    if (command === "position") {
      this.position = line;
      return;
    }
    if (command === "go") {
      this.searching = true;
      if (this.hold) {
        return;
      }
      this.finish(line);
      return;
    }
    if (command === "stop") {
      if (this.searching) {
        this.searching = false;
        this.emit("bestmove e2e4");
      }
      return;
    }
    if (command === "quit") {
      this.searching = false;
    }
  }

  private finish(goLine: string): void {
    const tokens = goLine.split(/\s+/);
    const searchmoves = tokens.indexOf("searchmoves");
    if (searchmoves === -1) {
      this.emit("info depth 10 multipv 1 score cp 30 wdl 600 350 50 pv e2e4");
      this.emit("bestmove e2e4");
      this.searching = false;
      return;
    }
    const moves = tokens.slice(searchmoves + 1);
    this.emit(`info depth 10 multipv 1 score cp 30 wdl 600 350 50 pv ${moves[0]}`);
    if (moves[1]) {
      this.emit(`info depth 10 multipv 2 score cp 10 wdl 450 400 150 pv ${moves[1]}`);
    }
    this.emit(`bestmove ${moves[0]}`);
    this.searching = false;
  }
}

/** Let the mock's queued microtask output drain. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

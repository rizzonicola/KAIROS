import type { EnginePort } from "../src/controller";

export type MockScenario =
  | "normal"
  | "reject-verify"
  | "mate-main"
  | "no-wdl"
  | "depth-mismatch"
  | "saturated-main"
  | "saturated-verify"
  | "bound-main"
  | "probe-mate"
  | "verify-loss"
  | "winning-main";

/** Hold every search, or only the searches of one phase. */
export type MockHold = boolean | "main" | "probe" | "verify";

export interface MockEngineOptions {
  /** Engine id reported during `uci`. */
  id?: string;
  scenario?: MockScenario;
  hold?: MockHold;
}

const FIXTURE = "4k3/8/8/3p4/4P3/8/2P5/4K3";

/** Deterministic UCI fixture. Not a chess engine; tests controller logic only. */
export class MockEngine implements EnginePort {
  onLine: ((line: string) => void) | null = null;
  readonly received: string[] = [];

  private readonly id: string;
  private readonly scenario: MockScenario;
  private readonly hold: MockHold;
  private readonly outbox: string[] = [];
  private scheduled = false;
  private searching = false;
  private pendingBestmove: string | null = null;
  private showWdl = false;
  private multipv = 1;
  private position = "position startpos";

  constructor(options: MockEngineOptions = {}) {
    this.id = options.id ?? "Stockfish 19 Mock";
    this.scenario = options.scenario ?? "normal";
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

  private wdl(values: string): string {
    return this.showWdl && this.scenario !== "no-wdl" ? ` wdl ${values}` : "";
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
    if (command === "setoption") {
      this.handleSetoption(line);
      return;
    }
    if (command === "position") {
      this.position = line;
      return;
    }
    if (command === "go") {
      const phase = this.phaseOf(line);
      this.searching = true;
      if (this.shouldHold(phase)) {
        this.emitReport(line, phase);
        this.pendingBestmove = this.bestmoveFor(line, phase);
        return;
      }
      this.emitReport(line, phase);
      this.emit(this.bestmoveFor(line, phase));
      this.searching = false;
      return;
    }
    if (command === "stop") {
      if (this.searching) {
        this.searching = false;
        if (this.pendingBestmove) {
          this.emit(this.pendingBestmove);
          this.pendingBestmove = null;
        }
      }
      return;
    }
    if (command === "quit") {
      this.searching = false;
      this.pendingBestmove = null;
    }
  }

  private handleSetoption(line: string): void {
    const body = line.replace(/^setoption\s+name\s+/, "");
    const [name, value = ""] = body.split(/\s+value\s+/, 2);
    if (name === "MultiPV") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        this.multipv = parsed;
      }
    }
    if (name === "UCI_ShowWDL" && value === "true") {
      this.showWdl = true;
    }
  }

  private phaseOf(goLine: string): "main" | "probe" | "verify" {
    if (goLine.includes(" searchmoves ")) {
      return "verify";
    }
    const tokens = this.position.split(/\s+/);
    if (tokens[3] === "b" && (tokens[2] ?? "").includes("4k3/8/8/3p4")) {
      return "probe";
    }
    return "main";
  }

  private shouldHold(phase: "main" | "probe" | "verify"): boolean {
    return this.hold === true || this.hold === phase;
  }

  private emitReport(goLine: string, phase: "main" | "probe" | "verify"): void {
    if (phase === "verify") {
      this.emitVerify(goLine);
      return;
    }
    if (phase === "probe") {
      this.emitProbe();
      return;
    }
    this.emitMain();
  }

  private emitMain(): void {
    if (this.multipv > 1 && this.position.includes(FIXTURE)) {
      let baselineScore = 12;
      let baselineWdl = "500 300 200";
      let candidateScore = 11;
      let candidateWdl = "500 300 200";
      if (this.scenario === "winning-main") {
        baselineScore = 950;
        baselineWdl = "950 40 10";
        candidateScore = 950;
        candidateWdl = "950 40 10";
      } else if (this.scenario === "saturated-main") {
        baselineScore = 540;
        baselineWdl = "1000 0 0";
        candidateScore = 400;
        candidateWdl = "1000 0 0";
      }
      const bound = this.scenario === "bound-main" ? " upperbound" : "";
      this.emit(
        `info depth 4 seldepth 4 multipv 1 score cp ${baselineScore}${bound}` +
          `${this.wdl(baselineWdl)} pv e1d2 e8e7`,
      );
      if (this.scenario === "mate-main") {
        this.emit("info depth 4 seldepth 4 multipv 2 score mate 5 pv c2c4 e8e7");
      } else {
        const depth = this.scenario === "depth-mismatch" ? 3 : 4;
        this.emit(
          `info depth ${depth} seldepth ${depth} multipv 2 score cp ${candidateScore}` +
            `${this.wdl(candidateWdl)} pv c2c4 e8e7`,
        );
      }
      return;
    }
    if (this.multipv > 1) {
      this.emit(
        `info depth 4 seldepth 4 multipv 1 score cp 20${this.wdl("510 300 190")} pv e2e4 e7e5`,
      );
      this.emit(
        `info depth 4 seldepth 4 multipv 2 score cp 18${this.wdl("505 300 195")} pv d2d4 d7d5`,
      );
      return;
    }
    this.emit(
      `info depth 4 seldepth 4 score cp 20${this.wdl("510 300 190")} pv e2e4 e7e5`,
    );
  }

  private emitVerify(goLine: string): void {
    const tail = goLine.split("searchmoves")[1] ?? "";
    const moves = tail.trim().split(/\s+/).filter(Boolean);
    const depth = goLine.includes("depth") ? 6 : 4;
    moves.slice(0, 2).forEach((move, index) => {
      const rank = index + 1;
      let score = 19;
      let wdl = "500 300 200";
      if (this.scenario === "saturated-verify") {
        score = rank === 1 ? 540 : 400;
        wdl = "1000 0 0";
      } else if (this.scenario === "verify-loss" && rank === 2) {
        score = 490;
        wdl = "490 300 210";
      } else if (rank === 1) {
        score = 20;
      } else if (this.scenario === "reject-verify") {
        score = 19;
        wdl = "450 300 250";
      }
      this.emit(
        `info depth ${depth} seldepth ${depth} multipv ${rank} score cp ${score}` +
          `${this.wdl(wdl)} pv ${move} e8e7`,
      );
    });
  }

  private emitProbe(): void {
    const placement = this.position.split(/\s+/)[2] ?? "";
    if (this.scenario === "probe-mate" && placement.includes("2PK4")) {
      this.emit("info depth 3 seldepth 3 multipv 1 score mate 2 pv e8e7");
      return;
    }
    if (placement.includes("2PK4")) {
      this.emit(
        `info depth 3 seldepth 3 multipv 1 score cp 10${this.wdl("350 300 350")} pv e8e7`,
      );
      this.emit(
        `info depth 3 seldepth 3 multipv 2 score cp 9${this.wdl("340 300 360")} pv e8e8`,
      );
      this.emit(
        `info depth 3 seldepth 3 multipv 3 score cp 8${this.wdl("330 300 370")} pv e8d8`,
      );
      return;
    }
    if (placement.includes("2P1P3")) {
      this.emit(
        `info depth 3 seldepth 3 multipv 1 score cp 15${this.wdl("400 300 300")} pv e8e7`,
      );
      this.emit(
        `info depth 3 seldepth 3 multipv 2 score cp 5${this.wdl("250 300 450")} pv e8d8`,
      );
      this.emit(
        `info depth 3 seldepth 3 multipv 3 score cp 1${this.wdl("150 300 550")} pv e8f8`,
      );
      return;
    }
    this.emit(
      `info depth 3 seldepth 3 multipv 1 score cp 30${this.wdl("450 300 250")} pv e8e7`,
    );
  }

  private bestmoveFor(goLine: string, phase: "main" | "probe" | "verify"): string {
    if (phase === "verify") {
      const moves = (goLine.split("searchmoves")[1] ?? "").trim().split(/\s+/);
      return `bestmove ${moves[0] ?? "e1d2"}`;
    }
    if (phase === "probe") {
      return "bestmove e8e7";
    }
    if (this.multipv > 1 && this.position.includes(FIXTURE)) {
      return "bestmove e1d2";
    }
    return "bestmove e2e4";
  }
}

/** Let the mock's queued microtask output drain. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

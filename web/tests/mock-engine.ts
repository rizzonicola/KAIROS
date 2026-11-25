import type { EnginePort } from "../src/types";

export interface MockMove {
  move: string;
  cp: number;
  wdl: [number, number, number];
  pv?: string[];
  /** Report `score mate N` instead of centipawns. */
  mate?: number;
}

/** WDL (permille) giving the requested expected score: (W + D/2) / 1000. */
export function wdlFor(expected: number): [number, number, number] {
  const draws = 400;
  const wins = Math.round(expected * 1000 - draws / 2);
  return [wins, draws, 1000 - wins - draws];
}

export function mv(move: string, expected: number, cp = 0): MockMove {
  return { move, cp, wdl: wdlFor(expected) };
}

export type SearchKind = "baseline" | "judge" | "verify" | "probe";

export interface SearchContext {
  kind: SearchKind;
  depth: number;
  searchmoves: string[];
  multipv: number;
  position: string;
  goLine: string;
}

export interface MockEngineOptions {
  id?: string;
  /** True ordering of the root moves, best first. */
  root: MockMove[];
  /** The position command that belongs to `root` (anything else is treated as a probe). */
  rootPosition: string;
  /** Rewrite the lines of a search before they are reported. Return [] to report nothing. */
  lines?: (ctx: SearchContext, lines: MockMove[]) => MockMove[];
  /** Like `lines`, but applied per reported depth (to simulate partial iterations). */
  linesAtDepth?: (ctx: SearchContext, depth: number, lines: MockMove[]) => MockMove[];
  probeReplies?: (position: string) => MockMove[];
  /** Withhold `bestmove` until `stop` arrives. */
  hold?: (ctx: SearchContext) => boolean;
  noWdl?: boolean;
  bound?: boolean;
  depths?: Partial<Record<SearchKind, number>>;
  /** Moves a plain `go` (passthrough, MultiPV 1) returns; defaults to root[0]. */
  passthroughMove?: string;
}

const DEFAULT_DEPTHS: Record<SearchKind, number> = { baseline: 8, judge: 8, verify: 9, probe: 6 };

export class MockEngine implements EnginePort {
  sent: string[] = [];
  searches: SearchContext[] = [];
  private sink: ((line: string) => void) | null = null;
  private out: string[] = [];
  private pumping = false;
  private multipv = 1;
  private position = "position startpos";
  private held: { best: string } | null = null;

  constructor(readonly options: MockEngineOptions) {}

  connect(sink: (line: string) => void): void {
    this.sink = sink;
  }

  send(line: string): void {
    this.sent.push(line);
    this.handle(line);
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.sink === null) {
      return;
    }
    this.pumping = true;
    while (this.out.length > 0) {
      const next = this.out.shift();
      if (next !== undefined) {
        this.sink(next);
      }
    }
    this.pumping = false;
  }

  private emit(line: string): void {
    this.out.push(line);
  }

  private handle(line: string): void {
    const tokens = line.trim().split(/\s+/);
    switch (tokens[0]) {
      case "uci":
        this.emit(`id name ${this.options.id ?? "Stockfish 19"}`);
        this.emit("option name Threads type spin default 1 min 1 max 1024");
        this.emit("option name Hash type spin default 16 min 1 max 33554432");
        this.emit("option name MultiPV type spin default 1 min 1 max 256");
        this.emit("option name UCI_ShowWDL type check default false");
        this.emit("uciok");
        return;
      case "isready":
        this.emit("readyok");
        return;
      case "setoption": {
        const nameIndex = tokens.indexOf("name");
        const valueIndex = tokens.indexOf("value");
        if (nameIndex >= 0 && valueIndex > nameIndex) {
          const name = tokens.slice(nameIndex + 1, valueIndex).join(" ");
          if (name === "MultiPV") {
            this.multipv = Number(tokens[valueIndex + 1]);
          }
        }
        return;
      }
      case "position":
        this.position = line.trim();
        return;
      case "go":
        this.go(line.trim());
        return;
      case "stop":
        if (this.held) {
          const best = this.held.best;
          this.held = null;
          this.emit(`bestmove ${best}`);
        }
        return;
      default:
        return;
    }
  }

  private kindOf(goLine: string, searchmoves: string[]): SearchKind {
    if (this.position !== this.options.rootPosition) {
      return "probe";
    }
    if (searchmoves.length === 0) {
      return "baseline";
    }
    return searchmoves.length === 2 && this.multipv === 2 ? "verify" : "judge";
  }

  private go(goLine: string): void {
    const tokens = goLine.split(/\s+/);
    const smIndex = tokens.indexOf("searchmoves");
    const searchmoves = smIndex >= 0 ? tokens.slice(smIndex + 1) : [];
    const kind = this.kindOf(goLine, searchmoves);
    const depthIndex = tokens.indexOf("depth");
    const depth =
      depthIndex >= 0
        ? Number(tokens[depthIndex + 1])
        : (this.options.depths?.[kind] ?? DEFAULT_DEPTHS[kind]);
    const ctx: SearchContext = {
      kind,
      depth,
      searchmoves,
      multipv: this.multipv,
      position: this.position,
      goLine,
    };
    this.searches.push(ctx);

    let lines: MockMove[];
    if (kind === "probe") {
      lines = this.options.probeReplies
        ? this.options.probeReplies(this.position)
        : [mv("e7e5", 0.5), mv("d7d5", 0.46), mv("g8f6", 0.3)];
    } else {
      lines = this.options.root.filter(
        (item) => searchmoves.length === 0 || searchmoves.includes(item.move),
      );
      lines = [...lines].sort((a, b) => b.wdl[0] + b.wdl[1] / 2 - (a.wdl[0] + a.wdl[1] / 2));
    }
    if (this.options.lines) {
      lines = this.options.lines(ctx, lines);
    }
    lines = lines.slice(0, Math.max(1, this.multipv));

    for (const d of [Math.max(1, depth - 1), depth]) {
      const shown = this.options.linesAtDepth ? this.options.linesAtDepth(ctx, d, lines) : lines;
      shown.forEach((line, index) => this.emit(this.infoLine(d, index + 1, line)));
    }
    const isPlain = searchmoves.length === 0 && this.multipv === 1 && kind === "baseline";
    const best =
      isPlain && this.options.passthroughMove !== undefined
        ? this.options.passthroughMove
        : lines.length > 0
          ? lines[0].move
          : "(none)";
    if (this.options.hold && this.options.hold(ctx)) {
      this.held = { best };
      return;
    }
    this.emit(`bestmove ${best}`);
  }

  private infoLine(depth: number, multipv: number, line: MockMove): string {
    const parts = [`info depth ${depth} seldepth ${depth} multipv ${multipv}`];
    if (line.mate !== undefined) {
      parts.push(`score mate ${line.mate}`);
    } else {
      parts.push(`score cp ${line.cp}`);
    }
    if (this.options.bound && multipv === 1) {
      parts.push("lowerbound");
    }
    if (!this.options.noWdl) {
      const wdl = line.mate !== undefined ? ([1000, 0, 0] as const) : line.wdl;
      parts.push(`wdl ${wdl[0]} ${wdl[1]} ${wdl[2]}`);
    }
    parts.push("nodes 12345 nps 123456 time 100");
    parts.push(`pv ${(line.pv ?? [line.move, "e7e5", "g1f3"]).join(" ")}`);
    return parts.join(" ");
  }
}

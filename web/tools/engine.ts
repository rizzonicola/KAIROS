import { parseInfo, expectedScore, type Candidate } from "../src/uci";
import { NodeEnginePort } from "./node-engine";

/** A plain Stockfish Lite process with a small promise API (match opponent and analysis engine). */
export class PlainEngine {
  private handler: ((line: string) => void) | null = null;

  private constructor(private readonly port: NodeEnginePort) {
    port.onLine = (line) => this.handler?.(line);
  }

  static async start(enginePath: string, hashMb = 16): Promise<PlainEngine> {
    const engine = new PlainEngine(await NodeEnginePort.start(enginePath));
    await engine.run(["uci"], /^uciok/);
    await engine.run(
      [
        "setoption name Threads value 1",
        `setoption name Hash value ${hashMb}`,
        "setoption name UCI_ShowWDL value true",
        "isready",
      ],
      /^readyok/,
    );
    return engine;
  }

  /** Send lines and collect everything up to and including the first line matching `until`. */
  run(commands: string[], until: RegExp): Promise<string[]> {
    return new Promise((resolve) => {
      const lines: string[] = [];
      this.handler = (line) => {
        lines.push(line);
        if (until.test(line)) {
          this.handler = null;
          resolve(lines);
        }
      };
      for (const command of commands) {
        this.port.send(command);
      }
    });
  }

  async search(position: string, go: string, multipv = 1): Promise<{ best: string; infos: Candidate[] }> {
    const lines = await this.run(
      [`setoption name MultiPV value ${multipv}`, position, go],
      /^bestmove/,
    );
    const best = (lines[lines.length - 1].split(/\s+/)[1] ?? "").trim();
    const infos = lines.map((line) => parseInfo(line)).filter((c): c is Candidate => c !== null);
    return { best, infos };
  }

  async best(position: string, go: string): Promise<string> {
    return (await this.search(position, go)).best;
  }

  /** Centipawn score (side to move) of each move at one depth; mate scores map to +-100000. */
  async scoreMoves(position: string, moves: string[], depth: number): Promise<Map<string, number>> {
    const { infos } = await this.search(position, `go depth ${depth} searchmoves ${moves.join(" ")}`, moves.length);
    const result = new Map<string, number>();
    const deepest = Math.max(0, ...infos.map((c) => c.depth));
    for (const c of infos.filter((x) => x.depth === deepest)) {
      const cp = c.scoreKind === "cp" ? c.scoreValue : Math.sign(c.scoreValue) * (100000 - Math.abs(c.scoreValue));
      result.set(c.move, cp);
    }
    return result;
  }

  /** Probe-style replies (expected scores of the three best replies) at a depth. */
  async replies(position: string, depth: number): Promise<number[]> {
    const { infos } = await this.search(position, `go depth ${depth}`, 3);
    const deepest = Math.max(0, ...infos.map((c) => c.depth));
    return infos
      .filter((c) => c.depth === deepest)
      .map((c) => expectedScore(c))
      .sort((a, b) => b - a);
  }

  close(): void {
    this.port.terminate();
  }
}

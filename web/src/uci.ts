/** UCI line parsing and search-limit helpers (logic carried over from v0.2.1). */

export type ScoreKind = "cp" | "mate";

export interface Candidate {
  multipv: number;
  depth: number;
  move: string;
  scoreKind: ScoreKind;
  scoreValue: number;
  wdl: [number, number, number];
  pv: string[];
}

/** Expected score from WDL: (W + D/2) / 1000. */
export function expectedScore(candidate: Candidate): number {
  const [wins, draws] = candidate.wdl;
  return (wins + draws / 2.0) / 1000.0;
}

export function parseIntToken(raw: string | undefined): number | null {
  if (raw === undefined || !/^[+-]?\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

export function parseInfo(line: string): Candidate | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] !== "info") {
    return null;
  }
  const values: {
    multipv?: number;
    depth?: number;
    scoreKind?: string;
    scoreValue?: number;
    wdl?: [number, number, number];
    pv?: string[];
  } = {};
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (
      ["depth", "seldepth", "multipv", "nodes", "nps", "hashfull", "tbhits", "time"].includes(token)
    ) {
      if (i + 1 < tokens.length) {
        const value = parseIntToken(tokens[i + 1]);
        if (value !== null) {
          if (token === "multipv") {
            values.multipv = value;
          } else if (token === "depth") {
            values.depth = value;
          }
        }
      }
      i += 2;
      continue;
    }
    if (token === "score" && i + 2 < tokens.length) {
      // Bound scores are not exact evaluations; never rerank on them.
      if (i + 3 < tokens.length && (tokens[i + 3] === "lowerbound" || tokens[i + 3] === "upperbound")) {
        return null;
      }
      values.scoreKind = tokens[i + 1];
      const value = parseIntToken(tokens[i + 2]);
      if (value !== null) {
        values.scoreValue = value;
      }
      i += 3;
      continue;
    }
    if (token === "wdl" && i + 3 < tokens.length) {
      const wdl = tokens.slice(i + 1, i + 4).map((value) => parseIntToken(value));
      if (wdl.every((value): value is number => value !== null)) {
        values.wdl = [wdl[0], wdl[1], wdl[2]];
      }
      i += 4;
      continue;
    }
    if (token === "pv") {
      values.pv = tokens.slice(i + 1);
      break;
    }
    i += 1;
  }

  const pv = values.pv;
  const wdl = values.wdl;
  if (!pv || pv.length === 0 || !wdl) {
    return null;
  }
  if (wdl.length !== 3 || wdl[0] + wdl[1] + wdl[2] <= 0) {
    return null;
  }
  if (values.depth === undefined || values.scoreKind === undefined || values.scoreValue === undefined) {
    return null;
  }
  return {
    multipv: values.multipv ?? 1,
    depth: values.depth,
    move: pv[0],
    scoreKind: values.scoreKind as ScoreKind,
    scoreValue: values.scoreValue,
    wdl,
    pv,
  };
}

export interface EngineInfo {
  depth: number;
  multipv: number;
  score: string;
  wdl?: [number, number, number];
}

/** Lenient parse used only for the UI's thinking line. */
export function engineInfoFromLine(line: string): EngineInfo | null {
  const tokens = line.trim().split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let score: string | null = null;
  let wdl: [number, number, number] | undefined;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "depth" && /^\d+$/.test(tokens[index + 1] ?? "")) {
      depth = Number(tokens[index + 1]);
      index += 1;
    } else if (token === "multipv" && /^\d+$/.test(tokens[index + 1] ?? "")) {
      multipv = Number(tokens[index + 1]);
      index += 1;
    } else if (token === "score" && index + 2 < tokens.length) {
      score = `${tokens[index + 1]} ${tokens[index + 2]}`;
      index += 2;
    } else if (token === "wdl" && index + 3 < tokens.length) {
      const values = tokens.slice(index + 1, index + 4).map(Number);
      if (values.every((value) => Number.isFinite(value))) {
        wdl = [values[0], values[1], values[2]];
      }
      index += 3;
    }
  }
  if (score === null) {
    return null;
  }
  return { depth, multipv, score, wdl };
}

export interface SupportedSearch {
  supported: boolean;
  kind: "depth" | "movetime" | "";
  amount: number;
  reason: string;
}

/** Minimum think time for personality searches (milliseconds). */
export const MIN_PERSONALITY_MOVETIME = 1500;

/**
 * Only rerank searches with a bounded verification budget. Clock-based
 * controls, ponder, infinite, node and perft searches stay exact Stockfish
 * passthroughs.
 */
export function supportedPersonalitySearch(goLine: string): SupportedSearch {
  const tokens = goLine.trim().split(/\s+/).slice(1);
  const unsupported = (reason: string, amount = 0): SupportedSearch => ({
    supported: false,
    kind: "",
    amount,
    reason,
  });
  if (
    tokens.length === 0 ||
    ["infinite", "ponder", "perft", "nodes", "mate", "wtime", "btime", "winc", "binc", "movestogo"].some(
      (token) => tokens.includes(token),
    )
  ) {
    return unsupported("unsupported-or-clock-search");
  }
  if (tokens.filter((token) => token === "depth" || token === "movetime").length !== 1) {
    return unsupported("multiple-or-missing-limits");
  }
  if (tokens.includes("depth")) {
    const depth = parseIntToken(tokens[tokens.indexOf("depth") + 1]);
    if (depth === null || depth < 1) {
      return unsupported("invalid-depth");
    }
    return { supported: true, kind: "depth", amount: depth, reason: "supported" };
  }
  const movetime = parseIntToken(tokens[tokens.indexOf("movetime") + 1]);
  if (movetime === null) {
    return unsupported("invalid-movetime");
  }
  if (movetime < MIN_PERSONALITY_MOVETIME) {
    return unsupported("time-too-low", movetime);
  }
  return { supported: true, kind: "movetime", amount: movetime, reason: "supported" };
}

export function parseBestmove(line: string): { move: string; ponder?: string } {
  const tokens = line.trim().split(/\s+/);
  const move = tokens[1] ?? "";
  const ponderIndex = tokens.indexOf("ponder");
  const ponder =
    ponderIndex > 0 && ponderIndex + 1 < tokens.length ? tokens[ponderIndex + 1] : undefined;
  return { move, ponder };
}

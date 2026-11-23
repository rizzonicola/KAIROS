import type { Board } from "./chess-features";

export const SATURATION_EXPECTED = 0.99;
export const HALFMOVE_ALERT = 90;

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

/** Expected score from WDL, as the Python oracle computes it. */
export function expectedScore(candidate: Candidate): number {
  const [wins, draws] = candidate.wdl;
  return (wins + draws / 2.0) / 1000.0;
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
    if (["depth", "seldepth", "multipv", "nodes", "nps", "hashfull", "tbhits", "time"].includes(token)) {
      if (i + 1 < tokens.length) {
        const value = Number(tokens[i + 1]);
        if (Number.isFinite(value)) {
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
      const value = Number(tokens[i + 2]);
      if (Number.isFinite(value)) {
        values.scoreValue = value;
      }
      i += 3;
      continue;
    }
    if (token === "wdl" && i + 3 < tokens.length) {
      const wdl = tokens.slice(i + 1, i + 4).map(Number);
      if (wdl.every((value) => Number.isFinite(value))) {
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

/** Conservative prototype bands; thresholds are documented, not SF-defined. */
export function resultBand(expected: number): number {
  if (expected >= 0.55) {
    return 1;
  }
  if (expected <= 0.45) {
    return -1;
  }
  return 0;
}

export function isSaturated(expected: number): boolean {
  return expected >= SATURATION_EXPECTED || expected <= 1.0 - SATURATION_EXPECTED;
}

export interface SupportedSearch {
  supported: boolean;
  kind: "depth" | "movetime" | "";
  amount: number;
  reason: string;
}

function parseIntToken(raw: string | undefined): number | null {
  if (raw === undefined || !/^-?\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

/**
 * Only rerank searches with a bounded verification budget.
 *
 * Clock-based controls, ponder, infinite, node and perft searches stay exact
 * Stockfish passthroughs in this prototype.
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
  if (movetime < 1500) {
    return unsupported("time-too-low", movetime);
  }
  return { supported: true, kind: "movetime", amount: movetime, reason: "supported" };
}

/** Avoid a move that would create a third occurrence while better than a draw. */
export function repetitionBlocked(
  board: Board,
  move: string,
  counts: Map<string, number> | Record<string, number>,
  baselineExpected: number,
): boolean {
  if (baselineExpected <= 0.5) {
    return false;
  }
  let key: string;
  try {
    key = board.applyUci(move).positionKey();
  } catch {
    return false;
  }
  const count = counts instanceof Map ? (counts.get(key) ?? 0) : (counts[key] ?? 0);
  return count >= 2;
}

/** Avoid a non-resetting move near the 50-move draw while better than a draw. */
export function fiftyMoveBlocked(
  board: Board,
  move: string,
  baselineExpected: number,
): boolean {
  if (board.halfmove < HALFMOVE_ALERT || baselineExpected <= 0.5) {
    return false;
  }
  try {
    return !board.resetsHalfmove(move);
  } catch {
    return false;
  }
}

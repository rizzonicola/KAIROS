/** Strength guards (spec 11.5 and section 6 invariants). Pure functions. */

export const SATURATION_EXPECTED = 0.99;
export const SATURATION_CP_MARGIN = 50;
export const HALFMOVE_ALERT = 90;
export const DISTILL_SKIP_EXPECTED = 0.9;
export const BUDGET_WINDOW = 10;
export const BUDGET_MULTIPLIER = 2.5;

/** Expected-score budget per posture, in percent of expected score (spec 6). */
export const POSTURE_BUDGET_PCT: Record<string, number> = {
  Coil: 1.5,
  Strike: 3.0,
  Absorb: 1.0,
  Reverse: 2.0,
  Distill: 0.5,
  Fog: 4.0,
};

/** Conservative prototype bands; thresholds are documented, not Stockfish-defined. */
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

/** Single-move budget in percentage points: posture budget x style / 100. */
export function singleBudgetPct(posture: string, style: number): number {
  const base = POSTURE_BUDGET_PCT[posture] ?? POSTURE_BUDGET_PCT.Coil;
  return (base * Math.max(0, Math.min(100, style))) / 100.0;
}

/** Effective budget after the rolling 10-move cap (2.5x the single-move budget). */
export function effectiveBudgetPct(single: number, spentHistory: number[]): number {
  const spent = spentHistory.slice(-BUDGET_WINDOW).reduce((sum, value) => sum + value, 0);
  return Math.min(single, Math.max(0, BUDGET_MULTIPLIER * single - spent));
}

/** Avoid a move that would create a third occurrence while better than a draw. */
export function repetitionBlocked(priorOccurrences: number, baselineExpected: number): boolean {
  if (baselineExpected <= 0.5) {
    return false;
  }
  return priorOccurrences >= 2;
}

/** Avoid a non-resetting move near the 50-move draw while better than a draw. */
export function fiftyMoveBlocked(
  halfmoveClock: number,
  resetsHalfmove: boolean,
  baselineExpected: number,
): boolean {
  if (halfmoveClock < HALFMOVE_ALERT || baselineExpected <= 0.5) {
    return false;
  }
  return !resetsHalfmove;
}

export interface LossCheck {
  accepted: boolean;
  reason: string;
  lossPct: number;
}

export interface Measured {
  expected: number;
  scoreKind: "cp" | "mate";
  scoreValue: number;
}

/**
 * The single place that decides whether a measured candidate may replace
 * Stockfish's best: loss within budget, no result-band downgrade, saturation
 * margin. Used by both the judge corridor and the final verification so the
 * two cannot drift apart.
 */
export function corridorCheck(anchor: Measured, candidate: Measured, budgetPct: number): LossCheck {
  if (anchor.scoreKind === "mate" || candidate.scoreKind === "mate") {
    return { accepted: false, reason: "mate-guard", lossPct: Number.POSITIVE_INFINITY };
  }
  const lossPct = Math.max(0, (anchor.expected - candidate.expected) * 100);
  if (lossPct > budgetPct + 1e-9) {
    return { accepted: false, reason: "outside-corridor", lossPct };
  }
  if (resultBand(candidate.expected) < resultBand(anchor.expected)) {
    return { accepted: false, reason: "result-band", lossPct };
  }
  if (isSaturated(anchor.expected)) {
    if (candidate.scoreValue < anchor.scoreValue - SATURATION_CP_MARGIN) {
      return { accepted: false, reason: "saturated-score-margin", lossPct };
    }
  }
  return { accepted: true, reason: "ok", lossPct };
}

/**
 * Corridor eligibility, probe features and personality scoring (pure).
 *
 * Score(m) = -lambda * Loss(m) + sum_k w_k(posture) * F_k(m)
 * with lambda = 1 per percentage point of expected score and one weight unit
 * worth 0.1 percentage points before the style/independence scale.
 */

import type { Features } from "./core";
import { corridorCheck, fiftyMoveBlocked, repetitionBlocked } from "./guards";
import { weightedFeatures, type Mix } from "./postures";
import { expectedScore, type Candidate } from "./uci";

export const WEIGHT_UNIT_PCT = 0.1;

export interface ProbeRecord {
  best: number;
  second: number | null;
  replies: number[];
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Measured narrowness and prophylaxis; neutral when a probe is missing. */
export function probeFeatures(
  record: ProbeRecord | undefined,
  nullThreat: number | null,
): Partial<Features> {
  if (!record || record.replies.length === 0) {
    return {};
  }
  const best = record.best;
  const near = record.replies.filter((value) => value >= best - 0.05).length / record.replies.length;
  const second = record.second;
  const bonus = second !== null && best - second > 0.1 ? 0.5 : 0.0;
  const narrowness = clamp(1.0 - near + bonus, -1.0, 1.0);
  let prophylaxis = 0.0;
  if (nullThreat !== null) {
    prophylaxis = clamp((nullThreat - best) / 0.2, -1.0, 1.0);
  }
  return { F_N: narrowness, F_P: prophylaxis };
}

export const ZERO_FEATURES: Features = {
  T: 0,
  F_T: 0,
  F_N: 0,
  F_R: 0,
  F_C: 0,
  F_F: 0,
  F_P: 0,
  F_K: 0,
  F_S: 0,
  F_I: 0,
};

export interface Eligible {
  move: string;
  candidate: Candidate;
  lossPct: number;
}

export interface GuardProbe {
  repetitionCount(move: string): number;
  resetsHalfmove(move: string): boolean;
  halfmoveClock(): number;
}

/**
 * Apply the Soundness Corridor to judged candidates. The anchor (Stockfish's
 * baseline best, measured in the same judge search) is always eligible.
 */
export function eligibleFromJudge(
  anchor: Candidate,
  judged: Candidate[],
  budgetPct: number,
  guards: GuardProbe,
): Eligible[] {
  const anchorExpected = expectedScore(anchor);
  const out: Eligible[] = [{ move: anchor.move, candidate: anchor, lossPct: 0 }];
  if (budgetPct <= 0) {
    return out;
  }
  for (const candidate of judged) {
    if (candidate.move === anchor.move) {
      continue;
    }
    const check = corridorCheck(
      { expected: anchorExpected, scoreKind: anchor.scoreKind, scoreValue: anchor.scoreValue },
      {
        expected: expectedScore(candidate),
        scoreKind: candidate.scoreKind,
        scoreValue: candidate.scoreValue,
      },
      budgetPct,
    );
    if (!check.accepted) {
      continue;
    }
    if (repetitionBlocked(guards.repetitionCount(candidate.move), anchorExpected)) {
      continue;
    }
    if (
      fiftyMoveBlocked(guards.halfmoveClock(), guards.resetsHalfmove(candidate.move), anchorExpected)
    ) {
      continue;
    }
    out.push({ move: candidate.move, candidate, lossPct: check.lossPct });
  }
  return out;
}

export interface Scored extends Eligible {
  score: number;
  features: Features;
  proposed: boolean;
}

export interface ScoreInputs {
  mix: Mix;
  /** style/100 * (1 + independence/100) */
  personalityScale: number;
  featuresFor(move: string): Features;
  probes: Map<string, ProbeRecord>;
  nullThreat: number | null;
  proposed: Set<string>;
}

export function scoreEligible(items: Eligible[], inputs: ScoreInputs): Scored[] {
  const scored = items.map((item) => {
    const features: Features = {
      ...inputs.featuresFor(item.move),
      ...probeFeatures(inputs.probes.get(item.move), inputs.nullThreat),
    };
    const personalityPct =
      inputs.personalityScale * WEIGHT_UNIT_PCT * weightedFeatures(inputs.mix, features);
    return {
      ...item,
      score: -item.lossPct + personalityPct,
      features,
      proposed: inputs.proposed.has(item.move),
    };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      expectedScore(b.candidate) - expectedScore(a.candidate) ||
      a.candidate.multipv - b.candidate.multipv,
  );
  return scored;
}

/** 1-based rank of a move among judged candidates by expected score. */
export function judgedRank(move: string, judged: Candidate[]): number {
  const target = judged.find((candidate) => candidate.move === move);
  if (!target) {
    return judged.length + 1;
  }
  const better = judged.filter(
    (candidate) => expectedScore(candidate) > expectedScore(target) + 1e-12,
  ).length;
  return better + 1;
}

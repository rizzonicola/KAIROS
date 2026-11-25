/**
 * Postures, weights, inference and hysteresis for KAIROS.
 *
 * The weight table follows KAIROS_SPECIFICATION.md section 11.4. One weight
 * unit is worth roughly 0.1% of expected score after the caller applies the
 * style scale; the loss term always remains dominant.
 */

import type { Features, PositionStats } from "./core";

export const POSTURES = ["Coil", "Strike", "Absorb", "Reverse", "Distill", "Fog"] as const;
export type Posture = (typeof POSTURES)[number];

export const FEATURES = ["F_T", "F_N", "F_R", "F_C", "F_F", "F_P", "F_K", "F_S", "F_I"] as const;
export type FeatureName = (typeof FEATURES)[number];

export type Mix = Record<Posture, number>;

export const WEIGHTS: Record<Posture, Record<FeatureName, number>> = {
  Coil: { F_T: 2, F_N: 2, F_R: 2, F_C: 1, F_F: 2, F_P: 1, F_K: 1, F_S: -1, F_I: 1 },
  Strike: { F_T: 1, F_N: 1, F_R: 0, F_C: 3, F_F: 0, F_P: 0, F_K: 0, F_S: -1, F_I: 3 },
  Absorb: { F_T: 1, F_N: 1, F_R: 1, F_C: 0, F_F: 2, F_P: 3, F_K: 3, F_S: 1, F_I: 0 },
  Reverse: { F_T: 1, F_N: 1, F_R: 1, F_C: 2, F_F: 1, F_P: 1, F_K: 1, F_S: -1, F_I: 2 },
  Distill: { F_T: -2, F_N: 0, F_R: 0, F_C: 0, F_F: 1, F_P: 3, F_K: 2, F_S: 3, F_I: 0 },
  Fog: { F_T: 2, F_N: 3, F_R: 1, F_C: 1, F_F: 1, F_P: 0, F_K: 0, F_S: -3, F_I: 1 },
};

export const INERTIA_MARGIN = 0.15;
export const INERTIA_STREAK = 2;
export const SOFTMAX_TEMPERATURE = 0.20;
export const DISTILL_ENTER = 0.80;
export const DISTILL_EXIT = 0.65;

const PLAN_TOKENS: Record<Posture, string> = {
  Coil: "hold-tension",
  Strike: "press-king",
  Absorb: "absorb-threat",
  Reverse: "reverse-tension",
  Distill: "convert",
  Fog: "complicate",
};

export function planToken(posture: string): string {
  return PLAN_TOKENS[posture as Posture] ?? "hold-tension";
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function oneHot(posture: Posture): Mix {
  return Object.fromEntries(
    POSTURES.map((name) => [name, name === posture ? 1.0 : 0.0]),
  ) as Mix;
}

export function normalize(mix: Partial<Mix>): Mix {
  const clean = {} as Mix;
  for (const name of POSTURES) {
    clean[name] = Math.max(0.0, mix[name] ?? 0.0);
  }
  const total = POSTURES.reduce((sum, name) => sum + clean[name], 0);
  if (total <= 0) {
    return oneHot("Coil");
  }
  const result = {} as Mix;
  for (const name of POSTURES) {
    result[name] = clean[name] / total;
  }
  return result;
}

export function dominant(mix: Partial<Mix>): Posture {
  let best: Posture = POSTURES[0];
  for (const name of POSTURES) {
    if ((mix[name] ?? 0.0) > (mix[best] ?? 0.0)) {
      best = name;
    }
  }
  return best;
}

export function weightedFeatures(mix: Partial<Mix>, features: Partial<Features>): number {
  let total = 0;
  for (const posture of POSTURES) {
    for (const feature of FEATURES) {
      total +=
        WEIGHTS[posture][feature] * (mix[posture] ?? 0.0) * (features[feature] ?? 0.0);
    }
  }
  return total;
}

export function softmax(
  scores: Partial<Mix>,
  temperature: number = SOFTMAX_TEMPERATURE,
): Mix {
  if (temperature <= 0) {
    return oneHot(dominant(scores));
  }
  const values = POSTURES.map((name) => scores[name] ?? 0.0);
  const peak = Math.max(...values);
  const weights = values.map((value) => Math.exp((value - peak) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const result = {} as Mix;
  POSTURES.forEach((name, index) => {
    result[name] = weights[index] / total;
  });
  return result;
}

/** Sample an index from a softmax over scores. tau <= 0 is argmax. */
export function sampleIndex(scores: number[], tau: number, rng: () => number): number {
  if (scores.length === 0) {
    return -1;
  }
  if (tau <= 0) {
    let best = 0;
    for (let index = 1; index < scores.length; index++) {
      if (scores[index] > scores[best]) {
        best = index;
      }
    }
    return best;
  }
  const peak = Math.max(...scores);
  const weights = scores.map((score) => Math.exp((score - peak) / tau));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const threshold = rng() * total;
  let upto = 0.0;
  for (let index = 0; index < weights.length; index++) {
    upto += weights[index];
    if (threshold <= upto) {
      return index;
    }
  }
  return scores.length - 1;
}

export interface Evidence {
  expected: number;
  trend: number;
  tension: number;
  ownKingPressure: number;
  enemyKingPressure: number;
  forcingDensity: number;
  phase: number;
  opponentFragility: number;
  materialBalance: number;
}

/** Normalized expected-score change versus the previous own moves. */
export function scoreTrend(history: number[], current: number): number {
  const previous = history.slice(-3);
  if (previous.length === 0) {
    return 0.0;
  }
  const mean = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  return clamp((current - mean) / 0.10, -1.0, 1.0);
}

/** Build inference evidence from static stats, own history and PV forcing. */
export function evidenceFromStats(
  stats: Partial<PositionStats>,
  expected: number,
  history: number[],
  forcingDensity: number,
  opponentFragility = 0.0,
): Evidence {
  return {
    expected,
    trend: scoreTrend(history, expected),
    tension: clamp((stats.tension ?? 0.0) / 4.0, 0.0, 1.0),
    ownKingPressure: clamp((stats.ownKingAttackers ?? 0.0) / 3.0, 0.0, 1.0),
    enemyKingPressure: clamp((stats.enemyKingAttackers ?? 0.0) / 3.0, 0.0, 1.0),
    forcingDensity: clamp(forcingDensity, 0.0, 1.0),
    phase: clamp(stats.phase ?? 0.0, 0.0, 1.0),
    opponentFragility: clamp(opponentFragility, -1.0, 1.0),
    materialBalance: stats.materialBalance ?? 0.0,
  };
}

export const FRAGILITY_CLASSES = [
  "sharp-tactical",
  "quiet-maneuvering",
  "defending",
  "endgame",
] as const;
export type FragilityClass = (typeof FRAGILITY_CLASSES)[number];
export const FRAGILITY_ALPHA = 0.3;
export const MAX_VARIETY_TAU = 0.10;

/** Deterministic class used to keep separate opponent-accuracy averages. */
export function positionClass(
  stats: Partial<PositionStats>,
  expected: number,
  forcingDensity = 0.0,
): FragilityClass {
  if ((stats.phase ?? 0.0) < 0.25) {
    return "endgame";
  }
  if ((stats.tension ?? 0.0) >= 3.0 || forcingDensity >= 0.5) {
    return "sharp-tactical";
  }
  if (expected < 0.45 || (stats.ownKingAttackers ?? 0.0) >= 2.0) {
    return "defending";
  }
  return "quiet-maneuvering";
}

/** EWMA of the opponent's expected-score loss in one position class. */
export function updateFragility(
  previous: number,
  loss: number,
  alpha: number = FRAGILITY_ALPHA,
): number {
  return clamp((1.0 - alpha) * previous + alpha * clamp(loss, -1.0, 1.0), -1.0, 1.0);
}

/** Softmax temperature for anti-rigidity; zero keeps the argmax. */
export function varietyTemperature(variety: number, posture: string, forced: boolean): number {
  if (forced || variety <= 0 || posture === "Strike" || posture === "Distill") {
    return 0.0;
  }
  return (MAX_VARIETY_TAU * clamp(variety, 0, 100)) / 100.0;
}

/** Turn observable evidence into a soft posture mix. */
export function inferMix(
  evidence: Evidence,
  temperature: number = SOFTMAX_TEMPERATURE,
): Mix {
  const expected = clamp(evidence.expected, 0.0, 1.0);
  const trend = clamp(evidence.trend, -1.0, 1.0);
  const tension = clamp(evidence.tension, 0.0, 1.0);
  const ownPressure = clamp(evidence.ownKingPressure, 0.0, 1.0);
  const enemyPressure = clamp(evidence.enemyKingPressure, 0.0, 1.0);
  const forcing = clamp(evidence.forcingDensity, 0.0, 1.0);
  const phase = clamp(evidence.phase, 0.0, 1.0);
  const fragility = clamp(evidence.opponentFragility, -1.0, 1.0);
  const material = clamp(evidence.materialBalance / 9.0, -1.0, 1.0);
  const midgameBalance = 1.0 - Math.abs(expected - 0.5) * 2.0;
  const fragile = Math.max(0.0, fragility);
  const precise = Math.max(0.0, -fragility);

  const scores: Mix = {
    Coil:
      0.20 +
      0.35 * tension +
      0.20 * (1.0 - Math.abs(trend)) +
      0.15 * midgameBalance +
      0.10 * fragile,
    Strike:
      0.10 +
      0.45 * enemyPressure +
      0.25 * Math.max(trend, 0.0) +
      0.20 * forcing -
      0.20 * precise,
    Absorb:
      0.10 +
      0.55 * ownPressure +
      0.20 * Math.max(-trend, 0.0) +
      0.15 * (1.0 - phase),
    Reverse:
      0.05 +
      0.30 * ownPressure +
      0.25 * Math.max(-trend, 0.0) +
      0.20 * tension +
      0.20 * fragile,
    Distill:
      0.05 +
      0.55 * clamp((expected - 0.65) / 0.35, 0.0, 1.0) +
      0.25 * (1.0 - tension) +
      0.15 * (1.0 - phase) +
      0.10 * Math.max(material, 0.0),
    Fog:
      0.05 +
      0.75 * clamp((0.35 - expected) / 0.35, 0.0, 1.0) +
      0.20 * (1.0 - tension) +
      0.15 * fragile -
      0.20 * precise,
  };
  const floored = {} as Mix;
  for (const name of POSTURES) {
    floored[name] = Math.max(0.01, scores[name]);
  }
  return softmax(floored, temperature);
}

/**
 * Hysteresis around the inferred mix.
 *
 * The current mix is sticky while the dominant posture is unchanged. A new
 * dominant posture needs two consecutive moves with a margin of 0.15, unless
 * a strong Strike/Absorb evidence triggers an immediate override. Distill
 * locks in above 0.80 expected score and exits below 0.65.
 */
export class PostureController {
  mix: Mix = oneHot("Coil");
  private pending: Posture | null = null;
  private pendingCount = 0;
  private distillLock = false;

  reset(): void {
    this.mix = oneHot("Coil");
    this.pending = null;
    this.pendingCount = 0;
    this.distillLock = false;
  }

  update(
    inferredMix: Partial<Mix>,
    evidence: Evidence,
    forced: Posture | null = null,
  ): Mix {
    const inferred = normalize(inferredMix);
    if (forced) {
      this.mix = oneHot(forced);
      this.pending = null;
      this.pendingCount = 0;
      this.distillLock = false;
      return this.mix;
    }

    const current = dominant(this.mix);
    const newPosture = dominant(inferred);

    if (current === "Distill" && evidence.expected >= DISTILL_ENTER) {
      this.distillLock = true;
    }
    if (this.distillLock && current === "Distill") {
      if (evidence.expected >= DISTILL_EXIT) {
        return this.mix;
      }
      this.distillLock = false;
    }

    if (newPosture === current) {
      this.pending = null;
      this.pendingCount = 0;
      return this.mix;
    }

    const immediate =
      (newPosture === "Strike" &&
        inferred.Strike >= 0.75 &&
        evidence.enemyKingPressure >= 0.6) ||
      (newPosture === "Absorb" &&
        inferred.Absorb >= 0.75 &&
        evidence.ownKingPressure >= 0.6);
    if (immediate) {
      this.mix = inferred;
      this.pending = null;
      this.pendingCount = 0;
      return this.mix;
    }

    if (inferred[newPosture] - inferred[current] >= INERTIA_MARGIN) {
      if (this.pending === newPosture) {
        this.pendingCount += 1;
      } else {
        this.pending = newPosture;
        this.pendingCount = 1;
      }
      if (this.pendingCount >= INERTIA_STREAK) {
        this.mix = inferred;
        this.pending = null;
        this.pendingCount = 0;
      }
    } else {
      this.pending = null;
      this.pendingCount = 0;
    }
    return this.mix;
  }
}

/**
 * Small seeded PRNG for variety sampling.
 *
 * Seed-stable inside this app, but deliberately not compatible with Python's
 * random.Random: parity vectors never compare sampled picks.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

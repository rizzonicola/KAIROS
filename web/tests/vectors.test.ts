import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Board,
  candidateFeatures,
  positionStats,
  type Features,
  type PositionStats,
} from "../src/chess-features";
import {
  POSTURES,
  WEIGHTS,
  PostureController,
  dominant,
  evidenceFromStats,
  inferMix,
  planToken,
  positionClass,
  scoreTrend,
  updateFragility,
  varietyTemperature,
  type Evidence,
  type FeatureName,
  type FragilityClass,
  type Mix,
  type Posture,
} from "../src/postures";

interface BoardCase {
  fen: string;
  move: string;
  fenAfter: string;
  positionKey: string;
  halfmoveReset: boolean;
  capturedValue: number;
  materialDelta: number;
  givesCheck: boolean;
  threatensQueen: boolean;
}

interface FeatureCase {
  fen: string;
  moves: string[];
  stats: PositionStats;
  features: Record<string, Features>;
}

interface PostureVectors {
  weights: Record<Posture, Record<FeatureName, number>>;
  planTokens: Record<Posture, string>;
  trend: { history: number[]; current: number; expected: number }[];
  evidence: {
    stats: PositionStats;
    expected: number;
    history: number[];
    forcingDensity: number;
    opponentFragility: number;
    result: Evidence;
  }[];
  inference: { evidence: Evidence; mix: Mix; dominant: Posture }[];
  classes: {
    stats: PositionStats;
    expected: number;
    forcingDensity: number;
    class: FragilityClass;
  }[];
  fragility: { previous: number; loss: number; expected: number }[];
  variety: { variety: number; posture: string; forced: boolean; temperature: number }[];
  controller: {
    name: string;
    initialMix: Mix | null;
    steps: { mix: Mix; evidence: Evidence; forced?: Posture }[];
    finalMix: Mix;
  }[];
}

function load<T>(name: string): T {
  const text = readFileSync(new URL(`./vectors/${name}`, import.meta.url), "utf8");
  return JSON.parse(text) as T;
}

function expectClose(actual: number, expected: number, label = ""): void {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-9);
}

function expectStatsClose(actual: PositionStats, expected: PositionStats): void {
  for (const key of Object.keys(expected) as (keyof PositionStats)[]) {
    expectClose(actual[key], expected[key], key);
  }
}

describe("Python parity vectors", () => {
  it("matches the board cases", () => {
    const { cases } = load<{ cases: BoardCase[] }>("board.json");
    for (const item of cases) {
      const before = Board.fromFen(item.fen);
      const after = before.applyUci(item.move);
      expect(after.toFen(), `${item.fen} ${item.move}`).toBe(item.fenAfter);
      expect(after.positionKey()).toBe(item.positionKey);
      expect(before.resetsHalfmove(item.move)).toBe(item.halfmoveReset);
      expect(before.capturedValue(item.move)).toBe(item.capturedValue);
      expect(before.materialDelta(item.move)).toBe(item.materialDelta);
      expect(before.moveGivesCheck(item.move)).toBe(item.givesCheck);
      expect(before.moveThreatensEnemyQueen(item.move)).toBe(item.threatensQueen);
    }
  });

  it("matches the feature cases", () => {
    const { cases } = load<{ cases: FeatureCase[] }>("features.json");
    for (const item of cases) {
      const board = Board.fromFen(item.fen);
      expectStatsClose(positionStats(board), item.stats);
      for (const move of item.moves) {
        const expected = item.features[move];
        const actual = candidateFeatures(board, move);
        for (const key of Object.keys(expected) as (keyof Features)[]) {
          expectClose(actual[key], expected[key], `${item.fen} ${move} ${key}`);
        }
      }
    }
  });

  it("matches the weight table and plan tokens", () => {
    const vectors = load<PostureVectors>("postures.json");
    expect(WEIGHTS).toEqual(vectors.weights);
    for (const posture of POSTURES) {
      expect(planToken(posture)).toBe(vectors.planTokens[posture]);
    }
  });

  it("matches trend and evidence normalization", () => {
    const vectors = load<PostureVectors>("postures.json");
    for (const item of vectors.trend) {
      expectClose(scoreTrend(item.history, item.current), item.expected);
    }
    for (const item of vectors.evidence) {
      const actual = evidenceFromStats(
        item.stats,
        item.expected,
        item.history,
        item.forcingDensity,
        item.opponentFragility,
      );
      for (const key of Object.keys(item.result) as (keyof Evidence)[]) {
        expectClose(actual[key], item.result[key], key);
      }
    }
  });

  it("matches inference, classes, fragility and variety", () => {
    const vectors = load<PostureVectors>("postures.json");
    for (const item of vectors.inference) {
      const actual = inferMix(item.evidence);
      for (const posture of POSTURES) {
        expectClose(actual[posture], item.mix[posture], posture);
      }
      expect(dominant(actual)).toBe(item.dominant);
    }
    for (const item of vectors.classes) {
      expect(positionClass(item.stats, item.expected, item.forcingDensity)).toBe(item.class);
    }
    for (const item of vectors.fragility) {
      expectClose(updateFragility(item.previous, item.loss), item.expected);
    }
    for (const item of vectors.variety) {
      expectClose(
        varietyTemperature(item.variety, item.posture, item.forced),
        item.temperature,
      );
    }
  });

  it("matches controller hysteresis", () => {
    const vectors = load<PostureVectors>("postures.json");
    for (const scenario of vectors.controller) {
      const controller = new PostureController();
      if (scenario.initialMix) {
        controller.mix = scenario.initialMix;
      }
      for (const step of scenario.steps) {
        controller.update(step.mix, step.evidence, step.forced ?? null);
      }
      for (const posture of POSTURES) {
        expectClose(
          controller.mix[posture],
          scenario.finalMix[posture],
          `${scenario.name} ${posture}`,
        );
      }
    }
  });
});

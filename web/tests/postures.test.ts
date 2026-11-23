import { describe, expect, it } from "vitest";
import {
  FEATURES,
  POSTURES,
  WEIGHTS,
  PostureController,
  dominant,
  evidenceFromStats,
  inferMix,
  mulberry32,
  oneHot,
  planToken,
  positionClass,
  sampleIndex,
  scoreTrend,
  updateFragility,
  varietyTemperature,
  weightedFeatures,
  type Evidence,
  type Mix,
} from "../src/postures";

function mix(values: Partial<Mix> = {}): Mix {
  return {
    Coil: 0,
    Strike: 0,
    Absorb: 0,
    Reverse: 0,
    Distill: 0,
    Fog: 0,
    ...values,
  };
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    expected: 0.5,
    trend: 0,
    tension: 0,
    ownKingPressure: 0,
    enemyKingPressure: 0,
    forcingDensity: 0,
    phase: 0,
    opponentFragility: 0,
    materialBalance: 0,
    ...overrides,
  };
}

describe("weights", () => {
  it("matches the spec weight table", () => {
    for (const posture of POSTURES) {
      expect(Object.keys(WEIGHTS[posture]).sort()).toEqual([...FEATURES].sort());
    }
    expect(WEIGHTS.Coil.F_T).toBe(2);
    expect(WEIGHTS.Coil.F_S).toBe(-1);
    expect(WEIGHTS.Distill.F_S).toBe(3);
    expect(WEIGHTS.Fog.F_S).toBe(-3);
    expect(WEIGHTS.Absorb.F_P).toBe(3);
  });

  it("weights features for Coil", () => {
    const coil = oneHot("Coil");
    expect(weightedFeatures(coil, { F_T: 0.25 })).toBeCloseTo(0.5, 12);
    expect(weightedFeatures(coil, { F_S: 0.5 })).toBeCloseTo(-0.5, 12);
    expect(weightedFeatures(coil, { F_I: 1.0 })).toBeCloseTo(1.0, 12);
  });

  it("maps plan tokens to postures", () => {
    expect(planToken("Coil")).toBe("hold-tension");
    expect(planToken("Distill")).toBe("convert");
    expect(planToken("unknown")).toBe("hold-tension");
  });
});

describe("inference", () => {
  it("compares the trend against the previous three moves", () => {
    expect(scoreTrend([], 0.7)).toBe(0);
    expect(scoreTrend([0.5], 0.6)).toBeCloseTo(1.0, 12);
    expect(scoreTrend([0.6], 0.5)).toBeCloseTo(-1.0, 12);
    expect(scoreTrend([0.5, 0.5, 0.5, 0.5], 0.55)).toBeCloseTo(0.5, 12);
  });

  it("normalizes evidence from stats", () => {
    const stats = {
      tension: 8.0,
      ownKingAttackers: 3.0,
      enemyKingAttackers: 1.5,
      phase: 0.5,
      materialBalance: -2.0,
    };
    const result = evidenceFromStats(stats, 0.6, [0.5], 0.75, 0.4);
    expect(result.tension).toBe(1.0);
    expect(result.ownKingPressure).toBe(1.0);
    expect(result.enemyKingPressure).toBeCloseTo(0.5, 12);
    expect(result.forcingDensity).toBe(0.75);
    expect(result.trend).toBeCloseTo(1.0, 12);
    expect(result.opponentFragility).toBe(0.4);
    expect(result.materialBalance).toBe(-2.0);
  });

  it("prefers Coil for balanced evidence", () => {
    const result = inferMix(evidence({ expected: 0.5, tension: 0.1 }));
    expect(dominant(result)).toBe("Coil");
    expect(sum(result)).toBeCloseTo(1.0, 12);
  });

  it("prefers Strike for attack evidence", () => {
    const result = inferMix(
      evidence({
        expected: 0.6,
        trend: 0.5,
        enemyKingPressure: 0.9,
        forcingDensity: 0.8,
      }),
    );
    expect(dominant(result)).toBe("Strike");
  });

  it("prefers Fog when losing", () => {
    const result = inferMix(evidence({ expected: 0.2, tension: 0.1 }));
    expect(dominant(result)).toBe("Fog");
  });

  it("prefers Distill when winning", () => {
    const result = inferMix(evidence({ expected: 0.9, tension: 0.1, phase: 0.5 }));
    expect(dominant(result)).toBe("Distill");
  });

  it("damps Fog against a precise opponent", () => {
    const fragile = inferMix(evidence({ expected: 0.2, tension: 0.1, opponentFragility: 0.5 }));
    const precise = inferMix(evidence({ expected: 0.2, tension: 0.1, opponentFragility: -0.5 }));
    expect(fragile.Fog).toBeGreaterThan(precise.Fog);
  });
});

describe("opponent model", () => {
  it("classifies positions", () => {
    expect(positionClass({ phase: 0.1 }, 0.5)).toBe("endgame");
    expect(positionClass({ phase: 0.8, tension: 3.0 }, 0.5)).toBe("sharp-tactical");
    expect(positionClass({ phase: 0.8, tension: 0.0 }, 0.5, 0.6)).toBe("sharp-tactical");
    expect(
      positionClass({ phase: 0.8, tension: 0.0, ownKingAttackers: 2.0 }, 0.5),
    ).toBe("defending");
    expect(positionClass({ phase: 0.8 }, 0.4)).toBe("defending");
    expect(positionClass({ phase: 0.8 }, 0.55)).toBe("quiet-maneuvering");
  });

  it("clamps the fragility EWMA", () => {
    expect(updateFragility(0.0, 1.0)).toBeCloseTo(0.3, 12);
    expect(updateFragility(0.3, 0.0)).toBeCloseTo(0.21, 12);
    expect(updateFragility(0.0, 5.0)).toBe(0.3);
    expect(updateFragility(0.0, -5.0)).toBe(-0.3);
  });

  it("applies the variety temperature rules", () => {
    expect(varietyTemperature(0, "Coil", false)).toBe(0);
    expect(varietyTemperature(100, "Strike", false)).toBe(0);
    expect(varietyTemperature(100, "Distill", false)).toBe(0);
    expect(varietyTemperature(100, "Coil", true)).toBe(0);
    expect(varietyTemperature(50, "Coil", false)).toBeCloseTo(0.05, 12);
  });
});

describe("PostureController", () => {
  it("needs two consecutive moves for inertia", () => {
    const controller = new PostureController();
    const strongStrike = mix({ Strike: 0.8, Coil: 0.2 });
    const weakEvidence = evidence({ expected: 0.6, enemyKingPressure: 0.2 });
    controller.update(strongStrike, weakEvidence);
    expect(dominant(controller.mix)).toBe("Coil");
    controller.update(strongStrike, weakEvidence);
    expect(dominant(controller.mix)).toBe("Strike");
  });

  it("overrides immediately for strong Strike evidence", () => {
    const controller = new PostureController();
    controller.update(
      mix({ Strike: 0.8, Coil: 0.2 }),
      evidence({ expected: 0.6, enemyKingPressure: 0.8 }),
    );
    expect(dominant(controller.mix)).toBe("Strike");
  });

  it("locks Distill and exits below 0.65", () => {
    const controller = new PostureController();
    controller.mix = oneHot("Distill");
    const coily = mix({ Coil: 0.8, Distill: 0.05 });
    controller.update(coily, evidence({ expected: 0.85 }));
    expect(dominant(controller.mix)).toBe("Distill");
    controller.update(coily, evidence({ expected: 0.7 }));
    expect(dominant(controller.mix)).toBe("Distill");
    controller.update(coily, evidence({ expected: 0.5 }));
    expect(dominant(controller.mix)).toBe("Distill");
    controller.update(coily, evidence({ expected: 0.5 }));
    expect(dominant(controller.mix)).toBe("Coil");
  });

  it("honors a forced posture over inference", () => {
    const controller = new PostureController();
    controller.update(inferMix(evidence()), evidence(), "Fog");
    expect(controller.mix).toEqual(oneHot("Fog"));
  });

  it("is argmax at zero temperature", () => {
    expect(sampleIndex([0.0, 1.0, 0.5], 0.0, mulberry32(0))).toBe(1);
  });

  it("explores at positive temperature", () => {
    const rng = mulberry32(0);
    const picks = new Set<number>();
    for (let i = 0; i < 100; i++) {
      picks.add(sampleIndex([0.0, 1.0, 0.5], 0.2, rng));
    }
    expect(picks.has(1)).toBe(true);
  });
});

function sum(mixValues: Mix): number {
  return POSTURES.reduce((total, posture) => total + mixValues[posture], 0);
}

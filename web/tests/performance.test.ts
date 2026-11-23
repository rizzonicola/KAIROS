import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Board,
  candidateFeatures,
  positionStats,
} from "../src/chess-features";

interface FeatureCase {
  fen: string;
  moves: string[];
  features: Record<string, unknown>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./vectors/features.json", import.meta.url), "utf8"),
) as { cases: FeatureCase[] };

describe("feature performance", () => {
  it("evaluates every fixture case under 50 ms on average", () => {
    const started = performance.now();
    let evaluations = 0;
    for (const testCase of fixtures.cases) {
      const board = Board.fromFen(testCase.fen);
      for (const move of Object.keys(testCase.features)) {
        positionStats(board);
        candidateFeatures(board, move);
        evaluations += 1;
      }
    }
    const elapsed = performance.now() - started;
    const average = elapsed / fixtures.cases.length;
    console.log(
      `features: ${elapsed.toFixed(2)} ms / ${fixtures.cases.length} cases ` +
        `(${evaluations} evaluations, avg ${average.toFixed(2)} ms)`,
    );
    expect(average).toBeLessThan(50);
  });
});

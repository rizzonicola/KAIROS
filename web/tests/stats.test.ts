import { describe, expect, it } from "vitest";
import { mean, percentile, welchP } from "../tools/stats";

describe("harness statistics", () => {
  it("computes means and percentiles", () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 3])).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([5], 95)).toBe(5);
  });

  it("gives a tiny p for clearly different samples and a large one for equal samples", () => {
    const a = Array.from({ length: 100 }, (_, i) => 10 + (i % 3));
    const b = Array.from({ length: 100 }, (_, i) => 20 + (i % 3));
    expect(welchP(a, b)!).toBeLessThan(0.001);
    expect(welchP(a, a)!).toBeGreaterThan(0.9);
    expect(welchP([1], [2])).toBeNull();
  });
});

import type { Features } from "../core";
import { ZERO_FEATURES, type ScoreInputs } from "../scoring";
import type { Run } from "./run";

/** Scoring inputs for the current state of a run (features come from the core). */
export function scoreInputs(run: Run): ScoreInputs {
  return {
    mix: run.mix,
    // style/100 scaled by Independence (documented, uncalibrated: 1x at 0, 2x at 100).
    personalityScale: (run.options.style / 100) * (1 + run.options.independence / 100),
    featuresFor: (move: string): Features => {
      try {
        return run.core.features(move) ?? ZERO_FEATURES;
      } catch {
        return ZERO_FEATURES;
      }
    },
    probes: run.probeResults,
    nullThreat: run.nullThreat,
    proposed: run.proposedMoves,
  };
}

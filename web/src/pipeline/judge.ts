/**
 * Stage 2: Stockfish as judge. One `go ... searchmoves <proposals + top-3>`
 * with MultiPV = number of moves, so every expected-score comparison comes
 * from the same search (same depth, exact scores, WDL present).
 */

import { eligibleFromJudge, scoreEligible } from "../scoring";
import type { Candidate } from "../uci";
import { scoreInputs } from "./inputs";
import { startProbes } from "./probe";
import { selectAndVerify } from "./verify";
import type { Run, Stage } from "./run";

/** Corridor + scoring over `run.judged`, then probes (if enabled) and verification. */
export function afterJudge(run: Run): void {
  const anchor = run.judged.find((candidate) => candidate.move === run.baseline.sfBest);
  if (!anchor) {
    run.fallback("anchor-missing");
    return;
  }
  const eligible = eligibleFromJudge(anchor, run.judged, run.budgetPct, {
    repetitionCount: (move) => run.core.repetitionCount(move),
    resetsHalfmove: (move) => run.core.resetsHalfmove(move),
    halfmoveClock: () => run.core.halfmoveClock(),
  });
  if (eligible.length <= 1) {
    run.fallback("no-eligible-rerank");
    return;
  }
  run.scored = scoreEligible(eligible, scoreInputs(run));
  if (run.timing.probes && startProbes(run)) {
    return;
  }
  selectAndVerify(run);
}

export const JudgeStage: Stage = {
  name: "judge",

  enter(run: Run): void {
    run.judgeBuckets = new Map();
    run.send(`setoption name MultiPV value ${run.judgeMoves.length}`);
    run.send(run.position);
    run.send(run.go("judge", run.judgeMoves));
  },

  onInfo(run: Run, line: string, candidate: Candidate | null): void {
    if (/\sscore mate\s/.test(line)) {
      run.mateSeen = true;
    }
    if (candidate === null) {
      return;
    }
    let bucket = run.judgeBuckets.get(candidate.depth);
    if (!bucket) {
      bucket = new Map();
      run.judgeBuckets.set(candidate.depth, bucket);
    }
    bucket.set(candidate.move, candidate);
  },

  onBestmove(run: Run): void {
    if (run.stopRequested) {
      run.fallback("stopped-during-judge");
      return;
    }
    if (run.mateSeen) {
      run.fallback("mate-score");
      return;
    }
    const anchorMove = run.baseline.sfBest;
    const depths = [...run.judgeBuckets.keys()].sort((a, b) => b - a);
    let chosen = depths.find((depth) => {
      const bucket = run.judgeBuckets.get(depth)!;
      return run.judgeMoves.every((move) => bucket.has(move));
    });
    if (chosen === undefined) {
      // Partial iteration: the deepest depth that still contains the anchor and one more move.
      chosen = depths.find((depth) => {
        const bucket = run.judgeBuckets.get(depth)!;
        return bucket.has(anchorMove) && bucket.size >= 2;
      });
    }
    if (chosen === undefined) {
      run.fallback("judge-incomplete");
      return;
    }
    const bucket = run.judgeBuckets.get(chosen)!;
    run.judged = run.judgeMoves.flatMap((move) => {
      const record = bucket.get(move);
      return record ? [record] : [];
    });
    run.judgeDepth = chosen;
    afterJudge(run);
  },
};

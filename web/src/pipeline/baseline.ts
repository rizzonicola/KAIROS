/** Stage 1: Stockfish baseline (MultiPV 3, WDL) while KAIROS proposes its own candidates. */

import { POSTURES, dominant, planToken } from "../postures";
import { DISTILL_SKIP_EXPECTED, effectiveBudgetPct, singleBudgetPct } from "../guards";
import { expectedScore, parseBestmove, type Candidate } from "../uci";
import { afterJudge, JudgeStage } from "./judge";
import type { Run, Stage } from "./run";

const PROPOSAL_COUNT = 12;
const PROPOSAL_NODE_BUDGET = 80_000;
const MAX_JUDGED = 10;

/** Number of KAIROS-proposed moves added to the judged set for an Independence value. */
export function extraSlots(independence: number, baselineCount: number): number {
  const room = Math.max(0, Math.min(7, MAX_JUDGED - baselineCount));
  return Math.round((Math.max(0, Math.min(100, independence)) / 100) * room);
}

/**
 * Own candidate generation. Normally called right after `go` so it overlaps
 * with the Stockfish search; also called lazily from `onBestmove` so an engine
 * that answers synchronously (tests, the Node adapter) cannot skip it.
 */
function startProposals(run: Run): void {
  if (run.proposalsStarted) {
    return;
  }
  run.proposalsStarted = true;
  const { core, options } = run;
  const mixNow = { ...run.host.posture.mix };
  try {
    run.planTokenValue = core.updatePlan(dominant(mixNow));
    if (options.independence > 0) {
      const legal = new Set(core.legalMoves());
      const mixArray = POSTURES.map((name) => mixNow[name]);
      run.proposals = core
        .propose(mixArray, PROPOSAL_COUNT, PROPOSAL_NODE_BUDGET)
        .filter((proposal) => legal.has(proposal.move));
    }
  } catch {
    run.proposals = [];
  }
  run.proposedMoves = new Set(run.proposals.map((proposal) => proposal.move));
}

export const BaselineStage: Stage = {
  name: "baseline",

  enter(run: Run): void {
    run.byPv = new Map();
    run.send("setoption name MultiPV value 3");
    run.send(run.go("baseline"));
    // Runs in this worker while the Stockfish worker searches.
    startProposals(run);
  },

  onInfo(run: Run, line: string, candidate: Candidate | null): void {
    if (/\sscore mate\s/.test(line)) {
      run.mateSeen = true;
    }
    if (candidate !== null) {
      const previous = run.byPv.get(candidate.multipv);
      if (previous === undefined || candidate.depth >= previous.depth) {
        run.byPv.set(candidate.multipv, candidate);
      }
    }
  },

  onBestmove(run: Run, line: string): void {
    const { move, ponder } = parseBestmove(line);
    startProposals(run);
    run.baseline.sfBest = move;
    run.baseline.sfBestLine = line;
    run.baseline.ponder = ponder;
    run.host.spentHistory.push(0);
    run.host.spentHistory.splice(0, Math.max(0, run.host.spentHistory.length - 10));
    if (run.stopRequested) {
      run.fallback("stopped-during-baseline");
      return;
    }
    const candidates = [...run.byPv.values()];
    if (run.mateSeen || candidates.some((candidate) => candidate.scoreKind === "mate")) {
      run.fallback("mate-score");
      return;
    }
    const baseline = candidates.find((candidate) => candidate.move === move);
    if (!baseline) {
      run.fallback("no-baseline-record");
      return;
    }
    const top = candidates
      .filter((candidate) => candidate.depth === baseline.depth)
      .sort((a, b) => a.multipv - b.multipv);
    run.baseline.top = top;
    run.baselineCandidate = baseline;

    run.host.updatePosture(run, baseline);
    run.mix = { ...run.host.posture.mix };
    run.posture = dominant(run.mix);
    run.confidence = Math.max(...POSTURES.map((name) => run.mix[name]));
    try {
      run.planTokenValue = run.core.updatePlan(run.posture);
      run.planIntent = run.planTokenValue.intent || planToken(run.posture);
    } catch {
      run.planIntent = planToken(run.posture);
    }
    if (run.posture === "Distill" && expectedScore(baseline) >= DISTILL_SKIP_EXPECTED) {
      run.fallback("distill-conversion");
      return;
    }
    run.budgetPct = effectiveBudgetPct(
      singleBudgetPct(run.posture, run.options.style),
      run.host.spentHistory,
    );
    if (run.budgetPct <= 0) {
      run.fallback("no-eligible-rerank");
      return;
    }

    const slots = extraSlots(run.options.independence, top.length);
    const topMoves = top.map((candidate) => candidate.move);
    const extras = run.proposals
      .map((proposal) => proposal.move)
      .filter((proposed) => !topMoves.includes(proposed))
      .slice(0, slots);
    const judgeMoves = [move, ...topMoves.filter((m) => m !== move), ...extras];
    run.judgeMoves = judgeMoves;
    if (extras.length === 0) {
      // Nothing outside the baseline MultiPV to judge: the baseline search IS the judge search.
      run.judged = top;
      run.judgeDepth = baseline.depth;
      afterJudge(run);
      return;
    }
    run.enter(JudgeStage);
  },
};

export type { Candidate };

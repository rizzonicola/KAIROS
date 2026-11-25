/**
 * Stage 4: select and verify. The pick is re-searched together with
 * Stockfish's best (`searchmoves` pair, MultiPV 2). A rerank is emitted ONLY
 * from here, after `corridorCheck` accepted the measured loss (invariant 6).
 * Any failure tries the next candidate (if time was budgeted) and then falls
 * back to Stockfish's best move.
 */

import { corridorCheck } from "../guards";
import { sampleIndex, varietyTemperature } from "../postures";
import type { Scored } from "../scoring";
import { expectedScore, type Candidate } from "../uci";
import type { Run, Stage } from "./run";

export function selectAndVerify(run: Run): void {
  const sfBest = run.baseline.sfBest;
  const baseline = run.scored.find((item) => item.move === sfBest);
  const remaining = run.scored.filter(
    (item) => item.move !== sfBest && !run.triedMoves.has(item.move),
  );
  if (!baseline || remaining.length === 0) {
    run.fallback(
      run.attempts > 0 ? run.lastFailure : "no-eligible-rerank",
      run.lastRejectedLoss,
    );
    return;
  }
  const forced = run.options.posture !== "Auto";
  const tau = run.attempts === 0 ? varietyTemperature(run.options.variety, run.posture, forced) : 0;
  let picked: Scored;
  if (tau > 0) {
    const index = sampleIndex(
      run.scored.map((item) => item.score),
      tau,
      run.host.rng,
    );
    picked = run.scored[index];
    if (picked.move === sfBest || run.triedMoves.has(picked.move)) {
      run.fallback("no-eligible-rerank");
      return;
    }
  } else {
    picked = remaining[0];
    if (picked.score <= baseline.score + 1e-12) {
      run.fallback(run.attempts > 0 ? run.lastFailure : "no-eligible-rerank", run.lastRejectedLoss);
      return;
    }
  }
  run.enter(VerifyStage, picked);
}

function reasonFor(check: string): string {
  if (check === "mate-guard") {
    return "verification-mate-score";
  }
  if (check === "saturated-score-margin") {
    return "verification-saturated-score-margin";
  }
  return "verification-outside-corridor-or-result-band";
}

export const VerifyStage: Stage = {
  name: "verify",

  enter(run: Run): void {
    const picked = run.selected;
    if (picked === null) {
      run.fallback("no-eligible-rerank");
      return;
    }
    run.attempts += 1;
    run.triedMoves.add(picked.move);
    run.verifyByPv = new Map();
    run.send("setoption name MultiPV value 2");
    run.send(run.position);
    run.send(run.go("verify", [run.baseline.sfBest, picked.move]));
  },

  onInfo(run: Run, line: string, candidate: Candidate | null): void {
    if (/\sscore mate\s/.test(line)) {
      run.mateSeen = true;
    }
    if (candidate !== null) {
      const previous = run.verifyByPv.get(candidate.multipv);
      if (previous === undefined || candidate.depth >= previous.depth) {
        run.verifyByPv.set(candidate.multipv, candidate);
      }
    }
  },

  onBestmove(run: Run): void {
    const picked = run.selected;
    if (picked === null) {
      run.fallback("no-eligible-rerank");
      return;
    }
    if (run.stopRequested) {
      run.fallback("stopped-during-verification");
      return;
    }
    const records = [...run.verifyByPv.values()];
    const sfRecord = records.find((record) => record.move === run.baseline.sfBest);
    const pickRecord = records.find((record) => record.move === picked.move);
    const failed = (reason: string, loss?: number): void => {
      run.lastFailure = reason;
      run.lastRejectedLoss = loss;
      if (run.attempts < run.timing.verifyAttempts) {
        selectAndVerify(run);
      } else {
        run.fallback(reason, loss);
      }
    };
    if (run.mateSeen || [sfRecord, pickRecord].some((r) => r?.scoreKind === "mate")) {
      failed("verification-mate-score");
      return;
    }
    if (!sfRecord || !pickRecord) {
      failed("verification-incomplete");
      return;
    }
    if (sfRecord.depth !== pickRecord.depth) {
      failed("verification-depth-mismatch");
      return;
    }
    const check = corridorCheck(
      { expected: expectedScore(sfRecord), scoreKind: sfRecord.scoreKind, scoreValue: sfRecord.scoreValue },
      {
        expected: expectedScore(pickRecord),
        scoreKind: pickRecord.scoreKind,
        scoreValue: pickRecord.scoreValue,
      },
      run.budgetPct,
    );
    if (!check.accepted) {
      failed(reasonFor(check.reason), check.lossPct);
      return;
    }
    run.rerank(picked, check.lossPct);
  },
};

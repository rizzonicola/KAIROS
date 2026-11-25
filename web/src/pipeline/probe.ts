/**
 * Stage 3 (optional, >= 3000 ms or depth >= 6): short child searches that
 * measure narrowness (F_N) and prophylaxis (F_P) of the best-scored
 * candidates. Probe scores are from the opponent's point of view.
 */

import { scoreEligible } from "../scoring";
import { expectedScore, type Candidate } from "../uci";
import { scoreInputs } from "./inputs";
import type { Run, Stage } from "./run";
import { selectAndVerify } from "./verify";

const PROBE_CANDIDATES = 4;
const PROBE_REPLIES = 3;

/** Begin probes; false when there is nothing to probe. */
export function startProbes(run: Run): boolean {
  const moves = run.scored.slice(0, PROBE_CANDIDATES).map((item) => item.move);
  if (!moves.includes(run.baseline.sfBest)) {
    moves.push(run.baseline.sfBest);
  }
  const labels: string[] = [];
  let nullFen: string | null = null;
  try {
    nullFen = run.core.nullFen();
  } catch {
    nullFen = null;
  }
  if (nullFen) {
    labels.push("null");
  }
  labels.push(...moves);
  if (labels.length === 0) {
    return false;
  }
  run.probeLabels = labels;
  run.probeIndex = 0;
  run.probeMateSeen = false;
  run.enter(ProbeStage);
  return true;
}

function fenFor(run: Run, label: string): string | null {
  try {
    const fen = label === "null" ? run.core.nullFen() : run.core.childFen(label);
    return fen ? fen : null;
  } catch {
    return null;
  }
}

/** Send the next probe that has a position; false when all probes are done. */
function sendNext(run: Run): boolean {
  while (run.probeIndex < run.probeLabels.length) {
    const label = run.probeLabels[run.probeIndex];
    const fen = fenFor(run, label);
    if (fen === null) {
      run.probeIndex += 1;
      continue;
    }
    run.probeRecords = new Map();
    run.send(`setoption name MultiPV value ${PROBE_REPLIES}`);
    run.send(`position fen ${fen}`);
    run.send(run.probeGo(run.probeLabels.length));
    return true;
  }
  return false;
}

function finishProbes(run: Run): void {
  run.scored = scoreEligible(
    run.scored.map((item) => ({
      move: item.move,
      candidate: item.candidate,
      lossPct: item.lossPct,
    })),
    scoreInputs(run),
  );
  selectAndVerify(run);
}

export const ProbeStage: Stage = {
  name: "probe",

  enter(run: Run): void {
    if (!sendNext(run)) {
      finishProbes(run);
    }
  },

  onInfo(run: Run, line: string, candidate: Candidate | null): void {
    if (/\sscore mate\s/.test(line)) {
      run.probeMateSeen = true;
    }
    if (candidate !== null) {
      const previous = run.probeRecords.get(candidate.multipv);
      if (previous === undefined || candidate.depth >= previous.depth) {
        run.probeRecords.set(candidate.multipv, candidate);
      }
    }
  },

  onBestmove(run: Run): void {
    if (run.stopRequested) {
      run.fallback("stopped-during-probe");
      return;
    }
    if (run.probeMateSeen) {
      run.fallback("probe-mate-score");
      return;
    }
    const label = run.probeLabels[run.probeIndex];
    const records = [...run.probeRecords.values()];
    if (records.length > 0) {
      const deepest = Math.max(...records.map((record) => record.depth));
      const values = records
        .filter((record) => record.depth === deepest)
        .map((record) => expectedScore(record))
        .sort((a, b) => b - a);
      if (label === "null") {
        run.nullThreat = values[0];
      } else {
        run.probeResults.set(label, {
          best: values[0],
          second: values.length > 1 ? values[1] : null,
          replies: values,
        });
      }
    }
    run.probeIndex += 1;
    run.probeMateSeen = false;
    if (!sendNext(run)) {
      finishProbes(run);
    }
  },
};

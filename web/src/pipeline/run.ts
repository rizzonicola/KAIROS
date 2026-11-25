/**
 * One personality move: shared state, stage protocol and fallback helpers.
 *
 * Stages: baseline -> judge -> (probes) -> verify, with a fallback to
 * Stockfish's best move from any stage (spec 5.3). Every stage is a small
 * object in its own module; this file owns only what they share.
 */

import type { KairosCore, PlanToken, Proposal } from "../core";
import { planToken, dominant, type Mix, type PostureController, type Posture } from "../postures";
import { judgedRank, type Scored, type ProbeRecord } from "../scoring";
import type { ControllerEvent, EnginePort, KairosOptions, Rationale } from "../types";
import type { Candidate, SupportedSearch } from "../uci";

export type StageName = "baseline" | "judge" | "probe" | "verify";

export interface Stage {
  readonly name: StageName;
  enter(run: Run): void;
  /** Called for every `info` line of the active search. */
  onInfo(run: Run, line: string, candidate: Candidate | null): void;
  onBestmove(run: Run, line: string): void;
}

/** What a run needs from the controller that owns it. */
export interface RunHost {
  readonly port: EnginePort;
  readonly core: KairosCore;
  readonly options: KairosOptions;
  readonly posture: PostureController;
  readonly rng: () => number;
  /** Rolling spent expected-score history in percentage points; mutated by the run. */
  readonly spentHistory: number[];
  emit(event: ControllerEvent): void;
  /** Opponent model + posture inference from the baseline record. */
  updatePosture(run: Run, baseline: Candidate): void;
  /** Called once when the run is over (frees the controller for deferred commands). */
  runFinished(run: Run): void;
}

export interface Timing {
  baselineMs: number;
  judgeMs: number;
  probeMs: number;
  verifyMs: number;
  probes: boolean;
  verifyAttempts: number;
}

/**
 * Time split (uncalibrated, spec 5.3): with probes 35/30/20/15; without
 * probes 40/32 and two verification attempts of 14 each.
 */
export function planTiming(totalMs: number, probesEnabled: boolean): Timing {
  if (probesEnabled) {
    return {
      baselineMs: Math.max(100, Math.trunc(totalMs * 0.35)),
      judgeMs: Math.max(100, Math.trunc(totalMs * 0.3)),
      probeMs: Math.max(25, Math.trunc(totalMs * 0.2)),
      verifyMs: Math.max(50, Math.trunc(totalMs * 0.15)),
      probes: true,
      verifyAttempts: 1,
    };
  }
  return {
    baselineMs: Math.max(100, Math.trunc(totalMs * 0.4)),
    judgeMs: Math.max(100, Math.trunc(totalMs * 0.32)),
    probeMs: 0,
    verifyMs: Math.max(50, Math.trunc(totalMs * 0.14)),
    probes: false,
    verifyAttempts: 2,
  };
}

export interface BaselineRecord {
  sfBest: string;
  sfBestLine: string;
  ponder?: string;
  top: Candidate[];
}

export class Run {
  stage!: Stage;
  stopRequested = false;
  mateSeen = false;

  readonly goKind: "depth" | "movetime";
  readonly mainDepth: number;
  readonly totalMs: number;
  readonly timing: Timing;

  // baseline
  baseline: BaselineRecord = { sfBest: "", sfBestLine: "", top: [] };
  baselineCandidate: Candidate | null = null;
  // proposals made by the core (own candidate generation)
  proposals: Proposal[] = [];
  proposalsStarted = false;
  proposedMoves = new Set<string>();
  // judge
  judgeMoves: string[] = [];
  judged: Candidate[] = [];
  judgeDepth = 0;
  // scoring / selection
  mix: Mix;
  posture: Posture;
  confidence = 0;
  planIntent = "";
  planTokenValue: PlanToken | undefined;
  budgetPct = 0;
  scored: Scored[] = [];
  triedMoves = new Set<string>();
  attempts = 0;
  selected: Scored | null = null;
  // per-stage info buffers
  byPv = new Map<number, Candidate>();
  judgeBuckets = new Map<number, Map<string, Candidate>>();
  verifyByPv = new Map<number, Candidate>();
  lastFailure = "no-eligible-rerank";
  lastRejectedLoss: number | undefined = undefined;
  // probes
  probeResults = new Map<string, ProbeRecord>();
  nullThreat: number | null = null;
  probeMateSeen = false;
  probeLabels: string[] = [];
  probeIndex = 0;
  probeRecords = new Map<number, Candidate>();

  constructor(
    readonly host: RunHost,
    readonly goLine: string,
    readonly position: string,
    readonly requestId: number | undefined,
    supported: SupportedSearch,
  ) {
    this.goKind = supported.kind === "depth" ? "depth" : "movetime";
    this.mainDepth = supported.kind === "depth" ? supported.amount : 0;
    this.totalMs = supported.kind === "movetime" ? supported.amount : 0;
    const probes = this.probesEnabled(supported);
    this.timing = planTiming(this.totalMs, probes);
    this.mix = { ...host.posture.mix };
    this.posture = dominant(this.mix);
  }

  private probesEnabled(supported: SupportedSearch): boolean {
    if (supported.kind === "depth") {
      return supported.amount >= 6;
    }
    return supported.amount >= 3000;
  }

  get options(): KairosOptions {
    return this.host.options;
  }

  get core(): KairosCore {
    return this.host.core;
  }

  send(line: string): void {
    this.host.port.send(line);
  }

  enter(stage: Stage, selected?: Scored): void {
    if (selected !== undefined) {
      this.selected = selected;
    }
    this.stage = stage;
    this.mateSeen = false;
    stage.enter(this);
  }

  /** `go` line for a stage. Depth searches keep depth semantics; movetime ones use the stage's share. */
  go(kind: "baseline" | "judge" | "verify" | "probe", searchmoves: string[] = []): string {
    const tail = searchmoves.length > 0 ? ` searchmoves ${searchmoves.join(" ")}` : "";
    if (this.goKind === "depth") {
      const depth =
        kind === "verify"
          ? this.mainDepth + 2
          : kind === "probe"
            ? Math.max(1, this.mainDepth - 3)
            : this.mainDepth;
      return `go depth ${depth}${tail}`;
    }
    const ms =
      kind === "baseline"
        ? this.timing.baselineMs
        : kind === "judge"
          ? this.timing.judgeMs
          : kind === "verify"
            ? this.timing.verifyMs
            : 0;
    return `go movetime ${ms}${tail}`;
  }

  probeGo(labelCount: number): string {
    if (this.goKind === "depth") {
      return `go depth ${Math.max(1, this.mainDepth - 3)}`;
    }
    return `go movetime ${Math.max(25, Math.trunc(this.timing.probeMs / Math.max(1, labelCount)))}`;
  }

  /** Record the verified loss as this move's spend in the rolling budget window. */
  recordSpent(lossPct: number): void {
    const history = this.host.spentHistory;
    if (history.length > 0) {
      history[history.length - 1] = lossPct;
    }
  }

  private baseRationale(kind: Rationale["kind"], reason: string, move: string): Rationale {
    const mixUsed = this.confidence > 0 ? this.mix : { ...this.host.posture.mix };
    const posture = this.confidence > 0 ? this.posture : dominant(mixUsed);
    const sfTop3 = this.baseline.top.slice(0, 3).map((candidate) => candidate.move);
    const proposed = this.proposals.map((proposal) => proposal.move);
    const outsideTop3 = move !== "" && !sfTop3.includes(move);
    const features = this.selected && this.selected.move === move ? this.selected.features : undefined;
    const narrowness = features && this.probeResults.has(move) ? features.F_N : null;
    let tension = 0;
    try {
      tension = this.core.tensionIndex();
    } catch {
      tension = 0;
    }
    return {
      kind,
      reason,
      posture,
      confidence: this.confidence > 0 ? this.confidence : mixUsed[posture],
      mix: mixUsed,
      plan: this.planIntent || planToken(posture),
      planToken: this.planTokenValue,
      budgetPct: this.budgetPct,
      lossPct: 0,
      pick: 1,
      sfBest: this.baseline.sfBest,
      features: undefined,
      proposed,
      sfTop3,
      playedProposed: this.proposedMoves.has(move),
      outsideTop3,
      independence: this.options.independence,
      pressure: { tension, narrowness },
    };
  }

  /** Play Stockfish's best move and name the guard that fired. */
  fallback(reason: string, rejectedLossPct?: number): void {
    if (!this.baseline.sfBest || this.baseline.sfBest === "(none)") {
      this.host.emit({ type: "error", message: "engine returned no move", recoverable: true });
      this.host.runFinished(this);
      return;
    }
    const rationale = this.baseRationale("fallback", reason, this.baseline.sfBest);
    if (rejectedLossPct !== undefined && Number.isFinite(rejectedLossPct)) {
      rationale.rejectedLossPct = rejectedLossPct;
    }
    this.host.emit({
      type: "bestmove",
      move: this.baseline.sfBest,
      ponder: this.baseline.ponder,
      rationale,
      requestId: this.requestId,
    });
    this.host.runFinished(this);
  }

  /** Play a verified KAIROS pick. Only called after verification accepted it. */
  rerank(pick: Scored, verifiedLoss: number): void {
    this.selected = pick;
    this.recordSpent(verifiedLoss);
    const rationale = this.baseRationale("rerank", "verified", pick.move);
    rationale.lossPct = verifiedLoss;
    rationale.features = pick.features;
    rationale.pick = judgedRank(pick.move, this.judged);
    this.host.emit({
      type: "bestmove",
      move: pick.move,
      rationale,
      requestId: this.requestId,
    });
    this.host.runFinished(this);
  }
}

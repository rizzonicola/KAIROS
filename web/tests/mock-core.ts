import type {
  Features,
  KairosCore,
  OwnBest,
  PlanToken,
  PositionStats,
  Proposal,
  SearchStatus,
} from "../src/core";
import { ZERO_FEATURES } from "../src/scoring";

export interface MockCoreScript {
  legal?: string[];
  features?: Record<string, Partial<Features>>;
  proposals?: Proposal[];
  stats?: Partial<PositionStats>;
  repetition?: Record<string, number>;
  resets?: Record<string, boolean>;
  halfmove?: number;
  ownBest?: OwnBest | null;
  /** searchStep calls before the scripted search reports done. */
  searchSteps?: number;
  acceptPosition?: (command: string) => boolean;
  nullFen?: string | null;
  tension?: number;
}

export const DEFAULT_LEGAL = ["g1f3", "b1c3", "f1c4", "h2h3", "d2d3", "a2a3", "d2d4", "f1b5"];

export function proposal(move: string, cls: Proposal["class"], f: Partial<Features>, score = 1): Proposal {
  return { move, class: cls, score, ownCp: 10, shadow: 0, features: { ...ZERO_FEATURES, ...f } };
}

/** Scripted stand-in for the Rust core: tests drive the controller without WASM. */
export class MockCore implements KairosCore {
  readonly kind = "mock";
  script: MockCoreScript;
  positions: string[] = [];
  proposeCalls: { mix: number[]; k: number }[] = [];
  searchStarts: { maxDepth: number; nodeCap: number }[] = [];
  stepsLeft = 0;
  plans: string[] = [];
  newGames = 0;

  constructor(script: MockCoreScript = {}) {
    this.script = script;
  }

  setPosition(command: string): boolean {
    this.positions.push(command);
    return this.script.acceptPosition ? this.script.acceptPosition(command) : true;
  }
  lastError(): string {
    return "mock rejected the position";
  }
  fen(): string {
    return "mock";
  }
  sideToMove(): "w" | "b" {
    return "w";
  }
  legalMoves(): string[] {
    return this.script.legal ?? DEFAULT_LEGAL;
  }
  isLegal(move: string): boolean {
    return this.legalMoves().includes(move);
  }
  inCheck(): boolean {
    return false;
  }
  halfmoveClock(): number {
    return this.script.halfmove ?? 0;
  }
  gameResult(): string {
    return "";
  }
  positionStats(): PositionStats {
    return {
      tension: this.script.tension ?? 0,
      ownKingAttackers: 0,
      ownKingDefenders: 2,
      enemyKingAttackers: 0,
      enemyKingDefenders: 2,
      phase: 0.8,
      materialBalance: 0,
      ...this.script.stats,
    };
  }
  tensionIndex(): number {
    return this.script.tension ?? 0;
  }
  features(move: string): Features | null {
    if (!this.isLegal(move)) {
      return null;
    }
    return { ...ZERO_FEATURES, ...(this.script.features?.[move] ?? {}) };
  }
  forcingDensity(): number {
    return 0;
  }
  repetitionCount(move: string): number {
    return this.script.repetition?.[move] ?? 0;
  }
  resetsHalfmove(move: string): boolean {
    return this.script.resets?.[move] ?? false;
  }
  childFen(move: string): string | null {
    return `child-of-${move} w - - 0 1`;
  }
  nullFen(): string | null {
    return this.script.nullFen === undefined ? "null-position w - - 0 1" : this.script.nullFen;
  }
  applyMove(): boolean {
    return true;
  }
  newGame(): void {
    this.newGames += 1;
  }
  updatePlan(posture: string): PlanToken {
    this.plans.push(posture);
    return {
      active: true,
      posture,
      intent: `intent-${posture}`,
      target: "center",
      files: "c-f",
      levers: [],
      reserve: [],
      age: 0,
      expired: "",
    };
  }
  plan(): PlanToken {
    return this.updatePlan("Coil");
  }
  propose(mix: number[], k: number): Proposal[] {
    this.proposeCalls.push({ mix, k });
    return this.script.proposals ?? [];
  }
  searchStart(maxDepth: number, nodeCap: number): void {
    this.searchStarts.push({ maxDepth, nodeCap });
    this.stepsLeft = this.script.searchSteps ?? 3;
  }
  searchStep(): SearchStatus {
    this.stepsLeft -= 1;
    return { done: this.stepsLeft <= 0, depth: 3 - Math.max(0, this.stepsLeft), nodes: 1000 };
  }
  ownBestMove(): OwnBest | null {
    if (this.script.ownBest !== undefined) {
      return this.script.ownBest;
    }
    return { move: this.legalMoves()[0], cp: 12, mate: null, depth: 3 };
  }
}

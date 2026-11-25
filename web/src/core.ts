/**
 * The KAIROS core boundary.
 *
 * `KairosCore` is implemented by the Rust/WASM crate (`core-wasm.ts`) in the
 * browser and by scripted fakes in unit tests. The controller never reaches
 * past this interface: the core owns the board, legality, SEE, features, the
 * plan token, the candidate proposer and the own (fallback) search.
 */

export interface PositionStats {
  tension: number;
  ownKingAttackers: number;
  ownKingDefenders: number;
  enemyKingAttackers: number;
  enemyKingDefenders: number;
  phase: number;
  materialBalance: number;
}

export interface Features {
  /** Tension Index of the position before the move. */
  T: number;
  F_T: number;
  F_N: number;
  F_R: number;
  F_C: number;
  F_F: number;
  F_P: number;
  F_K: number;
  F_S: number;
  F_I: number;
  see?: number;
  capture?: boolean;
  givesCheck?: boolean;
}

export type ProposalClass =
  | "improve"
  | "reroute"
  | "shadow"
  | "lever"
  | "edge"
  | "check"
  | "pawn"
  | "release";

export interface Proposal {
  move: string;
  class: ProposalClass;
  score: number;
  /** Own shallow-search score in centipawns (side to move), if available. */
  ownCp: number | null;
  shadow: number;
  features: Features;
}

export interface PlanToken {
  active: boolean;
  posture: string;
  intent: string;
  target: string;
  files: string;
  levers: string[];
  reserve: string[];
  age: number;
  expired: string;
}

export interface OwnBest {
  move: string;
  cp: number;
  /** Signed mate distance in moves (positive: side to move mates), else null. */
  mate: number | null;
  depth: number;
}

export interface SearchStatus {
  done: boolean;
  depth: number;
  nodes: number;
}

export interface KairosCore {
  readonly kind: string;

  /** `position startpos|fen ... [moves ...]`. False when the line is illegal. */
  setPosition(command: string): boolean;
  lastError(): string;
  fen(): string;
  sideToMove(): "w" | "b";
  legalMoves(): string[];
  isLegal(move: string): boolean;
  inCheck(): boolean;
  halfmoveClock(): number;
  /** "", "checkmate", "stalemate", "draw-50", "draw-repetition" or "draw-material". */
  gameResult(): string;

  positionStats(): PositionStats;
  tensionIndex(): number;
  features(move: string): Features | null;
  forcingDensity(pv: string[]): number;
  /** Earlier occurrences of the position reached by `move`; -1 when illegal. */
  repetitionCount(move: string): number;
  resetsHalfmove(move: string): boolean;
  childFen(move: string): string | null;
  nullFen(): string | null;
  applyMove(move: string): boolean;
  newGame(): void;

  updatePlan(posture: string): PlanToken;
  plan(): PlanToken;
  /** KAIROS' own candidates; `mix` is ordered Coil, Strike, Absorb, Reverse, Distill, Fog. */
  propose(mix: number[], k: number, nodeBudget: number): Proposal[];

  searchStart(maxDepth: number, nodeCap: number): void;
  searchStep(nodeBudget: number): SearchStatus;
  ownBestMove(): OwnBest | null;
}

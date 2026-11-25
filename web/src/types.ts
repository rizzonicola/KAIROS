/** Shared controller types (kept free of runtime code so every module can import them). */

import type { Features, PlanToken } from "./core";
import type { Mix, Posture } from "./postures";

export interface EnginePort {
  send(line: string): void;
}

export type EngineMode = "stockfish" | "standalone";

export interface KairosOptions {
  style: number;
  posture: Posture | "Auto";
  variety: number;
  /** 0: only Stockfish's top moves are considered (v0.2 behaviour); 100: full KAIROS proposals. */
  independence: number;
  verbose: boolean;
  allowUnverifiedEngine: boolean;
  /** Start without Stockfish (own search only). */
  standalone: boolean;
}

export interface Rationale {
  kind: "rerank" | "fallback" | "stockfish" | "standalone";
  reason: string;
  posture: Posture;
  confidence: number;
  mix: Mix;
  /** Plan intent (hold-tension, press-king, ...). */
  plan: string;
  planToken?: PlanToken;
  budgetPct: number;
  /** Verified expected-score loss of the PLAYED move (0 for Stockfish's best). */
  lossPct: number;
  /** Measured loss of a KAIROS pick that failed verification (diagnostic only). */
  rejectedLossPct?: number;
  /** 1-based rank of the played move among the judged moves by expected score. */
  pick: number;
  sfBest: string;
  features?: Features;
  /** Moves KAIROS proposed from its own plan and features. */
  proposed: string[];
  /** Stockfish's baseline top moves (MultiPV 3). */
  sfTop3: string[];
  playedProposed: boolean;
  outsideTop3: boolean;
  independence: number;
  pressure?: { tension: number; narrowness: number | null };
}

export type ControllerEvent =
  | { type: "ready"; engine: string; mode: EngineMode }
  | { type: "mode"; mode: EngineMode; reason: string }
  | {
      type: "engine-info";
      depth: number;
      multipv: number;
      score: string;
      wdl?: [number, number, number];
      requestId?: number;
    }
  | {
      type: "bestmove";
      move: string;
      ponder?: string;
      rationale: Rationale;
      requestId?: number;
    }
  | { type: "log"; line: string }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "quit" };

export type UiCommand =
  | { type: "init"; options?: Partial<KairosOptions>; seed?: number; coreUrl?: string }
  | { type: "newgame" }
  | { type: "setoption"; name: string; value: string }
  | { type: "position"; command: string }
  | { type: "go"; command: string; requestId?: number }
  | { type: "stop" }
  | { type: "standalone"; reason?: string }
  | { type: "quit" };

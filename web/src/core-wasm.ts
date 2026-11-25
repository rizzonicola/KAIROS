/**
 * Rust/WASM implementation of `KairosCore` (the `kairos-core` crate built with
 * wasm-bindgen --target web into `./core/pkg`). The glue module is a build
 * artefact (see scripts/build_core.sh), not committed.
 */

import init, { Core, core_version } from "./core/pkg/kairos_core.js";
import type {
  Features,
  KairosCore,
  OwnBest,
  PlanToken,
  PositionStats,
  Proposal,
  SearchStatus,
} from "./core";

function splitMoves(text: string): string[] {
  return text === "" ? [] : text.split(" ");
}

export class WasmCore implements KairosCore {
  readonly kind = "rust-wasm";

  constructor(private readonly core: Core) {}

  setPosition(command: string): boolean {
    return this.core.set_position(command);
  }
  lastError(): string {
    return this.core.last_error();
  }
  fen(): string {
    return this.core.fen();
  }
  sideToMove(): "w" | "b" {
    return this.core.side_to_move() === "w" ? "w" : "b";
  }
  legalMoves(): string[] {
    return splitMoves(this.core.legal_moves());
  }
  isLegal(move: string): boolean {
    return this.core.is_legal(move);
  }
  inCheck(): boolean {
    return this.core.in_check();
  }
  halfmoveClock(): number {
    return this.core.halfmove_clock();
  }
  gameResult(): string {
    return this.core.game_result();
  }
  positionStats(): PositionStats {
    return JSON.parse(this.core.position_stats()) as PositionStats;
  }
  tensionIndex(): number {
    return this.core.tension_index();
  }
  features(move: string): Features | null {
    const text = this.core.features(move);
    return text === "null" ? null : (JSON.parse(text) as Features);
  }
  forcingDensity(pv: string[]): number {
    return this.core.forcing_density(pv.join(" "));
  }
  repetitionCount(move: string): number {
    return this.core.repetition_count(move);
  }
  resetsHalfmove(move: string): boolean {
    return this.core.resets_halfmove(move);
  }
  childFen(move: string): string | null {
    const text = this.core.child_fen(move);
    return text === "" ? null : text;
  }
  nullFen(): string | null {
    const text = this.core.null_fen();
    return text === "" ? null : text;
  }
  applyMove(move: string): boolean {
    return this.core.apply_move(move);
  }
  newGame(): void {
    this.core.new_game();
  }
  updatePlan(posture: string): PlanToken {
    return JSON.parse(this.core.update_plan(posture)) as PlanToken;
  }
  plan(): PlanToken {
    return JSON.parse(this.core.plan()) as PlanToken;
  }
  propose(mix: number[], k: number, nodeBudget: number): Proposal[] {
    return JSON.parse(this.core.propose(Float64Array.from(mix), k, nodeBudget)) as Proposal[];
  }
  searchStart(maxDepth: number, nodeCap: number): void {
    this.core.search_start(maxDepth, nodeCap);
  }
  searchStep(nodeBudget: number): SearchStatus {
    return JSON.parse(this.core.search_step(nodeBudget)) as SearchStatus;
  }
  ownBestMove(): OwnBest | null {
    const text = this.core.own_best_move();
    return text === "null" ? null : (JSON.parse(text) as OwnBest);
  }

  /** Conformance helpers (not part of KairosCore). */
  perft(depth: number): number {
    return this.core.perft(depth);
  }
  perftUci(depth: number): number {
    return this.core.perft_uci(depth);
  }
  version(): string {
    return core_version();
  }
}

/**
 * Download and instantiate the core. wasm-bindgen's glue streams the response
 * (`WebAssembly.instantiateStreaming`) and itself falls back to
 * `arrayBuffer()` when a server sends the wrong MIME type; if that still fails
 * we retry once from the raw bytes. Raw bytes may also be passed directly
 * (Node tests, where `fetch` cannot read file URLs).
 */
export async function loadWasmCore(source: string | ArrayBuffer | Uint8Array): Promise<WasmCore> {
  if (typeof source !== "string") {
    await init({ module_or_path: source });
    return new WasmCore(new Core());
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${source}`);
  }
  try {
    // VERIFY-API: wasm-bindgen 0.2.100 init({ module_or_path }) accepts a Response.
    await init({ module_or_path: response.clone() });
  } catch (streamingError) {
    const bytes = await response.arrayBuffer();
    try {
      await init({ module_or_path: bytes });
    } catch (secondError) {
      throw new Error(
        `could not instantiate ${source}: ${String(secondError)} (streaming: ${String(streamingError)})`,
      );
    }
  }
  return new WasmCore(new Core());
}

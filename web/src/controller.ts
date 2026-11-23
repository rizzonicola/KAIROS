import {
  boardFromPositionCommand,
  type Board,
  type Features,
} from "./chess-features";
import {
  POSTURES,
  PostureController,
  dominant,
  oneHot,
  planToken,
  type Mix,
  type Posture,
} from "./postures";

export const SATURATION_EXPECTED = 0.99;
export const HALFMOVE_ALERT = 90;

export type ScoreKind = "cp" | "mate";

export interface Candidate {
  multipv: number;
  depth: number;
  move: string;
  scoreKind: ScoreKind;
  scoreValue: number;
  wdl: [number, number, number];
  pv: string[];
}

/** Expected score from WDL, as the Python oracle computes it. */
export function expectedScore(candidate: Candidate): number {
  const [wins, draws] = candidate.wdl;
  return (wins + draws / 2.0) / 1000.0;
}

export function parseInfo(line: string): Candidate | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] !== "info") {
    return null;
  }
  const values: {
    multipv?: number;
    depth?: number;
    scoreKind?: string;
    scoreValue?: number;
    wdl?: [number, number, number];
    pv?: string[];
  } = {};
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (["depth", "seldepth", "multipv", "nodes", "nps", "hashfull", "tbhits", "time"].includes(token)) {
      if (i + 1 < tokens.length) {
        const value = Number(tokens[i + 1]);
        if (Number.isFinite(value)) {
          if (token === "multipv") {
            values.multipv = value;
          } else if (token === "depth") {
            values.depth = value;
          }
        }
      }
      i += 2;
      continue;
    }
    if (token === "score" && i + 2 < tokens.length) {
      // Bound scores are not exact evaluations; never rerank on them.
      if (i + 3 < tokens.length && (tokens[i + 3] === "lowerbound" || tokens[i + 3] === "upperbound")) {
        return null;
      }
      values.scoreKind = tokens[i + 1];
      const value = Number(tokens[i + 2]);
      if (Number.isFinite(value)) {
        values.scoreValue = value;
      }
      i += 3;
      continue;
    }
    if (token === "wdl" && i + 3 < tokens.length) {
      const wdl = tokens.slice(i + 1, i + 4).map(Number);
      if (wdl.every((value) => Number.isFinite(value))) {
        values.wdl = [wdl[0], wdl[1], wdl[2]];
      }
      i += 4;
      continue;
    }
    if (token === "pv") {
      values.pv = tokens.slice(i + 1);
      break;
    }
    i += 1;
  }

  const pv = values.pv;
  const wdl = values.wdl;
  if (!pv || pv.length === 0 || !wdl) {
    return null;
  }
  if (wdl.length !== 3 || wdl[0] + wdl[1] + wdl[2] <= 0) {
    return null;
  }
  if (values.depth === undefined || values.scoreKind === undefined || values.scoreValue === undefined) {
    return null;
  }
  return {
    multipv: values.multipv ?? 1,
    depth: values.depth,
    move: pv[0],
    scoreKind: values.scoreKind as ScoreKind,
    scoreValue: values.scoreValue,
    wdl,
    pv,
  };
}

/** Conservative prototype bands; thresholds are documented, not SF-defined. */
export function resultBand(expected: number): number {
  if (expected >= 0.55) {
    return 1;
  }
  if (expected <= 0.45) {
    return -1;
  }
  return 0;
}

export function isSaturated(expected: number): boolean {
  return expected >= SATURATION_EXPECTED || expected <= 1.0 - SATURATION_EXPECTED;
}

export interface SupportedSearch {
  supported: boolean;
  kind: "depth" | "movetime" | "";
  amount: number;
  reason: string;
}

function parseIntToken(raw: string | undefined): number | null {
  if (raw === undefined || !/^-?\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

/**
 * Only rerank searches with a bounded verification budget.
 *
 * Clock-based controls, ponder, infinite, node and perft searches stay exact
 * Stockfish passthroughs in this prototype.
 */
export function supportedPersonalitySearch(goLine: string): SupportedSearch {
  const tokens = goLine.trim().split(/\s+/).slice(1);
  const unsupported = (reason: string, amount = 0): SupportedSearch => ({
    supported: false,
    kind: "",
    amount,
    reason,
  });
  if (
    tokens.length === 0 ||
    ["infinite", "ponder", "perft", "nodes", "mate", "wtime", "btime", "winc", "binc", "movestogo"].some(
      (token) => tokens.includes(token),
    )
  ) {
    return unsupported("unsupported-or-clock-search");
  }
  if (tokens.filter((token) => token === "depth" || token === "movetime").length !== 1) {
    return unsupported("multiple-or-missing-limits");
  }
  if (tokens.includes("depth")) {
    const depth = parseIntToken(tokens[tokens.indexOf("depth") + 1]);
    if (depth === null || depth < 1) {
      return unsupported("invalid-depth");
    }
    return { supported: true, kind: "depth", amount: depth, reason: "supported" };
  }
  const movetime = parseIntToken(tokens[tokens.indexOf("movetime") + 1]);
  if (movetime === null) {
    return unsupported("invalid-movetime");
  }
  if (movetime < 1500) {
    return unsupported("time-too-low", movetime);
  }
  return { supported: true, kind: "movetime", amount: movetime, reason: "supported" };
}

/** Avoid a move that would create a third occurrence while better than a draw. */
export function repetitionBlocked(
  board: Board,
  move: string,
  counts: Map<string, number> | Record<string, number>,
  baselineExpected: number,
): boolean {
  if (baselineExpected <= 0.5) {
    return false;
  }
  let key: string;
  try {
    key = board.applyUci(move).positionKey();
  } catch {
    return false;
  }
  const count = counts instanceof Map ? (counts.get(key) ?? 0) : (counts[key] ?? 0);
  return count >= 2;
}

/** Avoid a non-resetting move near the 50-move draw while better than a draw. */
export function fiftyMoveBlocked(
  board: Board,
  move: string,
  baselineExpected: number,
): boolean {
  if (board.halfmove < HALFMOVE_ALERT || baselineExpected <= 0.5) {
    return false;
  }
  try {
    return !board.resetsHalfmove(move);
  } catch {
    return false;
  }
}

export interface EnginePort {
  send(line: string): void;
}

export interface KairosOptions {
  style: number;
  posture: Posture | "Auto";
  variety: number;
  verbose: boolean;
  allowUnverifiedEngine: boolean;
}

export interface Rationale {
  kind: "rerank" | "fallback" | "stockfish";
  reason: string;
  posture: Posture;
  confidence: number;
  mix: Mix;
  plan: string;
  budgetPct: number;
  lossPct: number;
  pick: number;
  sfBest: string;
  features?: Features;
}

export type ControllerEvent =
  | { type: "ready"; engine: string }
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
  | { type: "init"; options?: Partial<KairosOptions>; seed?: number }
  | { type: "newgame" }
  | { type: "setoption"; name: string; value: string }
  | { type: "position"; command: string }
  | { type: "go"; command: string; requestId?: number }
  | { type: "stop" }
  | { type: "quit" };

interface SearchState {
  mode: "passthrough" | "personality";
  goLine: string;
  position: string;
  reason: string;
  requestId?: number;
  stopRequested: boolean;
}

interface EngineInfo {
  depth: number;
  multipv: number;
  score: string;
  wdl?: [number, number, number];
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function engineInfoFromLine(line: string): EngineInfo | null {
  const tokens = line.trim().split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let score: string | null = null;
  let wdl: [number, number, number] | undefined;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "depth" && /^\d+$/.test(tokens[index + 1] ?? "")) {
      depth = Number(tokens[index + 1]);
      index += 1;
    } else if (token === "multipv" && /^\d+$/.test(tokens[index + 1] ?? "")) {
      multipv = Number(tokens[index + 1]);
      index += 1;
    } else if (token === "score" && index + 2 < tokens.length) {
      score = `${tokens[index + 1]} ${tokens[index + 2]}`;
      index += 2;
    } else if (token === "wdl" && index + 3 < tokens.length) {
      const values = tokens.slice(index + 1, index + 4).map(Number);
      if (values.every((value) => Number.isFinite(value))) {
        wdl = [values[0], values[1], values[2]];
      }
      index += 3;
    }
  }
  if (score === null) {
    return null;
  }
  return { depth, multipv, score, wdl };
}

export class KairosController {
  private readonly port: EnginePort;
  private readonly emit: (event: ControllerEvent) => void;

  private options: KairosOptions = {
    style: 50,
    posture: "Auto",
    variety: 0,
    verbose: false,
    allowUnverifiedEngine: false,
  };
  private seed = 0;
  private engineId = "";
  private engineOptions = new Set<string>();
  private waitingUci = false;
  private waitingReady = false;
  private ready = false;
  private running = true;
  private handshakeBuffer: UiCommand[] = [];
  private deferred: UiCommand[] = [];
  private quitAfterSearch = false;
  private positionLine = "position startpos";
  private search: SearchState | null = null;
  private readonly posture = new PostureController();

  constructor(port: EnginePort, emit: (event: ControllerEvent) => void) {
    this.port = port;
    this.emit = emit;
  }

  handleCommand(command: UiCommand): void {
    if (!this.running) {
      return;
    }
    if (command.type === "init") {
      this.options = this.sanitizeOptions(command.options ?? {});
      this.seed = command.seed ?? 0;
      this.engineId = "";
      this.engineOptions = new Set();
      this.ready = false;
      this.waitingReady = false;
      this.waitingUci = true;
      this.handshakeBuffer = [];
      this.port.send("uci");
      return;
    }
    if (command.type === "quit") {
      this.handleQuit();
      return;
    }
    if (!this.ready) {
      this.handshakeBuffer.push(command);
      return;
    }
    switch (command.type) {
      case "newgame":
        if (this.search) {
          this.deferred.push(command);
          this.requestStop();
          return;
        }
        this.handleNewgame();
        return;
      case "setoption":
        this.handleSetoption(command.name, command.value);
        return;
      case "position":
        if (this.search) {
          this.deferred.push(command);
          this.requestStop();
          return;
        }
        this.positionLine = command.command;
        this.port.send(command.command);
        return;
      case "go":
        if (this.search) {
          this.deferred.push(command);
          this.requestStop();
          return;
        }
        this.startSearch(command.command, command.requestId);
        return;
      case "stop":
        this.requestStop();
        return;
    }
  }

  handleEngineLine(line: string): void {
    if (this.waitingUci) {
      if (line.startsWith("id name ")) {
        this.engineId = line.slice("id name ".length).trim();
        return;
      }
      if (line.startsWith("option name ")) {
        const match = /^option name (.+?) type /.exec(line);
        if (match) {
          this.engineOptions.add(match[1]);
        }
        return;
      }
      if (line === "uciok") {
        this.finishHandshake();
      }
      return;
    }
    if (this.waitingReady) {
      if (line === "readyok") {
        this.waitingReady = false;
        this.ready = true;
        this.emit({ type: "ready", engine: this.engineId });
        const pending = this.handshakeBuffer;
        this.handshakeBuffer = [];
        for (const command of pending) {
          this.handleCommand(command);
        }
      }
      return;
    }
    if (line.startsWith("bestmove")) {
      this.handleBestmove(line);
      return;
    }
    if (line.startsWith("info ")) {
      const info = engineInfoFromLine(line);
      if (info) {
        this.emit({
          type: "engine-info",
          depth: info.depth,
          multipv: info.multipv,
          score: info.score,
          wdl: info.wdl,
          requestId: this.search?.requestId,
        });
      } else if (this.options.verbose) {
        this.emit({ type: "log", line });
      }
      return;
    }
    if (line === "readyok") {
      return;
    }
    if (this.options.verbose) {
      this.emit({ type: "log", line });
    }
  }

  private sanitizeOptions(partial: Partial<KairosOptions>): KairosOptions {
    const options = { ...this.options, ...partial };
    options.style = Number.isFinite(options.style)
      ? clamp(Math.trunc(options.style), 0, 100)
      : this.options.style;
    options.variety = Number.isFinite(options.variety)
      ? clamp(Math.trunc(options.variety), 0, 100)
      : this.options.variety;
    if (
      options.posture !== "Auto" &&
      !POSTURES.includes(options.posture as Posture)
    ) {
      options.posture = "Auto";
    }
    return options;
  }

  private finishHandshake(): void {
    this.waitingUci = false;
    if (
      !this.options.allowUnverifiedEngine &&
      !this.engineId.includes("Stockfish 19")
    ) {
      this.emit({
        type: "error",
        message:
          "KAIROS startup refused: expected Stockfish 19 (sf_19), backend reported " +
          `'${this.engineId || "no id name"}'`,
        recoverable: false,
      });
      this.handshakeBuffer = [];
      this.running = false;
      return;
    }
    const forced: [string, string][] = [
      ["Threads", "1"],
      ["Hash", "32"],
      ["MultiPV", "1"],
      ["UCI_ShowWDL", "true"],
    ];
    for (const [name, value] of forced) {
      if (this.engineOptions.has(name)) {
        this.port.send(`setoption name ${name} value ${value}`);
      }
    }
    if (this.options.posture !== "Auto") {
      this.posture.mix = oneHot(this.options.posture);
    }
    this.waitingReady = true;
    this.port.send("isready");
  }

  private handleNewgame(): void {
    this.posture.reset();
    if (this.options.posture !== "Auto") {
      this.posture.mix = oneHot(this.options.posture);
    }
    this.port.send("ucinewgame");
  }

  private handleSetoption(name: string, value: string): void {
    const lowered = name.toLowerCase();
    if (lowered === "kairosstyle") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        this.options.style = clamp(parsed, 0, 100);
      } else if (this.options.verbose) {
        this.emit({ type: "log", line: `ignored invalid KairosStyle=${value}` });
      }
      return;
    }
    if (lowered === "kairosverbose") {
      this.options.verbose = ["true", "1", "yes"].includes(value.toLowerCase());
      return;
    }
    if (lowered === "kairosposture") {
      if (value.toLowerCase() === "auto") {
        this.options.posture = "Auto";
        return;
      }
      const posture = POSTURES.find(
        (item) => item.toLowerCase() === value.toLowerCase(),
      );
      if (posture) {
        this.options.posture = posture;
        this.posture.mix = oneHot(posture);
      } else if (this.options.verbose) {
        this.emit({ type: "log", line: `ignored invalid KairosPosture=${value}` });
      }
      return;
    }
    if (lowered === "kairosvariety") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        this.options.variety = clamp(parsed, 0, 100);
      } else if (this.options.verbose) {
        this.emit({ type: "log", line: `ignored invalid KairosVariety=${value}` });
      }
      return;
    }
    if (lowered === "threads") {
      this.port.send("setoption name Threads value 1");
      return;
    }
    if (lowered === "multipv") {
      return;
    }
    if (lowered === "uci_showwdl") {
      if (this.engineOptions.has("UCI_ShowWDL")) {
        this.port.send("setoption name UCI_ShowWDL value true");
      }
      return;
    }
    const line = `setoption name ${name} value ${value}`.trimEnd();
    if (this.search) {
      this.deferred.push({ type: "setoption", name, value });
      this.requestStop();
      return;
    }
    this.port.send(line);
  }

  private startSearch(goLine: string, requestId?: number): void {
    this.port.send("setoption name MultiPV value 1");
    let reason = "";
    if (this.options.style === 0) {
      reason = "style-zero";
    } else {
      const supported = supportedPersonalitySearch(goLine);
      if (!supported.supported) {
        reason = supported.reason;
      }
    }
    if (!reason) {
      // shortcut: the personality pipeline lands in Task 7; until then a
      // supported search is a Stockfish passthrough.
      reason = "personality-not-implemented";
    }
    this.search = {
      mode: "passthrough",
      goLine,
      position: this.positionLine,
      reason,
      requestId,
      stopRequested: false,
    };
    this.port.send(goLine);
  }

  private requestStop(): void {
    if (this.search && !this.search.stopRequested) {
      this.search.stopRequested = true;
      this.port.send("stop");
    }
  }

  private handleBestmove(line: string): void {
    const search = this.search;
    if (!search) {
      return;
    }
    const tokens = line.trim().split(/\s+/);
    const move = tokens[1] ?? "";
    const ponderIndex = tokens.indexOf("ponder");
    const ponder =
      ponderIndex > 0 && ponderIndex + 1 < tokens.length
        ? tokens[ponderIndex + 1]
        : undefined;
    this.search = null;
    if (!move || move === "(none)") {
      this.emit({
        type: "error",
        message: "engine returned no move",
        recoverable: true,
      });
      this.finishSearch();
      return;
    }
    this.emit({
      type: "bestmove",
      move,
      ponder,
      rationale: this.stockfishRationale(search.reason, move),
      requestId: search.requestId,
    });
    this.finishSearch();
  }

  private stockfishRationale(reason: string, move: string): Rationale {
    const mix = this.posture.mix;
    const posture = dominant(mix);
    return {
      kind: "stockfish",
      reason,
      posture,
      confidence: mix[posture],
      mix,
      plan: planToken(posture),
      budgetPct: 0,
      lossPct: 0,
      pick: 1,
      sfBest: move,
    };
  }

  private finishSearch(): void {
    this.port.send("setoption name MultiPV value 1");
    if (this.quitAfterSearch) {
      this.quitAfterSearch = false;
      this.port.send("quit");
      this.emit({ type: "quit" });
      this.running = false;
      return;
    }
    while (this.search === null && this.deferred.length > 0 && this.running) {
      const command = this.deferred.shift();
      if (command) {
        this.handleCommand(command);
      }
    }
  }

  private handleQuit(): void {
    if (this.search) {
      this.quitAfterSearch = true;
      this.requestStop();
      return;
    }
    this.port.send("quit");
    this.emit({ type: "quit" });
    this.running = false;
  }
}

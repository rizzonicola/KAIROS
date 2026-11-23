import {
  boardFromPositionCommand,
  candidateFeatures,
  positionStats,
  type Board,
  type Features,
} from "./chess-features";
import {
  POSTURES,
  PostureController,
  dominant,
  evidenceFromStats,
  inferMix,
  mulberry32,
  oneHot,
  planToken,
  positionClass,
  sampleIndex,
  updateFragility,
  varietyTemperature,
  weightedFeatures,
  type Evidence,
  type Mix,
  type Posture,
} from "./postures";

export const SATURATION_EXPECTED = 0.99;
export const HALFMOVE_ALERT = 90;
const SATURATION_CP_MARGIN = 50;
const DISTILL_SKIP_EXPECTED = 0.90;
const BUDGET_WINDOW = 10;
const BUDGET_MULTIPLIER = 2.5;

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
  goKind: "depth" | "movetime" | "";
  originalMovetimeMs: number;
  mainDepth: number;
  verifyMovetimeMs: number;
  phase: "main" | "probe" | "verify";
  mateSeen: boolean;
  verifyMateSeen: boolean;
  candidates: Map<number, Candidate>;
  verifyCandidates: Map<number, Candidate>;
  sfBest: string;
  sfBestLine: string;
  selected: Candidate | null;
  selectedFeatures: Features | null;
  budgetPct: number;
  selectedLossPct: number;
  postureMix: Mix;
  posture: Posture;
  plan: string;
  confidence: number;
  scored: Scored[];
  probeMoves: string[];
  probeIndex: number;
  probeRecords: Map<number, Candidate>;
  probeResults: Map<string, ProbeRecord>;
  probeMateSeen: boolean;
  probeDepth: number;
  probeMovetimeMs: number;
  probeBudgetMs: number;
  nullThreat: number | null;
}

interface ProbeRecord {
  best: number;
  second: number | null;
  replies: number[];
}

interface Scored {
  score: number;
  candidate: Candidate;
  features: Features;
  lossPct: number;
}

type Eligible = [Candidate, Features, number];

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
  private expectedHistory: number[] = [];
  private fragilityByClass = new Map<string, number>();
  private pendingExpectation: number | null = null;
  private pendingClass: string | null = null;
  private positionCounts = new Map<string, number>();
  private lastPositionLine: string | null = null;
  private spentHistory: number[] = [];
  private rng: () => number = mulberry32(0);

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
      this.rng = mulberry32(this.seed);
      this.engineId = "";
      this.engineOptions = new Set();
      this.ready = false;
      this.waitingReady = false;
      this.waitingUci = true;
      this.handshakeBuffer = [];
      this.search = null;
      this.deferred = [];
      this.quitAfterSearch = false;
      this.positionLine = "position startpos";
      this.posture.reset();
      this.expectedHistory = [];
      this.fragilityByClass = new Map();
      this.pendingExpectation = null;
      this.pendingClass = null;
      this.positionCounts = new Map();
      this.lastPositionLine = null;
      this.spentHistory = [];
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
        this.positionLine = command.command;
        this.trackPositions(command.command);
        if (this.search) {
          this.deferred.push(command);
          this.requestStop();
          return;
        }
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
      this.handleInfo(line);
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
    this.expectedHistory = [];
    this.fragilityByClass = new Map();
    this.pendingExpectation = null;
    this.pendingClass = null;
    this.positionCounts = new Map();
    this.lastPositionLine = null;
    this.spentHistory = [];
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

  private createSearch(
    mode: "passthrough" | "personality",
    goLine: string,
    reason: string,
    requestId?: number,
  ): SearchState {
    return {
      mode,
      goLine,
      position: this.positionLine,
      reason,
      requestId,
      stopRequested: false,
      goKind: "",
      originalMovetimeMs: 0,
      mainDepth: 0,
      verifyMovetimeMs: 0,
      phase: "main",
      mateSeen: false,
      verifyMateSeen: false,
      candidates: new Map(),
      verifyCandidates: new Map(),
      sfBest: "",
      sfBestLine: "",
      selected: null,
      selectedFeatures: null,
      budgetPct: 0,
      selectedLossPct: 0,
      postureMix: oneHot("Coil"),
      posture: "Coil",
      plan: "",
      confidence: 0,
      scored: [],
      probeMoves: [],
      probeIndex: 0,
      probeRecords: new Map(),
      probeResults: new Map(),
      probeMateSeen: false,
      probeDepth: 0,
      probeMovetimeMs: 0,
      probeBudgetMs: 0,
      nullThreat: null,
    };
  }

  private startSearch(goLine: string, requestId?: number): void {
    this.port.send("setoption name MultiPV value 1");
    if (this.options.style === 0) {
      this.search = this.createSearch("passthrough", goLine, "style-zero", requestId);
      this.port.send(goLine);
      return;
    }
    const supported = supportedPersonalitySearch(goLine);
    if (!supported.supported) {
      this.search = this.createSearch(
        "passthrough",
        goLine,
        supported.reason,
        requestId,
      );
      this.port.send(goLine);
      return;
    }
    this.port.send("setoption name MultiPV value 5");
    const search = this.createSearch(
      "personality",
      goLine,
      "personality",
      requestId,
    );
    let modifiedGo = goLine;
    if (supported.kind === "depth") {
      search.goKind = "depth";
      search.mainDepth = supported.amount;
    } else {
      search.goKind = "movetime";
      search.originalMovetimeMs = supported.amount;
      const mainShare = supported.amount >= 3000 ? 0.65 : 0.75;
      const mainMovetime = Math.max(100, Math.trunc(supported.amount * mainShare));
      search.verifyMovetimeMs = Math.max(
        50,
        Math.trunc(supported.amount * 0.10),
      );
      modifiedGo = goLine.replace(
        /\bmovetime\s+\d+/,
        `movetime ${mainMovetime}`,
      );
    }
    this.search = search;
    this.port.send(modifiedGo);
  }

  private handleInfo(line: string): void {
    const search = this.search;
    if (search && search.mode === "personality") {
      const tokens = line.split(/\s+/);
      const scoreIndex = tokens.indexOf("score");
      if (scoreIndex !== -1 && tokens[scoreIndex + 1] === "mate") {
        if (search.phase === "main") {
          search.mateSeen = true;
        } else if (search.phase === "probe") {
          search.probeMateSeen = true;
        } else {
          search.verifyMateSeen = true;
        }
      }
      const candidate = parseInfo(line);
      if (candidate !== null) {
        const target =
          search.phase === "main"
            ? search.candidates
            : search.phase === "probe"
              ? search.probeRecords
              : search.verifyCandidates;
        const previous = target.get(candidate.multipv);
        if (previous === undefined || candidate.depth >= previous.depth) {
          target.set(candidate.multipv, candidate);
        }
      }
      if (search.phase === "probe" || search.phase === "verify") {
        // Internal probe and verification scores must not reach the UI.
        return;
      }
    }
    const info = engineInfoFromLine(line);
    if (info) {
      this.emit({
        type: "engine-info",
        depth: info.depth,
        multipv: info.multipv,
        score: info.score,
        wdl: info.wdl,
        requestId: search?.requestId,
      });
    } else if (this.options.verbose) {
      this.emit({ type: "log", line });
    }
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
    if (search.mode === "personality" && search.phase === "main") {
      this.finishMain(line);
      return;
    }
    if (search.phase === "probe") {
      this.finishProbe();
      return;
    }
    if (search.phase === "verify") {
      this.finishVerification();
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

  private finishMain(bestmoveLine: string): void {
    const search = this.search;
    if (!search) {
      return;
    }
    const tokens = bestmoveLine.trim().split(/\s+/);
    search.sfBest = tokens[1] ?? "";
    search.sfBestLine = bestmoveLine;
    this.spentHistory.push(0);
    this.spentHistory = this.spentHistory.slice(-BUDGET_WINDOW);
    if (search.stopRequested) {
      this.emitFallback(search, "stopped-during-main");
      return;
    }
    if (
      search.mateSeen ||
      [...search.candidates.values()].some(
        (candidate) => candidate.scoreKind === "mate",
      )
    ) {
      this.emitFallback(search, "mate-score");
      return;
    }
    const baseline = [...search.candidates.values()].find(
      (candidate) => candidate.move === search.sfBest,
    );
    if (baseline) {
      this.updatePosture(search, baseline);
    }
    if (
      dominant(this.posture.mix) === "Distill" &&
      baseline !== undefined &&
      expectedScore(baseline) >= DISTILL_SKIP_EXPECTED
    ) {
      this.emitFallback(search, "distill-conversion");
      return;
    }
    const mix = this.posture.mix;
    search.postureMix = { ...mix };
    search.posture = dominant(mix);
    search.plan = planToken(search.posture);
    search.confidence = Math.max(...POSTURES.map((name) => mix[name]));
    const [eligible, budgetPct] = this.eligibleCandidates(search);
    if (eligible.length === 0) {
      this.emitFallback(search, "no-eligible-rerank");
      return;
    }
    search.budgetPct = budgetPct;
    search.scored = this.scoreCandidates(search, eligible);
    if (this.probesEnabled(search) && this.startProbes(search)) {
      return;
    }
    this.finishScoring(search);
  }

  private updatePosture(search: SearchState, baseline: Candidate): void {
    const board = boardFromPositionCommand(search.position);
    const stats = positionStats(board);
    const expected = expectedScore(baseline);
    const forcing = board ? board.forcingDensity(baseline.pv) : 0;
    const currentClass = positionClass(stats, expected, forcing);
    if (this.pendingExpectation !== null && this.pendingClass !== null) {
      // Previous PV expectation versus this search's expectation.
      const observed = expected - this.pendingExpectation;
      const previous = this.fragilityByClass.get(this.pendingClass) ?? 0;
      this.fragilityByClass.set(
        this.pendingClass,
        updateFragility(previous, observed),
      );
    }
    const fragility = this.fragilityByClass.get(currentClass) ?? 0;
    const evidence: Evidence = evidenceFromStats(
      stats,
      expected,
      this.expectedHistory,
      forcing,
      fragility,
    );
    const forced =
      this.options.posture === "Auto" ? null : this.options.posture;
    this.posture.update(inferMix(evidence), evidence, forced);
    this.expectedHistory.push(expected);
    this.expectedHistory = this.expectedHistory.slice(-3);
    this.pendingExpectation = expected;
    this.pendingClass = currentClass;
  }

  /** Apply the corridor, result band and saturation guards. */
  private eligibleCandidates(search: SearchState): [Eligible[], number] {
    const all = [...search.candidates.values()];
    if (all.length === 0) {
      return [[], 0];
    }
    // Only compare candidates from the same completed depth as SF's best.
    const baseline = all.find((candidate) => candidate.move === search.sfBest);
    if (!baseline) {
      return [[], 0];
    }
    const candidates = all.filter(
      (candidate) => candidate.depth === baseline.depth,
    );
    if (
      candidates.length < 2 ||
      candidates.some((candidate) => candidate.scoreKind === "mate")
    ) {
      return [[], 0];
    }
    const baselineExpected = expectedScore(baseline);
    const saturated = isSaturated(baselineExpected);
    const singleBudget = (1.5 * this.options.style) / 100.0;
    const spent = this.spentHistory
      .slice(-BUDGET_WINDOW)
      .reduce((sum, value) => sum + value, 0);
    const budgetPct = Math.min(
      singleBudget,
      Math.max(0, BUDGET_MULTIPLIER * singleBudget - spent),
    );
    if (budgetPct <= 0) {
      return [[], 0];
    }
    const board = boardFromPositionCommand(search.position);
    const eligible: Eligible[] = [];
    for (const candidate of candidates) {
      const candidateExpected = expectedScore(candidate);
      const lossPct = Math.max(
        0,
        (baselineExpected - candidateExpected) * 100,
      );
      if (lossPct > budgetPct + 1e-9) {
        continue;
      }
      if (
        resultBand(candidateExpected) < resultBand(baselineExpected)
      ) {
        continue;
      }
      if (saturated) {
        // WDL saturates at 1000/0, hiding real centipawn losses.
        if (
          baseline.scoreKind !== "cp" ||
          candidate.scoreKind !== "cp" ||
          candidate.scoreValue <
            baseline.scoreValue - SATURATION_CP_MARGIN
        ) {
          continue;
        }
      }
      if (board && candidate.move !== search.sfBest) {
        if (
          repetitionBlocked(
            board,
            candidate.move,
            this.positionCounts,
            baselineExpected,
          )
        ) {
          continue;
        }
        if (fiftyMoveBlocked(board, candidate.move, baselineExpected)) {
          continue;
        }
      }
      eligible.push([
        candidate,
        candidateFeatures(board, candidate.move),
        lossPct,
      ]);
    }
    return [eligible, budgetPct];
  }

  private scoreCandidates(
    search: SearchState,
    eligible: Eligible[],
  ): Scored[] {
    const styleScale = this.options.style / 100.0;
    const scored = eligible.map(([candidate, features, lossPct]) => {
      const measured = {
        ...features,
        ...this.probeFeatures(search, candidate.move),
      };
      // One weight unit is roughly 0.1% expected score; the loss term stays
      // in percentage points and remains dominant.
      const personalityPct =
        styleScale * 0.1 * weightedFeatures(search.postureMix, measured);
      return {
        score: -lossPct + personalityPct,
        candidate,
        features: measured,
        lossPct,
      };
    });
    scored.sort(
      (a, b) =>
        b.score - a.score || a.candidate.multipv - b.candidate.multipv,
    );
    return scored;
  }

  /** Measured narrowness and prophylaxis; neutral when a probe is missing. */
  private probeFeatures(
    search: SearchState,
    move: string,
  ): Partial<Features> {
    const record = search.probeResults.get(move);
    if (!record || record.replies.length === 0) {
      return {};
    }
    const best = record.best;
    const near =
      record.replies.filter((value) => value >= best - 0.05).length /
      record.replies.length;
    const second = record.second;
    const bonus = second !== null && best - second > 0.10 ? 0.5 : 0.0;
    const narrowness = clamp(1.0 - near + bonus, -1.0, 1.0);
    let prophylaxis = 0.0;
    if (search.nullThreat !== null) {
      prophylaxis = clamp((search.nullThreat - best) / 0.20, -1.0, 1.0);
    }
    return { F_N: narrowness, F_P: prophylaxis };
  }

  private probesEnabled(search: SearchState): boolean {
    if (search.goKind === "depth") {
      return search.mainDepth >= 6;
    }
    return search.originalMovetimeMs >= 3000;
  }

  private startProbes(search: SearchState): boolean {
    const board = boardFromPositionCommand(search.position);
    if (!board || search.scored.length === 0) {
      return false;
    }
    let moves = search.scored
      .slice(0, 4)
      .map((item) => item.candidate.move);
    if (!moves.includes(search.sfBest)) {
      moves =
        moves.length >= 4
          ? [...moves.slice(0, 3), search.sfBest]
          : [...moves, search.sfBest];
    }
    const labels: string[] = [];
    if (board.nullMoveFen() !== null) {
      labels.push("null");
    }
    labels.push(...moves);
    if (labels.length === 0) {
      return false;
    }
    search.probeMoves = labels;
    search.probeIndex = 0;
    search.phase = "probe";
    if (search.goKind === "depth") {
      search.probeDepth = Math.max(1, search.mainDepth - 3);
    } else {
      search.probeBudgetMs = Math.max(
        25,
        Math.trunc(search.originalMovetimeMs * 0.25),
      );
      search.probeMovetimeMs = Math.max(
        25,
        Math.trunc(search.probeBudgetMs / labels.length),
      );
    }
    this.sendProbe(search);
    return true;
  }

  private sendProbe(search: SearchState): void {
    const label = search.probeMoves[search.probeIndex];
    search.probeRecords = new Map();
    const board = boardFromPositionCommand(search.position);
    if (!board) {
      this.finishProbes(search);
      return;
    }
    let position: string;
    let multipv: number;
    if (label === "null") {
      const nullFen = board.nullMoveFen();
      if (nullFen === null) {
        this.advanceProbe(search);
        return;
      }
      position = `position fen ${nullFen}`;
      multipv = 1;
    } else {
      let child: Board;
      try {
        child = board.applyUci(label);
      } catch {
        this.advanceProbe(search);
        return;
      }
      position = `position fen ${child.toFen()}`;
      multipv = 3;
    }
    const go =
      search.goKind === "depth"
        ? `go depth ${search.probeDepth}`
        : `go movetime ${search.probeMovetimeMs}`;
    this.port.send(`setoption name MultiPV value ${multipv}`);
    this.port.send(position);
    this.port.send(go);
  }

  private advanceProbe(search: SearchState): void {
    search.probeIndex += 1;
    if (search.probeIndex < search.probeMoves.length) {
      this.sendProbe(search);
    } else {
      this.finishProbes(search);
    }
  }

  private finishProbe(): void {
    const search = this.search;
    if (!search) {
      return;
    }
    const label = search.probeMoves[search.probeIndex];
    let records = [...search.probeRecords.values()];
    if (records.length > 0) {
      const deepest = Math.max(...records.map((record) => record.depth));
      records = records.filter((record) => record.depth === deepest);
    }
    if (records.some((record) => record.scoreKind === "mate")) {
      search.probeMateSeen = true;
    }
    if (records.length > 0 && !search.probeMateSeen) {
      const expected = records
        .map((record) => expectedScore(record))
        .sort((a, b) => b - a);
      if (label === "null") {
        search.nullThreat = expected[0];
      } else {
        search.probeResults.set(label, {
          best: expected[0],
          second: expected.length > 1 ? expected[1] : null,
          replies: expected,
        });
      }
    }
    if (search.stopRequested) {
      this.emitFallback(search, "stopped-during-probe");
      return;
    }
    this.advanceProbe(search);
  }

  private finishProbes(search: SearchState): void {
    if (search.stopRequested || search.probeMateSeen) {
      this.emitFallback(search, "probe-uncertainty");
      return;
    }
    const eligible: Eligible[] = search.scored.map((item) => [
      item.candidate,
      item.features,
      item.lossPct,
    ]);
    search.scored = this.scoreCandidates(search, eligible);
    this.finishScoring(search);
  }

  private finishScoring(search: SearchState): void {
    if (search.scored.length === 0) {
      this.emitFallback(search, "no-eligible-rerank");
      return;
    }
    const forced = this.options.posture !== "Auto";
    const tau = varietyTemperature(
      this.options.variety,
      search.posture,
      forced,
    );
    let picked: Scored;
    if (tau > 0) {
      const index = sampleIndex(
        search.scored.map((item) => item.score),
        tau,
        this.rng,
      );
      picked = search.scored[index];
    } else {
      picked = search.scored[0];
    }
    const baseline = search.scored.find(
      (item) => item.candidate.move === search.sfBest,
    );
    // Deterministic mode requires a strict personality advantage; ties stay
    // with Stockfish. Sampled picks still pass through verification below.
    if (picked.candidate.move === search.sfBest || !baseline) {
      this.emitFallback(search, "no-eligible-rerank");
      return;
    }
    if (tau <= 0 && picked.score <= baseline.score + 1e-12) {
      this.emitFallback(search, "no-eligible-rerank");
      return;
    }
    search.selected = picked.candidate;
    search.selectedFeatures = picked.features;
    search.selectedLossPct = picked.lossPct;
    search.phase = "verify";
    let verifyGo: string;
    if (search.goKind === "depth") {
      verifyGo =
        `go depth ${search.mainDepth + 2} searchmoves ` +
        `${search.sfBest} ${picked.candidate.move}`;
    } else {
      const verifyMs =
        search.verifyMovetimeMs ||
        Math.max(50, Math.trunc(search.originalMovetimeMs * 0.10));
      verifyGo =
        `go movetime ${verifyMs} searchmoves ` +
        `${search.sfBest} ${picked.candidate.move}`;
    }
    this.port.send("setoption name MultiPV value 2");
    this.port.send(search.position);
    this.port.send(verifyGo);
  }

  private finishVerification(): void {
    const search = this.search;
    if (!search) {
      return;
    }
    const picked = search.selected;
    let accepted = false;
    let verifiedLoss = Number.POSITIVE_INFINITY;
    let reason = "missing-verification-data";
    if (search.verifyMateSeen) {
      reason = "mate-guard";
    } else if (search.stopRequested) {
      reason = "stopped-during-verification";
    } else if (picked) {
      const records = [...search.verifyCandidates.values()];
      const byMove = new Map(
        records.map((record) => [record.move, record]),
      );
      const sfRecord = byMove.get(search.sfBest);
      const candidateRecord = byMove.get(picked.move);
      if (sfRecord && candidateRecord) {
        if (sfRecord.depth !== candidateRecord.depth) {
          reason = "verification-depth-mismatch";
        } else if (
          sfRecord.scoreKind === "mate" ||
          candidateRecord.scoreKind === "mate"
        ) {
          reason = "mate-guard";
        } else {
          verifiedLoss = Math.max(
            0,
            (expectedScore(sfRecord) - expectedScore(candidateRecord)) * 100,
          );
          const sameBand =
            resultBand(expectedScore(candidateRecord)) >=
            resultBand(expectedScore(sfRecord));
          accepted = verifiedLoss <= search.budgetPct + 1e-9 && sameBand;
          if (accepted && isSaturated(expectedScore(sfRecord))) {
            // Same saturation guard as the main corridor, applied to the
            // verifier's own WDL/cp records.
            if (
              sfRecord.scoreKind !== "cp" ||
              candidateRecord.scoreKind !== "cp" ||
              candidateRecord.scoreValue <
                sfRecord.scoreValue - SATURATION_CP_MARGIN
            ) {
              accepted = false;
              reason = "saturated-score-margin";
            }
          }
          if (accepted) {
            reason = "verified";
          } else if (reason !== "saturated-score-margin") {
            reason = "verification-outside-corridor-or-result-band";
          }
        }
      } else {
        reason = "candidate-or-baseline-not-returned-by-verifier";
      }
    }
    if (accepted && picked) {
      if (this.spentHistory.length > 0) {
        this.spentHistory[this.spentHistory.length - 1] = verifiedLoss;
      }
      this.search = null;
      this.emit({
        type: "bestmove",
        move: picked.move,
        rationale: {
          kind: "rerank",
          reason: "verified",
          posture: search.posture,
          confidence: search.confidence,
          mix: search.postureMix,
          plan: search.plan,
          budgetPct: search.budgetPct,
          lossPct: verifiedLoss,
          pick: picked.multipv,
          sfBest: search.sfBest,
          features: search.selectedFeatures ?? undefined,
        },
        requestId: search.requestId,
      });
      this.finishSearch();
      return;
    }
    this.emitFallback(search, reason);
  }

  private emitFallback(search: SearchState, reason: string): void {
    this.search = null;
    if (!search.sfBest) {
      this.emit({
        type: "error",
        message: "engine returned no move",
        recoverable: true,
      });
      this.finishSearch();
      return;
    }
    const tokens = search.sfBestLine.split(/\s+/);
    const ponderIndex = tokens.indexOf("ponder");
    const ponder =
      ponderIndex > 0 && ponderIndex + 1 < tokens.length
        ? tokens[ponderIndex + 1]
        : undefined;
    const mix =
      search.confidence > 0 ? search.postureMix : this.posture.mix;
    const posture =
      search.confidence > 0 ? search.posture : dominant(mix);
    this.emit({
      type: "bestmove",
      move: search.sfBest,
      ponder,
      rationale: {
        kind: "fallback",
        reason,
        posture,
        confidence: search.confidence > 0 ? search.confidence : mix[posture],
        mix,
        plan: search.plan || planToken(posture),
        budgetPct: search.budgetPct,
        lossPct: 0,
        pick: search.selected?.multipv ?? 0,
        sfBest: search.sfBest,
        features: search.selectedFeatures ?? undefined,
      },
      requestId: search.requestId,
    });
    this.finishSearch();
  }

  private trackPositions(line: string): void {
    if (line === this.lastPositionLine) {
      return;
    }
    this.lastPositionLine = line;
    const tokens = line.split(/\s+/);
    const movesIndex = tokens.indexOf("moves");
    if (movesIndex === -1) {
      const board = boardFromPositionCommand(line);
      if (board) {
        const key = board.positionKey();
        this.positionCounts.set(key, (this.positionCounts.get(key) ?? 0) + 1);
      }
      return;
    }
    let board = boardFromPositionCommand(
      tokens.slice(0, movesIndex).join(" "),
    );
    if (!board) {
      return;
    }
    this.positionCounts = new Map();
    const startKey = board.positionKey();
    this.positionCounts.set(startKey, 1);
    for (const move of tokens.slice(movesIndex + 1)) {
      try {
        board = board.applyUci(move);
      } catch {
        break;
      }
      const key = board.positionKey();
      this.positionCounts.set(key, (this.positionCounts.get(key) ?? 0) + 1);
    }
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

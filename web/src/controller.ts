/**
 * KAIROS controller: a UCI-line state machine between the UI and Stockfish.
 *
 * Responsibilities kept here: handshake, options, command ordering/deferral,
 * passthrough decisions (invariants 1 and 2), the opponent model, and the
 * standalone (no Stockfish) mode. The per-move personality pipeline lives in
 * `pipeline/*` (baseline -> judge -> probes -> verify -> fallback), and all
 * chess knowledge (board, legality, SEE, features, plan, proposals, own
 * search) lives behind the `KairosCore` interface.
 */

import type { KairosCore } from "./core";
import { BaselineStage } from "./pipeline/baseline";
import { Run, type RunHost } from "./pipeline/run";
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
  updateFragility,
  type Evidence,
  type Posture,
} from "./postures";
import type {
  ControllerEvent,
  EngineMode,
  EnginePort,
  KairosOptions,
  Rationale,
  UiCommand,
} from "./types";
import {
  engineInfoFromLine,
  expectedScore,
  parseBestmove,
  parseInfo,
  supportedPersonalitySearch,
  type Candidate,
} from "./uci";

export type { ControllerEvent, EngineMode, EnginePort, KairosOptions, Rationale, UiCommand } from "./types";
export { parseInfo, expectedScore, supportedPersonalitySearch, engineInfoFromLine } from "./uci";
export type { Candidate } from "./uci";

export const DEFAULT_OPTIONS: KairosOptions = {
  style: 50,
  posture: "Auto",
  variety: 0,
  independence: 50,
  verbose: false,
  allowUnverifiedEngine: false,
  standalone: false,
};

const STANDALONE_STEP_NODES = 20_000;
const STANDALONE_DEFAULT_MS = 1500;
const STANDALONE_MAX_DEPTH = 12;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export interface ControllerDeps {
  /** Schedules the next slice of work; the worker uses setTimeout so `stop` can interleave. */
  defer?: (fn: () => void) => void;
  now?: () => number;
}

interface PassthroughSearch {
  kind: "passthrough";
  reason: string;
  requestId?: number;
  stopRequested: boolean;
}

interface RunSearch {
  kind: "run";
  run: Run;
}

interface StandaloneSearch {
  kind: "standalone";
  requestId?: number;
  stopRequested: boolean;
  deadline: number;
  lastDepth: number;
}

type ActiveSearch = PassthroughSearch | RunSearch | StandaloneSearch;

export class KairosController {
  private readonly port: EnginePort;
  private readonly emit: (event: ControllerEvent) => void;
  private readonly core: KairosCore;
  private readonly defer: (fn: () => void) => void;
  private readonly now: () => number;

  private options: KairosOptions = { ...DEFAULT_OPTIONS };
  private mode: EngineMode = "stockfish";
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
  private search: ActiveSearch | null = null;
  private readonly posture = new PostureController();
  private expectedHistory: number[] = [];
  private fragilityByClass = new Map<string, number>();
  private pendingExpectation: number | null = null;
  private pendingClass: string | null = null;
  private readonly spentHistory: number[] = [];
  private rng: () => number = mulberry32(0);
  private readonly host: RunHost;

  constructor(
    port: EnginePort,
    emit: (event: ControllerEvent) => void,
    core: KairosCore,
    deps: ControllerDeps = {},
  ) {
    this.port = port;
    this.emit = emit;
    this.core = core;
    this.defer = deps.defer ?? ((fn) => void setTimeout(fn, 0));
    this.now = deps.now ?? (() => Date.now());
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.host = {
      port,
      core,
      get options() {
        return self.options;
      },
      posture: this.posture,
      get rng() {
        return self.rng;
      },
      spentHistory: this.spentHistory,
      emit: (event) => this.emit(event),
      updatePosture: (run, baseline) => this.updatePosture(run, baseline),
      runFinished: (run) => this.finishRun(run),
    };
  }

  // ---------------------------------------------------------------- commands

  handleCommand(command: UiCommand): void {
    if (!this.running) {
      return;
    }
    if (command.type === "init") {
      this.handleInit(command);
      return;
    }
    if (command.type === "quit") {
      this.handleQuit();
      return;
    }
    if (command.type === "standalone") {
      this.enterStandalone(command.reason ?? "stockfish-unavailable");
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
        if (this.search) {
          this.deferred.push(command);
          this.requestStop();
          return;
        }
        this.sendToEngine(command.command);
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

  private handleInit(command: Extract<UiCommand, { type: "init" }>): void {
    this.options = this.sanitizeOptions(command.options ?? {});
    this.seed = command.seed ?? 0;
    this.rng = mulberry32(this.seed);
    this.engineId = "";
    this.engineOptions = new Set();
    this.ready = false;
    this.waitingReady = false;
    this.waitingUci = false;
    this.handshakeBuffer = [];
    this.search = null;
    this.deferred = [];
    this.quitAfterSearch = false;
    this.positionLine = "position startpos";
    this.resetGameState();
    this.core.newGame();
    if (this.options.standalone) {
      this.mode = "standalone";
      this.ready = true;
      this.emit({ type: "ready", engine: "KAIROS standalone", mode: "standalone" });
      return;
    }
    this.mode = "stockfish";
    this.waitingUci = true;
    this.port.send("uci");
  }

  /** Switch to the own-search mode (Stockfish gone). Safe at any time. */
  private enterStandalone(reason: string): void {
    this.search = null;
    this.deferred = [];
    this.mode = "standalone";
    this.waitingUci = false;
    this.waitingReady = false;
    this.emit({ type: "mode", mode: "standalone", reason });
    if (!this.ready) {
      this.ready = true;
      this.emit({ type: "ready", engine: "KAIROS standalone", mode: "standalone" });
      const pending = this.handshakeBuffer;
      this.handshakeBuffer = [];
      for (const command of pending) {
        this.handleCommand(command);
      }
    }
  }

  private sendToEngine(line: string): void {
    if (this.mode === "stockfish") {
      this.port.send(line);
    }
  }

  // ---------------------------------------------------------- engine output

  handleEngineLine(line: string): void {
    if (this.mode === "standalone") {
      return;
    }
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
        this.emit({ type: "ready", engine: this.engineId, mode: "stockfish" });
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
    options.independence = Number.isFinite(options.independence)
      ? clamp(Math.trunc(options.independence), 0, 100)
      : this.options.independence;
    if (options.posture !== "Auto" && !POSTURES.includes(options.posture as Posture)) {
      options.posture = "Auto";
    }
    return options;
  }

  private finishHandshake(): void {
    this.waitingUci = false;
    if (!this.options.allowUnverifiedEngine && !this.engineId.includes("Stockfish 19")) {
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
      ["Hash", "16"],
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

  private resetGameState(): void {
    this.posture.reset();
    if (this.options.posture !== "Auto") {
      this.posture.mix = oneHot(this.options.posture);
    }
    this.expectedHistory = [];
    this.fragilityByClass = new Map();
    this.pendingExpectation = null;
    this.pendingClass = null;
    this.spentHistory.length = 0;
  }

  private handleNewgame(): void {
    this.resetGameState();
    this.core.newGame();
    this.sendToEngine("ucinewgame");
  }

  private handleSetoption(name: string, value: string): void {
    const lowered = name.toLowerCase();
    const log = (text: string): void => {
      if (this.options.verbose) {
        this.emit({ type: "log", line: text });
      }
    };
    if (lowered === "kairosstyle") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        this.options.style = clamp(parsed, 0, 100);
      } else {
        log(`ignored invalid KairosStyle=${value}`);
      }
      return;
    }
    if (lowered === "kairosindependence") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        this.options.independence = clamp(parsed, 0, 100);
      } else {
        log(`ignored invalid KairosIndependence=${value}`);
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
      const posture = POSTURES.find((item) => item.toLowerCase() === value.toLowerCase());
      if (posture) {
        this.options.posture = posture;
        this.posture.mix = oneHot(posture);
      } else {
        log(`ignored invalid KairosPosture=${value}`);
      }
      return;
    }
    if (lowered === "kairosvariety") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        this.options.variety = clamp(parsed, 0, 100);
      } else {
        log(`ignored invalid KairosVariety=${value}`);
      }
      return;
    }
    if (this.mode === "standalone") {
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

  // ------------------------------------------------------------------ search

  private startSearch(goLine: string, requestId?: number): void {
    if (this.mode === "standalone") {
      this.startStandalone(goLine, requestId);
      return;
    }
    this.port.send("setoption name MultiPV value 1");
    if (this.options.style === 0) {
      this.passthrough(goLine, "style-zero", requestId);
      return;
    }
    const supported = supportedPersonalitySearch(goLine);
    if (!supported.supported) {
      this.passthrough(goLine, supported.reason, requestId);
      return;
    }
    // The core owns the board. If it cannot take the position, Stockfish decides alone.
    if (!this.core.setPosition(this.positionLine)) {
      this.passthrough(goLine, "core-rejected-position", requestId);
      return;
    }
    const legal = this.core.legalMoves();
    if (legal.length === 1) {
      this.emit({
        type: "bestmove",
        move: legal[0],
        rationale: this.stockfishRationale("forced-move", legal[0]),
        requestId,
      });
      this.finishSearch();
      return;
    }
    const run = new Run(this.host, goLine, this.positionLine, requestId, supported);
    this.search = { kind: "run", run };
    run.enter(BaselineStage);
  }

  private passthrough(goLine: string, reason: string, requestId?: number): void {
    this.search = { kind: "passthrough", reason, requestId, stopRequested: false };
    this.port.send(goLine);
  }

  private handleInfo(line: string): void {
    const active = this.search;
    if (active && active.kind === "run") {
      const run = active.run;
      run.stage.onInfo(run, line, parseInfo(line));
      if (run.stage.name !== "baseline") {
        // Judge, probe and verification scores are internal and must not reach the UI.
        return;
      }
    }
    const info = engineInfoFromLine(line);
    const requestId = active && active.kind === "run" ? active.run.requestId : active?.requestId;
    if (info) {
      this.emit({
        type: "engine-info",
        depth: info.depth,
        multipv: info.multipv,
        score: info.score,
        wdl: info.wdl,
        requestId,
      });
    } else if (this.options.verbose) {
      this.emit({ type: "log", line });
    }
  }

  private requestStop(): void {
    const active = this.search;
    if (!active) {
      return;
    }
    if (active.kind === "run") {
      if (!active.run.stopRequested) {
        active.run.stopRequested = true;
        this.port.send("stop");
      }
      return;
    }
    if (active.kind === "passthrough") {
      if (!active.stopRequested) {
        active.stopRequested = true;
        this.port.send("stop");
      }
      return;
    }
    active.stopRequested = true;
  }

  private handleBestmove(line: string): void {
    const active = this.search;
    if (!active || active.kind === "standalone") {
      return;
    }
    if (active.kind === "run") {
      active.run.stage.onBestmove(active.run, line);
      return;
    }
    const { move, ponder } = parseBestmove(line);
    this.search = null;
    if (!move || move === "(none)") {
      this.emit({ type: "error", message: "engine returned no move", recoverable: true });
      this.finishSearch();
      return;
    }
    this.emit({
      type: "bestmove",
      move,
      ponder,
      rationale: this.stockfishRationale(active.reason, move),
      requestId: active.requestId,
    });
    this.finishSearch();
  }

  private finishRun(_run: Run): void {
    this.search = null;
    this.finishSearch();
  }

  private finishSearch(): void {
    if (this.mode === "stockfish") {
      this.port.send("setoption name MultiPV value 1");
    }
    if (this.quitAfterSearch) {
      this.quitAfterSearch = false;
      if (this.mode === "stockfish") {
        this.port.send("quit");
      }
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
    if (this.mode === "stockfish") {
      this.port.send("quit");
    }
    this.emit({ type: "quit" });
    this.running = false;
  }

  // -------------------------------------------------------- opponent model

  private updatePosture(_run: Run, baseline: Candidate): void {
    const stats = this.core.positionStats();
    const expected = expectedScore(baseline);
    const forcing = this.core.forcingDensity(baseline.pv);
    const currentClass = positionClass(stats, expected, forcing);
    if (this.pendingExpectation !== null && this.pendingClass !== null) {
      // Previous PV expectation versus this search's expectation.
      const observed = expected - this.pendingExpectation;
      const previous = this.fragilityByClass.get(this.pendingClass) ?? 0;
      this.fragilityByClass.set(this.pendingClass, updateFragility(previous, observed));
    }
    const fragility = this.fragilityByClass.get(currentClass) ?? 0;
    const evidence: Evidence = evidenceFromStats(
      stats,
      expected,
      this.expectedHistory,
      forcing,
      fragility,
    );
    const forced = this.options.posture === "Auto" ? null : this.options.posture;
    this.posture.update(inferMix(evidence), evidence, forced);
    this.expectedHistory.push(expected);
    this.expectedHistory = this.expectedHistory.slice(-3);
    this.pendingExpectation = expected;
    this.pendingClass = currentClass;
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
      proposed: [],
      sfTop3: [],
      playedProposed: false,
      outsideTop3: false,
      independence: this.options.independence,
    };
  }

  // ------------------------------------------------------------ standalone

  private startStandalone(goLine: string, requestId?: number): void {
    if (!this.core.setPosition(this.positionLine)) {
      this.emit({
        type: "error",
        message: `KAIROS standalone cannot use this position: ${this.core.lastError()}`,
        recoverable: true,
      });
      return;
    }
    const legal = this.core.legalMoves();
    if (legal.length === 0) {
      this.emit({ type: "error", message: "no legal moves", recoverable: true });
      return;
    }
    const tokens = goLine.trim().split(/\s+/);
    const readNumber = (name: string): number | null => {
      const index = tokens.indexOf(name);
      const value = index >= 0 ? Number.parseInt(tokens[index + 1] ?? "", 10) : Number.NaN;
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    const movetime = readNumber("movetime");
    const depth = readNumber("depth");
    const budgetMs = movetime ?? (depth !== null ? 4000 : STANDALONE_DEFAULT_MS);
    const maxDepth = depth !== null ? Math.min(depth, STANDALONE_MAX_DEPTH) : STANDALONE_MAX_DEPTH;
    const state: StandaloneSearch = {
      kind: "standalone",
      requestId,
      stopRequested: false,
      deadline: this.now() + budgetMs,
      lastDepth: 0,
    };
    this.search = state;
    this.core.searchStart(maxDepth, 50_000_000);
    this.defer(() => this.standaloneTick(state));
  }

  private standaloneTick(state: StandaloneSearch): void {
    if (this.search !== state) {
      return;
    }
    if (!state.stopRequested && this.now() < state.deadline) {
      const t0 = performance.now();
      const status = this.core.searchStep(STANDALONE_STEP_NODES);
      if (status.depth > state.lastDepth) {
        state.lastDepth = status.depth;
        const best = this.core.ownBestMove();
        if (best) {
          this.emit({
            type: "engine-info",
            depth: best.depth,
            multipv: 1,
            score: best.mate !== null ? `mate ${best.mate}` : `cp ${best.cp}`,
            requestId: state.requestId,
          });
        }
      }
      if (!status.done) {
        this.defer(() => this.standaloneTick(state));
        return;
      }
    }
    const best = this.core.ownBestMove();
    const legal = this.core.legalMoves();
    const move = best && legal.includes(best.move) ? best.move : legal[0];
    this.search = null;
    const mix = this.posture.mix;
    const posture = dominant(mix);
    this.emit({
      type: "bestmove",
      move,
      rationale: {
        kind: "standalone",
        reason: best && best.mate !== null ? "own-search-mate" : "own-search",
        posture,
        confidence: mix[posture],
        mix,
        plan: planToken(posture),
        budgetPct: 0,
        lossPct: 0,
        pick: 1,
        sfBest: "",
        proposed: [],
        sfTop3: [],
        playedProposed: false,
        outsideTop3: false,
        independence: this.options.independence,
        pressure: { tension: this.core.tensionIndex(), narrowness: null },
      },
      requestId: state.requestId,
    });
    this.finishSearch();
  }
}

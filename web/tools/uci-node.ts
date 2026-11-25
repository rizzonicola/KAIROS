/**
 * KAIROS as a plain UCI engine (stdin/stdout), usable from cutechess-cli,
 * Arena, Lichess-bot style wrappers or any UCI GUI, like Stockfish itself.
 *
 *   node kairos-uci.mjs            (packaged: see scripts/build_uci.sh)
 *   node tools/run-ts.mjs tools/uci-node.ts   (from a checkout)
 *
 * It hosts exactly the same controller and Rust core as the web page. Stockfish
 * Lite (single thread) is started as a child process and used as judge,
 * verifier and safety net. When Stockfish cannot be found or dies, KAIROS keeps
 * playing with its own (shallow) search and says so in an `info string`.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  KairosController,
  type ControllerEvent,
  type EnginePort,
  type KairosOptions,
  type Rationale,
} from "../src/controller";
import { POSTURES } from "../src/postures";
import type { WasmCore } from "../src/core-wasm";
import { loadCoreAuto } from "./node-core";
import { NodeEnginePort } from "./node-engine";
import { convertGo } from "./uci-time";

const VERSION = "0.3.0";
const BASE_DIR = dirname(resolve(process.argv[1] ?? "."));

interface Settings {
  style: number;
  independence: number;
  posture: string;
  variety: number;
  verbose: boolean;
  hash: number;
  moveOverhead: number;
  stockfishPath: string;
  infoStrings: boolean;
}

const settings: Settings = {
  style: 50,
  independence: 50,
  posture: "Auto",
  variety: 0,
  verbose: false,
  hash: 16,
  moveOverhead: 100,
  stockfishPath: "",
  infoStrings: true,
};

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function uciOptions(): string[] {
  return [
    `option name Hash type spin default 16 min 1 max 64`,
    `option name Threads type spin default 1 min 1 max 1`,
    `option name MultiPV type spin default 1 min 1 max 1`,
    `option name UCI_ShowWDL type check default true`,
    `option name MoveOverhead type spin default 100 min 0 max 5000`,
    `option name StockfishPath type string default <empty>`,
    `option name KairosStyle type spin default 50 min 0 max 100`,
    `option name KairosIndependence type spin default 50 min 0 max 100`,
    `option name KairosPosture type combo default Auto var Auto ${POSTURES.map((p) => `var ${p}`).join(" ")}`,
    `option name KairosVariety type spin default 0 min 0 max 100`,
    `option name KairosVerbose type check default false`,
    `option name KairosInfoStrings type check default true`,
  ];
}

function findStockfish(): string | null {
  const candidates = [
    settings.stockfishPath && settings.stockfishPath !== "<empty>" ? settings.stockfishPath : "",
    process.env.KAIROS_STOCKFISH ?? "",
    join(BASE_DIR, "engine", "stockfish-19-lite-single.js"),
    join(BASE_DIR, "..", "public", "engine", "stockfish-19-lite-single.js"),
  ].filter((path) => path.length > 0);
  return candidates.find((path) => existsSync(path)) ?? null;
}

function summary(r: Rationale): string {
  const parts = [
    `kairos ${r.kind} ${r.reason}`,
    `posture=${r.posture}`,
    `plan=${r.plan}`,
    `budget=${r.budgetPct.toFixed(2)}`,
    `loss=${r.lossPct.toFixed(2)}`,
  ];
  if (r.sfBest) {
    parts.push(`sf=${r.sfBest}`);
  }
  if (r.kind === "rerank") {
    parts.push(`outsideTop3=${r.outsideTop3}`, `proposed=${r.playedProposed}`);
  }
  return parts.join(" ");
}

let controller: KairosController | null = null;
let core: WasmCore | null = null;
let port: NodeEnginePort | null = null;
let starting: Promise<void> | null = null;
let standalone = false;
let searching = false;
let quitting = false;
let lastPosition = "position startpos";
let lastGo = "";
let lastRequest = 0;
let readyResolve: (() => void) | null = null;
let stdinClosed = false;

function handleEvent(event: ControllerEvent): void {
  switch (event.type) {
    case "ready":
      standalone = event.mode === "standalone";
      if (standalone) {
        out("info string KAIROS standalone: own search only (Stockfish not available)");
      }
      readyResolve?.();
      return;
    case "mode":
      standalone = event.mode === "standalone";
      out(`info string ${event.reason}; KAIROS standalone (own search only)`);
      return;
    case "engine-info": {
      const wdl = event.wdl ? ` wdl ${event.wdl[0]} ${event.wdl[1]} ${event.wdl[2]}` : "";
      out(`info depth ${event.depth} multipv ${event.multipv} score ${event.score}${wdl}`);
      return;
    }
    case "bestmove":
      searching = false;
      if (settings.infoStrings) {
        out(`info string ${summary(event.rationale)}`);
      }
      out(`bestmove ${event.move}${event.ponder ? ` ponder ${event.ponder}` : ""}`);
      if (stdinClosed) {
        shutdown(); // piped usage: `printf '...go...' | kairos` finishes the search, then exits
      }
      return;
    case "error":
      out(`info string error: ${event.message}`);
      if (searching) {
        searching = false;
        out("bestmove 0000");
      }
      return;
    case "log":
      if (settings.verbose) {
        out(`info string ${event.line}`);
      }
      return;
    case "quit":
      return;
  }
}

async function start(): Promise<void> {
  try {
    core = await loadCoreAuto(BASE_DIR);
  } catch (error) {
    out(`info string fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const stockfish = findStockfish();
  if (stockfish) {
    try {
      port = await NodeEnginePort.start(stockfish);
    } catch (error) {
      out(`info string could not start Stockfish (${String(error)})`);
      port = null;
    }
  } else {
    out("info string Stockfish Lite not found (set StockfishPath or KAIROS_STOCKFISH)");
  }
  const sink: EnginePort = { send: (line) => port?.send(line) };
  const active = new KairosController(sink, handleEvent, core, {
    defer: (fn) => void setImmediate(fn),
  });
  controller = active;
  if (port) {
    port.onLine = (line) => active.handleEngineLine(line);
    port.onExit = () => {
      if (quitting) {
        return;
      }
      active.handleCommand({ type: "standalone", reason: "the Stockfish process ended" });
      if (searching && lastGo) {
        active.handleCommand({ type: "position", command: lastPosition });
        active.handleCommand({ type: "go", command: lastGo, requestId: lastRequest });
      }
    };
  }
  const ready = new Promise<void>((resolveReady) => {
    readyResolve = resolveReady;
  });
  const options: Partial<KairosOptions> = {
    style: settings.style,
    independence: settings.independence,
    posture: settings.posture as KairosOptions["posture"],
    variety: settings.variety,
    verbose: settings.verbose,
    standalone: port === null,
  };
  active.handleCommand({ type: "init", options, seed: Date.now() });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(() => {
      active.handleCommand({ type: "standalone", reason: "Stockfish did not answer in time" });
      resolveTimeout();
    }, 20_000);
  });
  await Promise.race([ready, timeout]);
  clearTimeout(timer);
  if (port && settings.hash !== 16) {
    active.handleCommand({ type: "setoption", name: "Hash", value: String(settings.hash) });
  }
}

async function ensureStarted(): Promise<KairosController> {
  if (!starting) {
    starting = start();
  }
  await starting;
  if (!controller) {
    throw new Error("controller did not start");
  }
  return controller;
}

function applySetoption(name: string, value: string): void {
  const key = name.toLowerCase();
  const asInt = (min: number, max: number, fallback: number): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  switch (key) {
    case "kairosstyle":
      settings.style = asInt(0, 100, settings.style);
      break;
    case "kairosindependence":
      settings.independence = asInt(0, 100, settings.independence);
      break;
    case "kairosvariety":
      settings.variety = asInt(0, 100, settings.variety);
      break;
    case "kairosposture":
      settings.posture = value;
      break;
    case "kairosverbose":
      settings.verbose = value.toLowerCase() === "true";
      break;
    case "kairosinfostrings":
      settings.infoStrings = value.toLowerCase() === "true";
      break;
    case "hash":
      settings.hash = asInt(1, 64, settings.hash);
      break;
    case "moveoverhead":
      settings.moveOverhead = asInt(0, 5000, settings.moveOverhead);
      break;
    case "stockfishpath":
      settings.stockfishPath = value;
      break;
    default:
      break; // Threads, MultiPV, UCI_ShowWDL are fixed by KAIROS
  }
  if (controller && key !== "stockfishpath" && key !== "moveoverhead" && key !== "kairosinfostrings") {
    controller.handleCommand({ type: "setoption", name, value });
  }
}

function parseSetoption(command: string): { name: string; value: string } | null {
  const tokens = command.split(/\s+/);
  const nameAt = tokens.indexOf("name");
  if (nameAt < 0) {
    return null;
  }
  const valueAt = tokens.indexOf("value");
  const name = tokens.slice(nameAt + 1, valueAt > nameAt ? valueAt : undefined).join(" ");
  const value = valueAt > nameAt ? tokens.slice(valueAt + 1).join(" ") : "";
  return { name, value };
}

async function handle(command: string): Promise<void> {
  const word = command.split(/\s+/)[0];
  switch (word) {
    case "uci":
      out(`id name KAIROS ${VERSION} (Stockfish 19 Lite)`);
      out("id author KAIROS contributors; Stockfish by the Stockfish developers");
      for (const line of uciOptions()) {
        out(line);
      }
      out("uciok");
      return;
    case "isready":
      await ensureStarted();
      out("readyok");
      return;
    case "setoption": {
      const parsed = parseSetoption(command);
      if (parsed) {
        applySetoption(parsed.name, parsed.value);
      }
      return;
    }
    case "ucinewgame": {
      const active = await ensureStarted();
      active.handleCommand({ type: "newgame" });
      return;
    }
    case "position": {
      lastPosition = command;
      const active = await ensureStarted();
      active.handleCommand({ type: "position", command });
      return;
    }
    case "go": {
      const active = await ensureStarted();
      let side: "w" | "b" = "w";
      if (core && core.setPosition(lastPosition)) {
        side = core.sideToMove();
      }
      lastGo = convertGo(command, side, settings.moveOverhead, standalone);
      lastRequest += 1;
      searching = true;
      active.handleCommand({ type: "go", command: lastGo, requestId: lastRequest });
      return;
    }
    case "debug":
    case "register":
    case "ponderhit":
      return;
    default:
      return;
  }
}

function shutdown(): void {
  quitting = true;
  try {
    controller?.handleCommand({ type: "quit" });
  } catch {
    // ignore
  }
  port?.terminate();
  setTimeout(() => process.exit(0), 50);
}

let chain: Promise<void> = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("line", (raw) => {
  const command = raw.trim();
  if (command === "") {
    return;
  }
  const word = command.split(/\s+/)[0];
  if (word === "quit") {
    shutdown();
    return;
  }
  if (word === "stop") {
    controller?.handleCommand({ type: "stop" });
    return;
  }
  chain = chain.then(() => handle(command)).catch((error) => {
    out(`info string error: ${error instanceof Error ? error.message : String(error)}`);
    if (searching) {
      searching = false;
      out("bestmove 0000");
    }
  });
});
lines.on("close", () => {
  stdinClosed = true;
  void chain.then(() => {
    if (!searching) {
      shutdown();
    }
  });
});

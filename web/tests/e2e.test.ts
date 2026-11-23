import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  KairosController,
  type ControllerEvent,
  type Rationale,
} from "../src/controller";
import { NodeEnginePort } from "./node-engine";

const TIMEOUT = 120_000;
const SIDE_TIMEOUT = 100_000;
const PROXY = fileURLToPath(new URL("../../kairos/uci_proxy.py", import.meta.url));

function locateEngine(): string | null {
  const configured = process.env.KAIROS_LITE_ENGINE;
  const path = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured)
    : fileURLToPath(
        new URL("../public/engine/stockfish-19-lite-single.js", import.meta.url),
      );
  return existsSync(path) ? path : null;
}

const ENGINE = locateEngine();
// web/package.json is "type": "module"; run a CommonJS copy where the engine
// finds its wasm and Node does not parse the script as ESM.
const RUNTIME_DIR = ENGINE === null ? null : mkdtempSync(join(tmpdir(), "kairos-e2e-"));
const RUNTIME_JS = RUNTIME_DIR === null ? null : join(RUNTIME_DIR, "stockfish-19-lite-single.js");

if (ENGINE !== null && RUNTIME_DIR !== null && RUNTIME_JS !== null) {
  copyFileSync(ENGINE, RUNTIME_JS);
  copyFileSync(
    ENGINE.replace(/\.js$/, ".wasm"),
    join(RUNTIME_DIR, "stockfish-19-lite-single.wasm"),
  );
}

afterAll(() => {
  if (RUNTIME_DIR !== null) {
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }
});

const POSITIONS = [
  "position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1",
  "position startpos moves e2e4 e7e5",
];

interface Bestmove {
  move: string;
  rationale: Rationale;
}

interface Oracle {
  move: string;
  posture: string | null;
  plan: string | null;
}

function runWeb(enginePath: string, position: string): Promise<Bestmove> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("web side timed out")),
      SIDE_TIMEOUT,
    );
    NodeEnginePort.start(enginePath)
      .then((engine) => {
        const controller = new KairosController(engine, (event: ControllerEvent) => {
          if (event.type === "bestmove") {
            clearTimeout(timer);
            resolve({ move: event.move, rationale: event.rationale });
            // Let the controller finish its synchronous tail before closing stdin.
            setImmediate(() => engine.terminate());
          } else if (event.type === "error" && !event.recoverable) {
            clearTimeout(timer);
            engine.terminate();
            reject(new Error(event.message));
          }
        });
        engine.onLine = (line) => controller.handleEngineLine(line);
        controller.handleCommand({
          type: "init",
          options: { style: 50, posture: "Auto", variety: 0 },
          seed: 1,
        });
        controller.handleCommand({ type: "position", command: position });
        controller.handleCommand({ type: "go", command: "go depth 5" });
      })
      .catch(reject);
  });
}

function runOracle(enginePath: string, position: string): Promise<Oracle> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [
      PROXY,
      "--engine",
      `node ${enginePath}`,
      "--log",
      "",
    ]);
    const stderr: string[] = [];
    let move: string | null = null;
    let posture: string | null = null;
    let plan: string | null = null;
    let stage = 0;

    child.stdin.write("uci\n");

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`python proxy timed out\n${stderr.join("")}`));
    }, SIDE_TIMEOUT);

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line === "uciok" && stage === 0) {
        stage = 1;
        child.stdin.write("isready\n");
        return;
      }
      if (line === "readyok" && stage === 1) {
        stage = 2;
        child.stdin.write(
          "setoption name KairosVerbose value true\n" +
            `${position}\n` +
            "go depth 5\n",
        );
        return;
      }
      if (line.startsWith("info string kairos ")) {
        posture = /posture=(\S+)/.exec(line)?.[1] ?? posture;
        plan = /plan=(\S+)/.exec(line)?.[1] ?? plan;
        return;
      }
      if (line.startsWith("bestmove ")) {
        move = line.trim().split(/\s+/)[1];
        child.stdin.write("quit\n");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      if (move) {
        resolve({ move, posture, plan });
      } else {
        reject(new Error(`python proxy returned no move\n${stderr.join("")}`));
      }
    });
  });
}

describe.skipIf(RUNTIME_JS === null)("same-engine parity", () => {
  for (const position of POSITIONS) {
    it(
      `matches the Python oracle for ${position}`,
      async () => {
        const web = await runWeb(RUNTIME_JS!, position);
        const oracle = await runOracle(RUNTIME_JS!, position);

        expect(web.move).toBe(oracle.move);
        if (oracle.posture !== null && oracle.plan !== null) {
          expect(web.rationale.posture.toUpperCase()).toBe(oracle.posture);
          expect(web.rationale.plan).toBe(oracle.plan);
        }
      },
      TIMEOUT,
    );
  }
});

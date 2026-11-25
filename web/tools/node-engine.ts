import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { EnginePort } from "../src/types";

/** Stockfish Lite running under Node, so Vitest can drive a real engine. */
export class NodeEnginePort implements EnginePort {
  onLine: ((line: string) => void) | null = null;
  /** Called when the Stockfish process ends (crash or exit). */
  onExit: (() => void) | null = null;
  readonly stderr: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      this.onLine?.(line);
    });
    child.once("exit", () => {
      this.onExit?.();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk.toString());
    });
  }

  /** Resolves once the process is running; rejects when spawn fails. */
  static start(enginePath: string): Promise<NodeEnginePort> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [enginePath]);
      const port = new NodeEnginePort(child);
      child.once("spawn", () => resolve(port));
      child.once("error", reject);
    });
  }

  send(line: string): void {
    if (this.child.stdin.writable) {
      this.child.stdin.write(`${line}\n`);
    }
  }

  terminate(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

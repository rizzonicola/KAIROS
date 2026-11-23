import { describe, expect, it } from "vitest";
import { EngineHost, type WorkerLike } from "../src/engine-host";

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  message(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const lines: string[] = [];
  const errors: Error[] = [];
  const host = new EngineHost(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    (line) => lines.push(line),
    (error) => errors.push(error),
  );
  return { host, workers, lines, errors };
}

describe("EngineHost", () => {
  it("forwards engine lines, errors and outgoing strings", () => {
    const { host, workers, lines, errors } = setup();
    host.send("uci");
    workers[0].message("readyok");
    workers[0].fail("boom");

    expect(workers[0].posted).toEqual(["uci"]);
    expect(lines).toEqual(["readyok"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
  });

  it("restarts once, then reports a second consecutive failure", () => {
    const { host, workers } = setup();

    expect(host.restart()).toBe(true);
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);

    host.send("isready");
    expect(workers[1].posted).toEqual(["isready"]);

    expect(host.restart()).toBe(false);
    expect(workers).toHaveLength(2);
  });

  it("stops forwarding after terminate", () => {
    const { host, workers, lines, errors } = setup();
    host.terminate();
    expect(workers[0].terminated).toBe(true);

    workers[0].message("readyok");
    workers[0].fail("boom");
    expect(lines).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("does not restart after terminate", () => {
    const { host, workers } = setup();
    host.terminate();
    expect(host.restart()).toBe(false);
    expect(workers).toHaveLength(1);
  });
});

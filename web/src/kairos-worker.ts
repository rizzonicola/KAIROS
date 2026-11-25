import { KairosController } from "./controller";
import { loadWasmCore } from "./core-wasm";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import type { UiCommand } from "./types";

// Minimal worker scope: the project intentionally omits the WebWorker lib.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: WorkerResponse): void;
};

let controller: KairosController | null = null;
let booting = false;
const pending: WorkerRequest[] = [];

function post(message: WorkerResponse): void {
  scope.postMessage(message);
}

function dispatch(message: WorkerRequest): void {
  if (controller === null) {
    pending.push(message);
    return;
  }
  if (message.type === "engine-line") {
    controller.handleEngineLine(message.line);
  } else {
    controller.handleCommand(message);
  }
}

async function boot(init: Extract<UiCommand, { type: "init" }>): Promise<void> {
  try {
    if (!init.coreUrl) {
      throw new Error("no coreUrl in init message");
    }
    const core = await loadWasmCore(init.coreUrl);
    controller = new KairosController({ send: (line) => post({ type: "engine-send", line }) }, post, core);
    controller.handleCommand(init);
    for (const message of pending.splice(0)) {
      dispatch(message);
    }
  } catch (error) {
    post({
      type: "error",
      message: `KAIROS core failed to load: ${error instanceof Error ? error.message : String(error)}`,
      recoverable: false,
    });
  } finally {
    booting = false;
  }
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  // One boot at a time: a second init while loading is queued, so it reaches
  // the same controller (a parallel boot would reset the core mid-search).
  if (message.type === "init" && controller === null && !booting) {
    booting = true;
    void boot(message);
    return;
  }
  dispatch(message);
};

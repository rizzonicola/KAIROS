import { KairosController } from "./controller";
import type { WorkerRequest, WorkerResponse } from "./protocol";

// Minimal worker scope: the project intentionally omits the WebWorker lib.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: WorkerResponse): void;
};

const controller = new KairosController(
  { send: (line) => scope.postMessage({ type: "engine-send", line }) },
  (event) => scope.postMessage(event),
);

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "engine-line") {
    controller.handleEngineLine(message.line);
  } else {
    controller.handleCommand(message);
  }
};

export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

/** Owns the engine worker and allows one restart after a crash. */
export class EngineHost {
  private worker: WorkerLike;
  private restarts = 0;
  private active = true;

  constructor(
    private readonly factory: () => WorkerLike,
    private readonly onLine: (line: string) => void,
    private readonly onError: (error: Error) => void,
  ) {
    this.worker = this.attach();
  }

  send(line: string): void {
    this.worker.postMessage(line);
  }

  terminate(): void {
    this.active = false;
    this.worker.terminate();
  }

  /** False on the second consecutive failure; only a full retry resets it. */
  restart(): boolean {
    if (this.restarts >= 1) {
      return false;
    }
    this.worker.terminate();
    this.restarts += 1;
    this.worker = this.attach();
    return true;
  }

  private attach(): WorkerLike {
    const worker = this.factory();
    worker.onmessage = (event) => {
      if (this.active) {
        this.onLine(String(event.data));
      }
    };
    worker.onerror = (event) => {
      if (this.active) {
        this.onError(new Error(event.message || "engine worker error"));
      }
    };
    return worker;
  }
}

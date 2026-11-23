import type { ControllerEvent, UiCommand } from "./controller";

export type WorkerRequest = UiCommand | { type: "engine-line"; line: string };
export type WorkerResponse =
  | ControllerEvent
  | { type: "engine-send"; line: string };

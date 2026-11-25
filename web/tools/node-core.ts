import { existsSync, readFileSync } from "node:fs";
import type { WasmCore } from "../src/core-wasm";

const PKG = new URL("../src/core/pkg/", import.meta.url);

/** True once `scripts/build_core.sh` has produced the wasm-bindgen package. */
export function coreAvailable(): boolean {
  return existsSync(new URL("kairos_core_bg.wasm", PKG)) && existsSync(new URL("kairos_core.js", PKG));
}

/** A fresh Rust/WASM core instance under Node. Throws when the package was not built. */
export async function loadNodeCore(): Promise<WasmCore> {
  const { loadWasmCore } = await import("../src/core-wasm");
  return loadWasmCore(readFileSync(new URL("kairos_core_bg.wasm", PKG)));
}

/**
 * Locate `kairos_core_bg.wasm` next to the running script (packaged engine),
 * in `public/engine` (after scripts/build_core.sh) or in the wasm-bindgen
 * output directory, and instantiate it.
 */
export async function loadCoreAuto(baseDir: string): Promise<WasmCore> {
  const { join } = await import("node:path");
  const candidates = [
    join(baseDir, "kairos_core_bg.wasm"),
    join(baseDir, "engine", "kairos_core_bg.wasm"),
    join(baseDir, "..", "public", "engine", "kairos_core_bg.wasm"),
    join(baseDir, "..", "src", "core", "pkg", "kairos_core_bg.wasm"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(`kairos_core_bg.wasm not found (looked in: ${candidates.join(", ")})`);
  }
  const { loadWasmCore } = await import("../src/core-wasm");
  return loadWasmCore(readFileSync(found));
}

// Run a TypeScript entry point under Node without extra dependencies:
//   node tools/run-ts.mjs tools/match.ts --games 2
// esbuild is already installed as a dependency of Vite.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error("usage: node tools/run-ts.mjs <entry.ts> [args...]");
  process.exit(2);
}
const outfile = join(mkdtempSync(join(tmpdir(), "kairos-run-")), "entry.mjs");
await build({
  entryPoints: [resolve(entry)],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "error",
  external: ["node:*"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
process.argv = [process.argv[0], resolve(entry), ...args];
await import(pathToFileURL(outfile).href);

// Bundle the headless UCI engine into one file: dist-uci/kairos-uci.mjs
//   node tools/bundle-uci.mjs [outdir]
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(process.argv[2] ?? join(here, "..", "..", "dist", "kairos-uci-build"));
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: [join(here, "uci-node.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(outdir, "kairos-uci.mjs"),
  logLevel: "info",
  minify: false,
  external: ["node:*"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log(`bundled ${join(outdir, "kairos-uci.mjs")}`);

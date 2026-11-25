#!/usr/bin/env bash
# Build the Rust core to WebAssembly and produce the wasm-bindgen package.
#   scripts/build_core.sh            # release build, wasm-opt if available
# Outputs:
#   web/src/core/pkg/kairos_core.js, kairos_core_bg.wasm   (glue + module, gitignored)
#   web/public/engine/kairos_core_bg.wasm                  (served next to Stockfish)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="${ROOT}/kairos-core"
PKG="${ROOT}/web/src/core/pkg"
ENGINE_DIR="${ROOT}/web/public/engine"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' is required ($2)" >&2; exit 1; }; }
need cargo "install Rust via rustup; see kairos-core/rust-toolchain.toml"
need wasm-bindgen "cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION:-0.2.100} --locked"

# The wasm-bindgen crate pinned in Cargo.toml must equal the CLI version.
want="$(sed -n 's/^wasm-bindgen = "=\([0-9.]*\)".*/\1/p' "${CRATE}/Cargo.toml")"
have="$(wasm-bindgen --version | awk '{print $2}')"
if [[ "${want}" != "${have}" ]]; then
  echo "ERROR: wasm-bindgen CLI ${have} does not match the crate pin ${want} in kairos-core/Cargo.toml" >&2
  exit 1
fi

LOCK=()
[[ -f "${CRATE}/Cargo.lock" ]] && LOCK=(--locked)
# Run from the crate so rustup honours kairos-core/rust-toolchain.toml.
(cd "${CRATE}" && cargo build --release --target wasm32-unknown-unknown "${LOCK[@]}")
rm -rf "${PKG}"
mkdir -p "${PKG}" "${ENGINE_DIR}"
wasm-bindgen --target web --out-dir "${PKG}" --out-name kairos_core \
  "${CRATE}/target/wasm32-unknown-unknown/release/kairos_core.wasm"

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
    -o "${PKG}/kairos_core_bg.opt.wasm" "${PKG}/kairos_core_bg.wasm"
  mv "${PKG}/kairos_core_bg.opt.wasm" "${PKG}/kairos_core_bg.wasm"
else
  echo "warning: wasm-opt (binaryen) not found; skipping the size pass" >&2
fi

cp "${PKG}/kairos_core_bg.wasm" "${ENGINE_DIR}/kairos_core_bg.wasm"
ls -l "${PKG}/kairos_core_bg.wasm" | awk '{print "kairos_core_bg.wasm:", $5, "bytes"}'

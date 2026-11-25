#!/usr/bin/env bash
# Package KAIROS as a stand-alone UCI engine (needs only Node >= 20 to run).
#   scripts/build_uci.sh [tag]      -> dist/kairos-uci-<tag>.tar.gz
# Requires: web/src/core/pkg (scripts/build_core.sh) and the Stockfish Lite files
# in web/public/engine (scripts/fetch_engine.sh). `npm ci` must have been run in web/.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-dev}"
PKG="kairos-uci-${TAG}"
DIST="${ROOT}/dist/${PKG}"
ENG="${ROOT}/web/public/engine"
for f in stockfish-19-lite-single.js stockfish-19-lite-single.wasm kairos_core_bg.wasm; do
  [[ -f "${ENG}/${f}" ]] || { echo "ERROR: ${ENG}/${f} is missing (run build_core.sh / fetch_engine.sh)" >&2; exit 1; }
done
rm -rf "${DIST}"
mkdir -p "${DIST}/engine"
(cd "${ROOT}/web" && node tools/bundle-uci.mjs "${DIST}")
cp "${ENG}/stockfish-19-lite-single.js" "${ENG}/stockfish-19-lite-single.wasm" "${ENG}/kairos_core_bg.wasm" "${DIST}/engine/"
cp "${ROOT}/scripts/launchers/kairos" "${ROOT}/scripts/launchers/kairos.cmd" "${DIST}/"
chmod +x "${DIST}/kairos"
cp "${ROOT}/docs/UCI.md" "${DIST}/README-UCI.md"
cp "${ROOT}/LICENSE" "${ROOT}/THIRD_PARTY.md" "${DIST}/"
tar -C "${ROOT}/dist" -czf "${ROOT}/dist/${PKG}.tar.gz" "${PKG}"
echo "Built ${ROOT}/dist/${PKG}.tar.gz"
echo "Smoke test: printf 'uci\nisready\nposition startpos\ngo movetime 2000\n' | ${DIST}/kairos"

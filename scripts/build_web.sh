#!/usr/bin/env bash
# Build the optional browser page: dist/kairos-web-<tag>.tar.gz
#   scripts/build_web.sh [tag]
# Requires web/public/engine/{stockfish-19-lite-single.js,.wasm} (scripts/fetch_engine.sh);
# builds the Rust core first when it is not built yet.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-dev}"
ENG="${ROOT}/web/public/engine"
[[ -f "${ENG}/stockfish-19-lite-single.js" && -f "${ENG}/stockfish-19-lite-single.wasm" ]] || {
  echo "ERROR: Stockfish Lite files missing in ${ENG}; run scripts/fetch_engine.sh" >&2
  exit 1
}
[[ -f "${ROOT}/web/src/core/pkg/kairos_core.js" ]] || "${ROOT}/scripts/build_core.sh"
(cd "${ROOT}/web" && npm ci && npm run build)
pkg="kairos-web-${TAG}"
rm -rf "${ROOT}/dist/${pkg}"
mkdir -p "${ROOT}/dist/${pkg}"
cp -r "${ROOT}/web/dist/." "${ROOT}/dist/${pkg}/"
find "${ROOT}/dist/${pkg}" -name .gitkeep -delete
cp "${ROOT}/LICENSE" "${ROOT}/THIRD_PARTY.md" "${ROOT}/dist/${pkg}/"
cp "${ROOT}/web/README-WEB.md" "${ROOT}/dist/${pkg}/README-WEB.md"
tar -C "${ROOT}/dist" -czf "${ROOT}/dist/${pkg}.tar.gz" "${pkg}"
echo "Built ${ROOT}/dist/${pkg}.tar.gz"

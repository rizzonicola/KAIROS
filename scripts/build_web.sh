#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-dev}"
ENGINE_DIR="${KAIROS_LITE_ENGINE_DIR:-${ROOT}/dist/stockfish-19-lite-single}"
JS="${ENGINE_DIR}/stockfish-19-lite-single.js"
WASM="${ENGINE_DIR}/stockfish-19-lite-single.wasm"
[[ -f "${JS}" && -f "${WASM}" ]] || {
  echo "ERROR: ${JS} and ${WASM} are required." >&2
  echo "Build with ./scripts/build_wasm.sh lite or set KAIROS_LITE_ENGINE_DIR." >&2
  exit 1
}
mkdir -p "${ROOT}/web/public/engine"
cp "${JS}" "${WASM}" "${ROOT}/web/public/engine/"
(cd "${ROOT}/web" && npm ci && npm run build)
pkg="kairos-lite-web-${TAG}"
rm -rf "${ROOT}/dist/${pkg}"
mkdir -p "${ROOT}/dist/${pkg}"
cp -r "${ROOT}/web/dist/." "${ROOT}/dist/${pkg}/"
find "${ROOT}/dist/${pkg}" -name .gitkeep -delete
cp "${ROOT}/LICENSE" "${ROOT}/THIRD_PARTY.md" "${ROOT}/dist/${pkg}/"
cp "${ROOT}/web/README-WEB.md" "${ROOT}/dist/${pkg}/README-WEB.md"
tar -C "${ROOT}/dist" -czf "${ROOT}/dist/${pkg}.tar.gz" "${pkg}"
echo "Built ${ROOT}/dist/${pkg}.tar.gz"

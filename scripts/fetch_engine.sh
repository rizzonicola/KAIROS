#!/usr/bin/env bash
# Download the pinned Stockfish 19 Lite (single thread) WebAssembly build and verify it.
#   scripts/fetch_engine.sh [output-dir]       default: web/public/engine
# Set KAIROS_REQUIRE_PIN=1 (CI) to refuse an artefact whose SHA-256 is not recorded in engine.lock.
# Alternative without network: scripts/build_wasm.sh lite (Emscripten 6.0.9, nmrugg/stockfish.js v19.0.1).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-${ROOT}/web/public/engine}"
BASE="https://github.com/rizzonicola/KAIROS/releases/download/v0.1.0"
ASSET="stockfish-19-lite-single.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

curl -L --fail -o "${TMP}/${ASSET}" "${BASE}/${ASSET}"
curl -L --fail -o "${TMP}/SHA256SUMS" "${BASE}/SHA256SUMS"
(cd "${TMP}" && grep "${ASSET}" SHA256SUMS | sha256sum -c -)

actual="$(sha256sum "${TMP}/${ASSET}" | awk '{print $1}')"
pinned="$(sed -n 's/^sha256 //p' "${ROOT}/scripts/engine.lock" | head -n1)"
if [[ "${pinned}" == "PENDING-FIRST-VERIFICATION" || -z "${pinned}" ]]; then
  echo "warning: engine.lock has no pinned hash yet. Computed: ${actual}" >&2
  if [[ "${KAIROS_REQUIRE_PIN:-0}" == "1" ]]; then
    echo "ERROR: record this hash in scripts/engine.lock ('sha256 ${actual}') after checking provenance." >&2
    exit 1
  fi
elif [[ "${pinned}" != "${actual}" ]]; then
  echo "ERROR: ${ASSET} hash ${actual} != pinned ${pinned}" >&2
  exit 1
fi

tar -C "${TMP}" -xzf "${TMP}/${ASSET}"
mkdir -p "${OUT}"
cp "${TMP}/stockfish-19-lite-single/stockfish-19-lite-single.js" \
   "${TMP}/stockfish-19-lite-single/stockfish-19-lite-single.wasm" "${OUT}/"
echo "Stockfish 19 Lite (single) installed in ${OUT}"

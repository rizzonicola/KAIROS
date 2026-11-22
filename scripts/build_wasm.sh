#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SF_REPO="https://github.com/official-stockfish/Stockfish.git"
SF_TAG="sf_19"
SF_COMMIT="edb0d9db6731067ec50ce619ff372b463bc4dd5d"
SF_NET="nn-1a298aa575a0.nnue"
SF_NET_SHA256="1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2"
SF_DIR="${ROOT}/third_party/Stockfish"

LITE_REPO="https://github.com/nmrugg/stockfish.js.git"
LITE_TAG="v19.0.1"
LITE_COMMIT="0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6"
LITE_DIR="${ROOT}/third_party/stockfish.js"

DIST="${ROOT}/dist"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)}"
MODE="${1:-}"
ARCH="${2:-wasm32}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found in PATH."
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/build_wasm.sh official [wasm32|wasm32-relaxed-simd]
  ./scripts/build_wasm.sh lite

The official mode builds Stockfish 19 from the pinned sf_19 source and original
network. The lite mode builds the stockfish.js v19.0.1 lite and lite-single
flavors with their smaller network. Artifacts are written to dist/.

Emscripten must already be active (em++ in PATH). In CI, install emsdk 6.0.9
and source emsdk_env.sh first.
EOF
}

verify_sf_source() {
  if [[ ! -d "${SF_DIR}/.git" ]]; then
    [[ -d "${SF_DIR}" ]] && die "${SF_DIR} exists but is not a Git checkout."
    echo "Cloning official Stockfish tag ${SF_TAG}..."
    git clone --depth 1 --branch "${SF_TAG}" --single-branch "${SF_REPO}" "${SF_DIR}"
  fi
  local tag commit
  tag="$(git -C "${SF_DIR}" describe --tags --exact-match 2>/dev/null || true)"
  commit="$(git -C "${SF_DIR}" rev-parse HEAD)"
  [[ "${tag}" == "${SF_TAG}" ]] || die "expected tag ${SF_TAG}, found '${tag:-none}'."
  [[ "${commit}" == "${SF_COMMIT}" ]] || die "expected commit ${SF_COMMIT}, found ${commit}."
  [[ -z "$(git -C "${SF_DIR}" status --porcelain --untracked-files=no)" ]] \
    || die "tracked Stockfish source is modified."
}

ensure_sf_net() {
  if [[ ! -f "${SF_DIR}/src/${SF_NET}" ]]; then
    make -C "${SF_DIR}/src" net
  fi
  local actual
  actual="$(sha256sum "${SF_DIR}/src/${SF_NET}" | cut -d ' ' -f 1)"
  [[ "${actual}" == "${SF_NET_SHA256}" ]] \
    || die "NNUE checksum mismatch: expected ${SF_NET_SHA256}, got ${actual}."
}

verify_lite_source() {
  if [[ ! -d "${LITE_DIR}/.git" ]]; then
    [[ -d "${LITE_DIR}" ]] && die "${LITE_DIR} exists but is not a Git checkout."
    echo "Cloning stockfish.js tag ${LITE_TAG}..."
    git clone --depth 1 --branch "${LITE_TAG}" --single-branch "${LITE_REPO}" "${LITE_DIR}"
  fi
  local tag commit
  tag="$(git -C "${LITE_DIR}" describe --tags --exact-match 2>/dev/null || true)"
  commit="$(git -C "${LITE_DIR}" rev-parse HEAD)"
  [[ "${tag}" == "${LITE_TAG}" ]] || die "expected tag ${LITE_TAG}, found '${tag:-none}'."
  [[ "${commit}" == "${LITE_COMMIT}" ]] || die "expected commit ${LITE_COMMIT}, found ${commit}."
  [[ -z "$(git -C "${LITE_DIR}" status --porcelain --untracked-files=no)" ]] \
    || die "tracked stockfish.js source is modified."
}

smoke_test() {
  local dir="$1" js="$2"
  (
    cd "${dir}"
    { printf 'uci\nisready\nposition startpos\ngo depth 6\n'; sleep 5; printf 'quit\n'; } \
      | timeout 90s node "${js}" > engine.out 2> engine.err || true
    grep -q '^bestmove ' engine.out || {
      cat engine.err >&2
      die "no bestmove from ${js}."
    }
    rm -f engine.out engine.err
  )
}

write_readme() {
  local dir="$1" title="$2" source="$3" network="$4" threads="$5" isolation="$6" js="$7"
  cat > "${dir}/README-WASM.md" <<EOF
# ${title}

This directory contains a WebAssembly build of Stockfish 19.

- Source: ${source}
- Network: \`${network}\`
- Threads: ${threads}
- Cross-origin isolation: ${isolation}

Run it under Node.js:

\`\`\`bash
printf 'uci\\nisready\\nposition startpos\\ngo depth 8\\nquit\\n' | node ${js}
\`\`\`

The files must stay in the same directory. For browser use, serve the directory
with the correct MIME types and follow the cross-origin isolation note above.
See \`docs/WASM.md\` in the KAIROS repository for details.

License: GPL-3.0. See \`LICENSE\` and \`THIRD_PARTY.md\`.
EOF
}

build_official() {
  [[ "${ARCH}" == "wasm32" || "${ARCH}" == "wasm32-relaxed-simd" ]] \
    || die "unsupported ARCH '${ARCH}' (use wasm32 or wasm32-relaxed-simd)."
  require_cmd git
  require_cmd make
  require_cmd em++
  require_cmd node
  verify_sf_source
  ensure_sf_net

  local out="${DIST}/stockfish-19-${ARCH}"
  rm -rf "${out}"
  mkdir -p "${out}"

  echo "Building official Stockfish 19 ${ARCH}..."
  make -C "${SF_DIR}/src" clean >/dev/null 2>&1 || true
  rm -f "${SF_DIR}/src/stockfish.js" "${SF_DIR}/src/stockfish.wasm" "${SF_DIR}/src/stockfish.data"
  COMPCXX=em++ make -C "${SF_DIR}/src" -j"${JOBS}" build ARCH="${ARCH}" \
    EXTRALDFLAGS="--preload-file ${SF_NET}"

  cp "${SF_DIR}/src/stockfish.js" "${out}/"
  cp "${SF_DIR}/src/stockfish.wasm" "${out}/"
  [[ -f "${SF_DIR}/src/stockfish.data" ]] && cp "${SF_DIR}/src/stockfish.data" "${out}/"
  cp "${SF_DIR}/src/${SF_NET}" "${out}/"
  cp "${ROOT}/LICENSE" "${ROOT}/THIRD_PARTY.md" "${out}/"
  write_readme "${out}" "Stockfish 19 ${ARCH} WebAssembly" \
    "official-stockfish/Stockfish sf_19 (${SF_COMMIT})" "${SF_NET}" \
    "yes" "required (SharedArrayBuffer / COOP+COEP)" "stockfish.js"
  smoke_test "${out}" "stockfish.js"

  echo "Built ${out}"
}

build_lite() {
  require_cmd git
  require_cmd make
  require_cmd node
  require_cmd npm
  require_cmd em++
  verify_lite_source

  echo "Installing stockfish.js build dependency..."
  (cd "${LITE_DIR}" && npm install --no-audit --no-fund --silent)

  local single="${DIST}/stockfish-19-lite-single"
  local multi="${DIST}/stockfish-19-lite"
  rm -rf "${single}" "${multi}"
  mkdir -p "${single}" "${multi}"

  echo "Building Stockfish 19 Lite single-threaded..."
  (cd "${LITE_DIR}" && node build.js --force --lite --single-threaded --skip-em-check \
    --basename=stockfish-19-lite-single --output-dir="${single}")
  echo "Building Stockfish 19 Lite multithreaded..."
  (cd "${LITE_DIR}" && node build.js --force --lite --skip-em-check \
    --basename=stockfish-19-lite --output-dir="${multi}")

  local dir
  for dir in "${single}" "${multi}"; do
    cp "${ROOT}/LICENSE" "${ROOT}/THIRD_PARTY.md" "${dir}/"
  done
  write_readme "${single}" "Stockfish 19 Lite single-threaded WebAssembly" \
    "nmrugg/stockfish.js v19.0.1 (${LITE_COMMIT})" "nn-61e7af4bb97d.nnue" \
    "no" "not required" "stockfish-19-lite-single.js"
  write_readme "${multi}" "Stockfish 19 Lite multithreaded WebAssembly" \
    "nmrugg/stockfish.js v19.0.1 (${LITE_COMMIT})" "nn-61e7af4bb97d.nnue" \
    "yes" "required (SharedArrayBuffer / COOP+COEP)" "stockfish-19-lite.js"

  smoke_test "${single}" "stockfish-19-lite-single.js"
  echo "Built ${single} and ${multi}"
}

mkdir -p "${DIST}"

case "${MODE}" in
  official) build_official ;;
  lite) build_lite ;;
  -h|--help|help|"") usage; [[ -z "${MODE}" ]] && exit 2 || exit 0 ;;
  *) usage; die "unknown mode '${MODE}'." ;;
esac

(cd "${DIST}" && find . -maxdepth 2 -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "Checksums: ${DIST}/SHA256SUMS"

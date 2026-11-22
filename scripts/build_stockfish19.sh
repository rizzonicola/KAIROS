#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_URL="https://github.com/official-stockfish/Stockfish.git"
TAG="sf_19"
EXPECTED_COMMIT="edb0d9db6731067ec50ce619ff372b463bc4dd5d"
EXPECTED_NNUE="nn-1a298aa575a0.nnue"
EXPECTED_NNUE_SHA256="1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2"
SOURCE_DIR="${ROOT}/third_party/Stockfish"
BUILD_DIR="${ROOT}/build"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)}"

mkdir -p "${ROOT}/third_party" "${BUILD_DIR}"

if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
  if [[ -d "${SOURCE_DIR}" ]]; then
    rmdir "${SOURCE_DIR}" 2>/dev/null || {
      echo "ERROR: ${SOURCE_DIR} exists but is not a Git checkout; refusing to overwrite it." >&2
      exit 2
    }
  fi
  echo "Cloning official Stockfish tag ${TAG}..."
  git clone --depth 1 --branch "${TAG}" --single-branch "${REPO_URL}" "${SOURCE_DIR}"
else
  echo "Using existing source checkout: ${SOURCE_DIR}"
fi

actual_tag="$(git -C "${SOURCE_DIR}" describe --tags --exact-match 2>/dev/null || true)"
actual_commit="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"
if [[ "${actual_tag}" != "${TAG}" ]]; then
  echo "ERROR: expected exact tag ${TAG}, found '${actual_tag:-no exact tag}'." >&2
  exit 2
fi
if [[ "${actual_commit}" != "${EXPECTED_COMMIT}" ]]; then
  echo "ERROR: tag ${TAG} resolved to ${actual_commit}, expected ${EXPECTED_COMMIT}." >&2
  exit 2
fi

if [[ -n "$(git -C "${SOURCE_DIR}" status --porcelain --untracked-files=no)" ]]; then
  echo "ERROR: tracked Stockfish source is modified; refusing to build." >&2
  git -C "${SOURCE_DIR}" status --short --untracked-files=no >&2
  exit 2
fi

if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
  echo "ERROR: make and g++ are required. No package installation is attempted." >&2
  exit 2
fi

# Inspect upstream targets, then build generic native x86-64 code without PGO.
# The pinned upstream build target downloads its declared default network. Source is not patched.
make -C "${SOURCE_DIR}/src" help
echo "Building ${TAG} (${actual_commit}) with ARCH=x86-64, JOBS=${JOBS}..."
# On this exact tag, upstream's build target depends on net and config-sanity.
make -C "${SOURCE_DIR}/src" -j"${JOBS}" build ARCH=x86-64

if [[ ! -x "${SOURCE_DIR}/src/stockfish" ]]; then
  echo "ERROR: expected executable was not produced: ${SOURCE_DIR}/src/stockfish" >&2
  exit 3
fi
if [[ ! -f "${SOURCE_DIR}/src/${EXPECTED_NNUE}" ]]; then
  echo "ERROR: expected Stockfish 19 NNUE is missing: ${SOURCE_DIR}/src/${EXPECTED_NNUE}" >&2
  echo "Do not substitute a different network. Check the network download/build output." >&2
  exit 4
fi

actual_nnue_sha256="$(sha256sum "${SOURCE_DIR}/src/${EXPECTED_NNUE}" | cut -d ' ' -f 1)"
if [[ "${actual_nnue_sha256}" != "${EXPECTED_NNUE_SHA256}" ]]; then
  echo "ERROR: NNUE checksum mismatch for ${EXPECTED_NNUE}." >&2
  echo "  expected ${EXPECTED_NNUE_SHA256}" >&2
  echo "  actual   ${actual_nnue_sha256}" >&2
  exit 4
fi

cp "${SOURCE_DIR}/src/stockfish" "${BUILD_DIR}/stockfish19"
chmod +x "${BUILD_DIR}/stockfish19"
binary_sha256="$(sha256sum "${BUILD_DIR}/stockfish19" | cut -d ' ' -f 1)"
sha256sum "${SOURCE_DIR}/src/${EXPECTED_NNUE}" > "${BUILD_DIR}/stockfish19-nnue.sha256"
cat > "${BUILD_DIR}/stockfish19-build.txt" <<EOF
repository=${REPO_URL}
tag=${TAG}
commit=${actual_commit}
architecture=x86-64
compiler=$(g++ --version | head -n 1)
engine=${BUILD_DIR}/stockfish19
engine_sha256=${binary_sha256}
nnue=${EXPECTED_NNUE}
nnue_sha256=${actual_nnue_sha256}
EOF

uci_output="$(printf 'uci\nquit\n' | "${BUILD_DIR}/stockfish19")"
if ! grep -q 'id name Stockfish 19' <<<"${uci_output}"; then
  echo "ERROR: executable did not identify itself as Stockfish 19." >&2
  exit 5
fi
if ! grep -q "option name EvalFile type string default ${EXPECTED_NNUE}" <<<"${uci_output}"; then
  echo "ERROR: executable does not declare the pinned default network ${EXPECTED_NNUE}." >&2
  exit 5
fi

echo "Built and identified Stockfish 19 successfully."
echo "Engine: ${BUILD_DIR}/stockfish19"
echo "Engine SHA256: ${binary_sha256}"
echo "NNUE:   ${SOURCE_DIR}/src/${EXPECTED_NNUE}"
echo "NNUE SHA256: ${actual_nnue_sha256}"

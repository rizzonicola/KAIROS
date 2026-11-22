#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="${STOCKFISH19_EXECUTABLE:-${ROOT}/build/stockfish19}"
exec python3 "${ROOT}/kairos/uci_proxy.py" --engine "${ENGINE}" --log "${KAIROS_LOG:-${ROOT}/kairos.log}" "$@"

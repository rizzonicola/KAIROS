#!/usr/bin/env bash
# Self-play SPRT harness: pinned Stockfish 19 vs KAIROS.
#
# Requires cutechess-cli on PATH. No result is claimed here; run the match and
# report the SPRT output only when the run completes. Both engines get
# Threads=1 and Hash=32.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="${STOCKFISH19_EXECUTABLE:-${ROOT}/build/stockfish19}"
CUTECHESS="${CUTECHESS_CLI:-cutechess-cli}"
STYLE="${KAIROS_SPRT_STYLE:-50}"
TC="${KAIROS_SPRT_TC:-10+0.1}"
ROUNDS="${KAIROS_SPRT_ROUNDS:-1000}"
OUT="${KAIROS_SPRT_OUT:-${ROOT}/sprt-results}"

command -v "${CUTECHESS}" >/dev/null 2>&1 || {
    echo "cutechess-cli not found; install it or set CUTECHESS_CLI" >&2
    exit 2
}
[[ -x "${ENGINE}" ]] || {
    echo "missing pinned engine: ${ENGINE}" >&2
    exit 2
}

mkdir -p "${OUT}"
echo "SPRT: Stockfish 19 vs KAIROS (style ${STYLE}), ${TC}, ${ROUNDS} rounds"
echo "PGN: ${OUT}/sprt.pgn"

exec "${CUTECHESS}" \
    -engine name="Stockfish 19" cmd="${ENGINE}" \
        option.Threads=1 option.Hash=32 \
    -engine name="KAIROS ${STYLE}" cmd="python3" \
        arg="${ROOT}/kairos/uci_proxy.py" \
        arg="--engine" arg="${ENGINE}" \
        arg="--log" arg="${OUT}/kairos-sprt.log" \
        option.Threads=1 option.Hash=32 option.KairosStyle="${STYLE}" \
    -each proto=uci tc="${TC}" \
    -games 2 -repeat -rounds "${ROUNDS}" -concurrency 1 \
    -sprt elo0=0 elo1=5 alpha=0.05 beta=0.05 \
    -pgnout "${OUT}/sprt.pgn"

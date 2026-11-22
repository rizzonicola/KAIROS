#!/usr/bin/env python3
"""Deterministic UCI protocol fixture. Not a chess engine; tests wrapper logic only."""
import os
import sys

multipv = 1
position = "position startpos"
show_wdl = False
log_path = os.environ.get("KAIROS_MOCK_LOG")
reject_verify = os.environ.get("KAIROS_MOCK_REJECT_VERIFY") == "1"
mate_main = os.environ.get("KAIROS_MOCK_MATE") == "1"
no_wdl = os.environ.get("KAIROS_MOCK_NO_WDL") == "1"
depth_mismatch = os.environ.get("KAIROS_MOCK_DEPTH_MISMATCH") == "1"
saturated_main = os.environ.get("KAIROS_MOCK_SATURATED_MAIN") == "1"
saturated_verify = os.environ.get("KAIROS_MOCK_SATURATED_VERIFY") == "1"
bound_main = os.environ.get("KAIROS_MOCK_BOUND") == "1"


def log(line: str) -> None:
    if log_path:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def emit(line: str) -> None:
    print(line, flush=True)


def wdl_suffix(wdl: str) -> str:
    return f" wdl {wdl}" if show_wdl and not no_wdl else ""


for raw in sys.stdin:
    line = raw.strip()
    if line == "uci":
        emit("id name KAIROS Mock Fixture (not Stockfish)")
        emit("id author KAIROS tests")
        emit("option name Threads type spin default 1 min 1 max 512")
        emit("option name Hash type spin default 16 min 1 max 33554432")
        emit("option name MultiPV type spin default 1 min 1 max 500")
        emit("option name UCI_ShowWDL type check default false")
        emit("uciok")
    elif line == "isready":
        emit("readyok")
    elif line.startswith("setoption name "):
        log(line)
        if "MultiPV value " in line:
            try:
                multipv = int(line.split("MultiPV value ", 1)[1])
            except ValueError:
                pass
        if "UCI_ShowWDL value true" in line:
            show_wdl = True
    elif line.startswith("position "):
        log(line)
        position = line
    elif line.startswith("go "):
        log(line)
        if "infinite" in line:
            for incoming in sys.stdin:
                if incoming.strip() == "stop":
                    emit("info depth 2 score cp 10 pv e2e4")
                    emit("bestmove e2e4")
                    break
                if incoming.strip() == "quit":
                    sys.exit(0)
            continue
        searchmoves = []
        if "searchmoves" in line:
            searchmoves = line.split("searchmoves", 1)[1].split()
        if searchmoves:
            for index, move in enumerate(searchmoves[:2], start=1):
                if saturated_verify:
                    score, wdl = (540, "1000 0 0") if index == 1 else (400, "1000 0 0")
                elif index == 1:
                    score, wdl = 20, "500 300 200"
                elif reject_verify:
                    score, wdl = 19, "450 300 250"
                else:
                    score, wdl = 19, "500 300 200"
                depth = 6 if "depth" in line else 4
                emit(f"info depth {depth} seldepth {depth} multipv {index} score cp {score}"
                     f"{wdl_suffix(wdl)} pv {move} e8e7")
            emit(f"bestmove {searchmoves[0]}")
        elif multipv > 1 and "4k3/8/8/3p4/4P3/8/2P5" in position:
            if saturated_main:
                baseline_score, baseline_wdl = 540, "1000 0 0"
                candidate_score, candidate_wdl = 400, "1000 0 0"
            else:
                baseline_score, baseline_wdl = 12, "500 300 200"
                candidate_score, candidate_wdl = 11, "500 300 200"
            baseline_bound = " upperbound" if bound_main else ""
            emit(f"info depth 4 seldepth 4 multipv 1 score cp {baseline_score}{baseline_bound}"
                 f"{wdl_suffix(baseline_wdl)} pv e1d2 e8e7")
            if mate_main:
                emit("info depth 4 seldepth 4 multipv 2 score mate 5 pv c2c4 e8e7")
            else:
                depth = 3 if depth_mismatch else 4
                emit(f"info depth {depth} seldepth {depth} multipv 2 score cp {candidate_score}"
                     f"{wdl_suffix(candidate_wdl)} pv c2c4 e8e7")
            emit("bestmove e1d2")
        elif multipv > 1:
            emit("info depth 4 seldepth 4 multipv 1 score cp 20 wdl 510 300 190 pv e2e4 e7e5")
            emit("info depth 4 seldepth 4 multipv 2 score cp 18 wdl 505 300 195 pv d2d4 d7d5")
            emit("bestmove e2e4")
        else:
            emit("info depth 4 seldepth 4 score cp 20 wdl 510 300 190 pv e2e4 e7e5")
            emit("bestmove e2e4")
    elif line == "quit":
        sys.exit(0)
    elif line == "stop":
        continue
    else:
        log("unhandled " + line)

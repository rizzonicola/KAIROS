#!/usr/bin/env python3
"""KAIROS UCI wrapper: unmodified Stockfish subprocess + cautious reranker."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import logging
import os
import queue
import random
import re
import shlex
import subprocess
import sys
import threading
from typing import Optional

from chess_features import board_from_position_command, candidate_features, position_stats
from postures import POSTURES, PostureController, dominant, one_hot, weighted_features

LOG = logging.getLogger("kairos")

# WDL is quantized at 1/1000. Above this expected score the corridor cannot
# see centipawn losses, so enforce an explicit margin instead. Engineering
# safety margin, not a Stockfish-defined threshold; calibrate before tuning.
SATURATION_EXPECTED = 0.99
SATURATION_CP_MARGIN = 50


def is_saturated(expected: float) -> bool:
    return expected >= SATURATION_EXPECTED or expected <= 1.0 - SATURATION_EXPECTED


@dataclass
class Candidate:
    multipv: int
    depth: int
    move: str
    score_kind: str
    score_value: int
    wdl: tuple[int, int, int]

    @property
    def expected_score(self) -> float:
        wins, draws, _losses = self.wdl
        return (wins + draws / 2.0) / 1000.0


@dataclass
class Search:
    mode: str
    original_go: str
    position: str
    go_kind: str = ""
    original_movetime_ms: int = 0
    stop_requested: bool = False
    phase: str = "main"
    mate_seen: bool = False
    verify_mate_seen: bool = False
    candidates: dict[int, Candidate] = field(default_factory=dict)
    verify_candidates: dict[int, Candidate] = field(default_factory=dict)
    sf_best: str = ""
    sf_best_line: str = ""
    selected: Optional[Candidate] = None
    selected_features: dict[str, float | int] = field(default_factory=dict)
    budget_pct: float = 0.0
    selected_loss_pct: float = 0.0
    main_depth: int = 0
    baseline_expected: Optional[float] = None
    position_key: str = ""
    side: str = ""
    posture_mix: dict[str, float] = field(default_factory=dict)
    posture: str = "Coil"
    confidence: float = 0.0
    scored: list[tuple[float, Candidate, dict[str, float | int], float]] = field(default_factory=list)
    probe_enabled: bool = False
    probe_kind: str = ""
    probe_moves: list[str] = field(default_factory=list)
    probe_index: int = 0
    probe_records: dict[int, Candidate] = field(default_factory=dict)
    probe_results: dict[str, dict[str, float]] = field(default_factory=dict)
    probe_mate_seen: bool = False
    probe_depth: int = 0
    probe_movetime_ms: int = 0
    probe_budget_ms: int = 0
    null_threat: Optional[float] = None
    main_movetime_ms: int = 0
    verify_movetime_ms: int = 0


def parse_info(line: str) -> Optional[Candidate]:
    tokens = line.split()
    if not tokens or tokens[0] != "info":
        return None
    values: dict[str, object] = {}
    i = 1
    while i < len(tokens):
        token = tokens[i]
        if token in ("depth", "seldepth", "multipv", "nodes", "nps", "hashfull", "tbhits", "time"):
            if i + 1 < len(tokens):
                try:
                    values[token] = int(tokens[i + 1])
                except ValueError:
                    pass
                i += 2
                continue
        elif token == "score" and i + 2 < len(tokens):
            # Bound scores are not exact evaluations; never rerank on them.
            if i + 3 < len(tokens) and tokens[i + 3] in ("lowerbound", "upperbound"):
                return None
            values["score_kind"] = tokens[i + 1]
            try:
                values["score_value"] = int(tokens[i + 2])
            except ValueError:
                pass
            i += 3
            continue
        elif token == "wdl" and i + 3 < len(tokens):
            try:
                values["wdl"] = tuple(int(x) for x in tokens[i + 1:i + 4])
            except ValueError:
                pass
            i += 4
            continue
        elif token == "pv":
            values["pv"] = tokens[i + 1:]
            break
        i += 1

    pv = values.get("pv")
    wdl = values.get("wdl")
    if not isinstance(pv, list) or not pv or not isinstance(wdl, tuple):
        return None
    if len(wdl) != 3 or sum(wdl) <= 0:
        return None
    if "depth" not in values or "score_kind" not in values or "score_value" not in values:
        return None
    return Candidate(
        multipv=int(values.get("multipv", 1)),
        depth=int(values["depth"]),
        move=str(pv[0]),
        score_kind=str(values["score_kind"]),
        score_value=int(values["score_value"]),
        wdl=wdl,
    )


def result_band(expected: float) -> int:
    """Conservative prototype bands; thresholds are documented, not SF-defined."""
    if expected >= 0.55:
        return 1  # win-leaning
    if expected <= 0.45:
        return -1  # loss-leaning
    return 0


def supported_personality_search(go_line: str) -> tuple[bool, str, int]:
    """Only rerank searches with a bounded verification budget.

    Clock-based controls, ponder, infinite, node and perft searches stay exact
    Stockfish passthroughs in this prototype.
    """
    tokens = go_line.split()[1:]
    if not tokens or any(x in tokens for x in ("infinite", "ponder", "perft", "nodes", "mate", "wtime", "btime", "winc", "binc", "movestogo")):
        return False, "unsupported-or-clock-search", 0
    if sum(tokens.count(x) for x in ("depth", "movetime")) != 1:
        return False, "multiple-or-missing-limits", 0
    if "depth" in tokens:
        try:
            depth = int(tokens[tokens.index("depth") + 1])
        except (ValueError, IndexError):
            return False, "invalid-depth", 0
        if depth < 1:
            return False, "invalid-depth", 0
        return True, "depth", depth
    if "movetime" in tokens:
        try:
            movetime = int(tokens[tokens.index("movetime") + 1])
        except (ValueError, IndexError):
            return False, "invalid-movetime", 0
        if movetime < 1500:
            return False, "time-too-low", movetime
        return True, "movetime", movetime
    return False, "no-bounded-verification-budget", 0


class KairosProxy:
    def __init__(self, engine_command: list[str], log_path: str, log_stderr: bool = False,
                 allow_unverified_engine: bool = False):
        self.engine_command = engine_command
        self.events: queue.Queue[tuple[str, Optional[str]]] = queue.Queue()
        self.engine_lock = threading.Lock()
        self.output_lock = threading.Lock()
        self.stdin_eof = False
        self.running = True
        self.waiting_uci = False
        self.engine_id = ""
        self.allow_unverified_engine = allow_unverified_engine
        self.engine_options: set[str] = set()
        self.search: Optional[Search] = None
        self.position_line = "position startpos"
        self.deferred: list[str] = []
        self.handshake_buffer: list[str] = []
        self.quit_after_search = False
        self.style = 50
        self.variety = 0
        self.verbose = False
        self.forced_posture: Optional[str] = None
        self.posture = PostureController()
        seed = os.environ.get("KAIROS_SEED", "")
        self.rng = random.Random(int(seed) if seed.lstrip("-").isdigit() else None)
        self.log_stderr = log_stderr
        self.log_file = None
        if log_path:
            self.log_file = open(log_path, "a", encoding="utf-8")
        self.engine = subprocess.Popen(
            engine_command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        threading.Thread(target=self._read_engine, name="kairos-engine-reader", daemon=True).start()
        threading.Thread(target=self._read_engine_stderr, name="kairos-engine-stderr", daemon=True).start()
        threading.Thread(target=self._read_stdin, name="kairos-stdin-reader", daemon=True).start()
        self._log("started engine=%r pid=%s", engine_command, self.engine.pid)

    def _log(self, message: str, *args: object) -> None:
        if self.log_file:
            self.log_file.write((message % args if args else message) + "\n")
            self.log_file.flush()
        if self.log_stderr:
            print(message % args if args else message, file=sys.stderr, flush=True)

    def _read_engine(self) -> None:
        assert self.engine.stdout is not None
        for raw in self.engine.stdout:
            self.events.put(("engine", raw.rstrip("\r\n")))
        self.events.put(("engine-eof", None))

    def _read_engine_stderr(self) -> None:
        assert self.engine.stderr is not None
        for raw in self.engine.stderr:
            self._log("stockfish stderr: %s", raw.rstrip("\r\n"))

    def _read_stdin(self) -> None:
        for raw in sys.stdin:
            self.events.put(("input", raw.rstrip("\r\n")))
        self.events.put(("stdin-eof", None))

    def _out(self, line: str) -> None:
        with self.output_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def _send(self, line: str) -> None:
        if self.engine.poll() is not None or self.engine.stdin is None:
            self._log("cannot send to exited engine: %s", line)
            return
        with self.engine_lock:
            self.engine.stdin.write(line + "\n")
            self.engine.stdin.flush()
        self._log("-> %s", line)

    def run(self) -> int:
        try:
            while self.running:
                kind, payload = self.events.get()
                if kind == "input":
                    if payload is not None:
                        self._handle_input(payload.strip())
                elif kind == "engine":
                    if payload is not None:
                        self._handle_engine(payload)
                elif kind == "stdin-eof":
                    self.stdin_eof = True
                    if self.search is not None:
                        self.quit_after_search = True
                        self._request_stop()
                    else:
                        self._send("quit")
                        self.running = False
                elif kind == "engine-eof":
                    self._log("engine stdout closed")
                    self.running = False
        finally:
            self._shutdown()
        return 0

    def _handle_input(self, line: str) -> None:
        if not line:
            return
        self._log("<- %s", line)
        command = line.split()[0]
        if self.waiting_uci and command not in ("uci", "quit"):
            # Hold GUI commands until uciok, so options such as UCI_ShowWDL
            # reach the engine before any position/go from the same batch.
            self.handshake_buffer.append(line)
            return
        if command == "uci":
            self.waiting_uci = True
            self._send(line)
            return
        if command == "isready":
            self._send(line)
            return
        if command == "setoption":
            self._handle_setoption(line)
            return
        if command == "stop":
            self._request_stop()
            return
        if command == "ponderhit":
            self._send(line)
            return
        if command == "quit":
            if self.search is not None:
                self.quit_after_search = True
                self._request_stop()
            else:
                self._send("quit")
                self.running = False
            return
        if command == "position":
            self.position_line = line
        if self.search is not None and command in ("position", "go", "ucinewgame", "debug", "register"):
            self.deferred.append(line)
            self._request_stop()
            return
        if command == "go":
            self._start_search(line)
            return
        if command == "ucinewgame":
            self.posture.reset()
            if self.forced_posture:
                self.posture.mix = one_hot(self.forced_posture)
            self._send(line)
            return
        # Unknown UCI commands are passed through unchanged.
        self._send(line)

    def _handle_setoption(self, line: str) -> None:
        body = line[len("setoption"):].strip()
        name_value = body[len("name"):].strip() if body.startswith("name") else body
        if " value " in name_value:
            name, value = name_value.split(" value ", 1)
        else:
            name, value = name_value, ""
        name = name.strip()
        value = value.strip()
        if name.lower() == "kairosstyle":
            try:
                self.style = max(0, min(100, int(value)))
            except ValueError:
                self._log("ignored invalid KairosStyle=%r", value)
            return
        if name.lower() == "kairosverbose":
            self.verbose = value.lower() in ("true", "1", "yes")
            return
        if name.lower() == "kairosposture":
            if value.lower() == "auto":
                self.forced_posture = None
            else:
                posture = next((item for item in POSTURES if item.lower() == value.lower()), None)
                if posture is None:
                    self._log("ignored invalid KairosPosture=%r", value)
                else:
                    self.forced_posture = posture
                    self.posture.mix = one_hot(posture)
            return
        if name.lower() == "kairosvariety":
            try:
                self.variety = max(0, min(100, int(value)))
            except ValueError:
                self._log("ignored invalid KairosVariety=%r", value)
            return
        if name.lower() == "threads":
            self._send("setoption name Threads value 1")
            self._log("forced Threads=1 (requested %r)", value)
            return
        if name.lower() == "multipv":
            self._log("ignored external MultiPV=%r; wrapper controls it", value)
            return
        if name.lower() == "uci_showwdl":
            if "UCI_ShowWDL" in self.engine_options:
                self._send("setoption name UCI_ShowWDL value true")
            return
        if self.search is not None:
            self.deferred.append(line)
            self._request_stop()
        else:
            self._send(line)

    def _request_stop(self) -> None:
        if self.search is not None and not self.search.stop_requested:
            self.search.stop_requested = True
            self._send("stop")

    def _handle_engine(self, line: str) -> None:
        self._log("<-engine %s", line)
        if self.waiting_uci:
            if line.startswith("id name "):
                self.engine_id = line[len("id name "):].strip()
                self._out(line)
                return
            if line.startswith("option name "):
                match = re.match(r"option name (.+?) type ", line)
                if match:
                    name = match.group(1)
                    self.engine_options.add(name)
                    if name.lower() in ("threads", "multipv", "uci_showwdl"):
                        return
                self._out(line)
                return
            if line == "uciok":
                if not self.allow_unverified_engine and "Stockfish 19" not in self.engine_id:
                    self._out(f"info string KAIROS startup refused: expected Stockfish 19 (sf_19), backend reported '{self.engine_id or 'no id name'}'")
                    self._out("uciok")
                    self.waiting_uci = False
                    self.handshake_buffer.clear()
                    self.running = False
                    return
                self._out("option name KairosStyle type spin default 50 min 0 max 100")
                self._out("option name KairosPosture type combo default Auto var Auto var Coil var Strike var Absorb var Reverse var Distill var Fog")
                self._out("option name KairosVariety type spin default 0 min 0 max 100")
                self._out("option name KairosVerbose type check default false")
                self._out("uciok")
                self.waiting_uci = False
                if "Threads" in self.engine_options:
                    self._send("setoption name Threads value 1")
                if "Hash" in self.engine_options:
                    self._send("setoption name Hash value 32")
                if "MultiPV" in self.engine_options:
                    self._send("setoption name MultiPV value 1")
                if "UCI_ShowWDL" in self.engine_options:
                    self._send("setoption name UCI_ShowWDL value true")
                pending, self.handshake_buffer = self.handshake_buffer, []
                for pending_line in pending:
                    self._handle_input(pending_line)
                return
        if self.search is None:
            self._out(line)
            return

        current = self.search
        if line.startswith("info "):
            if current.mode == "personality":
                info_tokens = line.split()
                if "score" in info_tokens:
                    score_index = info_tokens.index("score")
                    if score_index + 1 < len(info_tokens) and info_tokens[score_index + 1] == "mate":
                        if current.phase == "main":
                            current.mate_seen = True
                        elif current.phase == "probe":
                            current.probe_mate_seen = True
                        else:
                            current.verify_mate_seen = True
                candidate = parse_info(line)
                if candidate is not None:
                    if current.phase == "main":
                        target = current.candidates
                    elif current.phase == "probe":
                        target = current.probe_records
                    else:
                        target = current.verify_candidates
                    previous = target.get(candidate.multipv)
                    if previous is None or candidate.depth >= previous.depth:
                        target[candidate.multipv] = candidate
                if current.phase in ("probe", "verify"):
                    # Internal probe and verification scores must not reach the GUI.
                    return
            self._out(line)
            return

        if line.startswith("bestmove "):
            if current.phase == "main" and current.mode == "personality":
                self._finish_main(line)
                return
            if current.phase == "probe":
                self._finish_probe(line)
                return
            if current.phase == "verify":
                self._finish_verification(line)
                return
            # transparent path, including a stopped personality search
            self._out(line)
            self._search_finished()
            return
        self._out(line)

    def _start_search(self, go_line: str) -> None:
        self._send("setoption name MultiPV value 1")
        if self.style == 0:
            self.search = Search("passthrough", go_line, self.position_line)
            self._send(go_line)
            return
        supported, go_kind, amount = supported_personality_search(go_line)
        if not supported:
            self._log("personality bypass: %s", go_kind)
            self.search = Search("passthrough", go_line, self.position_line)
            self._send(go_line)
            return
        board = board_from_position_command(self.position_line)
        self._send("setoption name MultiPV value 5")
        search = Search(
            "personality",
            go_line,
            self.position_line,
            go_kind=go_kind,
            position_key=board.position_key() if board else "",
            side=board.turn if board else "",
        )
        if go_kind == "depth":
            search.main_depth = amount
            modified_go = go_line
        else:
            search.original_movetime_ms = amount
            main_share = 0.65 if amount >= 3000 else 0.75
            search.main_movetime_ms = max(100, int(amount * main_share))
            search.verify_movetime_ms = max(50, int(amount * 0.10))
            modified_go = re.sub(r"\bmovetime\s+\d+", f"movetime {search.main_movetime_ms}", go_line, count=1)
        self.search = search
        self._log("KAIROS main search style=%d go=%s", self.style, modified_go)
        self._send(modified_go)

    def _feature_board(self, search: Search):
        return board_from_position_command(search.position)

    def _eligible_candidates(
        self, search: Search
    ) -> tuple[list[tuple[Candidate, dict[str, float | int], float]], float]:
        """Apply the corridor, result band and saturation guards, then score cheaply."""
        candidates = list(search.candidates.values())
        if not candidates:
            return [], 0.0
        # Only compare candidates from the same completed depth as SF's best.
        sf_best = search.sf_best
        baseline = next((c for c in candidates if c.move == sf_best), None)
        if baseline is None:
            return [], 0.0
        candidates = [c for c in candidates if c.depth == baseline.depth]
        if len(candidates) < 2 or any(c.score_kind == "mate" for c in candidates):
            return [], 0.0
        baseline_exp = baseline.expected_score
        search.baseline_expected = baseline_exp
        saturated = is_saturated(baseline_exp)
        budget_pct = 1.5 * self.style / 100.0  # fixed single-move budget from specification
        board = self._feature_board(search)
        eligible: list[tuple[Candidate, dict[str, float | int], float]] = []
        for candidate in candidates:
            loss_pct = max(0.0, (baseline_exp - candidate.expected_score) * 100.0)
            if loss_pct > budget_pct + 1e-9:
                continue
            if result_band(candidate.expected_score) < result_band(baseline_exp):
                continue
            if saturated:
                # WDL saturates at 1000/0, hiding real centipawn losses.
                if baseline.score_kind != "cp" or candidate.score_kind != "cp":
                    continue
                if candidate.score_value < baseline.score_value - SATURATION_CP_MARGIN:
                    continue
            eligible.append((candidate, candidate_features(board, candidate.move), loss_pct))
        return eligible, budget_pct

    def _probe_features(self, search: Search, move: str) -> dict[str, float]:
        """Measured narrowness and prophylaxis; neutral when a probe is missing."""
        record = search.probe_results.get(move)
        if not record:
            return {}
        best = record.get("best")
        replies = record.get("replies") or []
        if best is None or not replies:
            return {}
        near = sum(1 for value in replies if value >= best - 0.05) / len(replies)
        second = record.get("second")
        bonus = 0.5 if second is not None and best - second > 0.10 else 0.0
        narrowness = max(-1.0, min(1.0, 1.0 - near + bonus))
        prophylaxis = 0.0
        if search.null_threat is not None:
            prophylaxis = max(-1.0, min(1.0, (search.null_threat - best) / 0.20))
        return {"F_N": narrowness, "F_P": prophylaxis}

    def _score_candidates(
        self, search: Search, eligible: list[tuple[Candidate, dict[str, float | int], float]]
    ) -> list[tuple[float, Candidate, dict[str, float | int], float]]:
        style_scale = self.style / 100.0
        mix = search.posture_mix
        scored: list[tuple[float, Candidate, dict[str, float | int], float]] = []
        for candidate, features, loss_pct in eligible:
            measured = dict(features)
            measured.update(self._probe_features(search, candidate.move))
            # One weight unit is roughly 0.1% expected score; the loss term
            # stays in percentage points and remains dominant.
            personality_pct = style_scale * 0.1 * weighted_features(mix, measured)
            scored.append((-loss_pct + personality_pct, candidate, measured, loss_pct))
        scored.sort(key=lambda item: (item[0], -item[1].multipv), reverse=True)
        return scored

    def _probes_enabled(self, search: Search) -> bool:
        if search.go_kind == "depth":
            return search.main_depth >= 6
        return search.original_movetime_ms >= 3000

    def _start_probes(self, search: Search) -> bool:
        board = self._feature_board(search)
        if board is None or not search.scored:
            return False
        moves = [item[1].move for item in search.scored[:4]]
        if search.sf_best not in moves:
            moves = (moves[:3] + [search.sf_best]) if len(moves) >= 4 else moves + [search.sf_best]
        labels: list[str] = []
        if board.null_move_fen() is not None:
            labels.append("null")
        labels.extend(moves)
        if not labels:
            return False
        search.probe_moves = labels
        search.probe_index = 0
        search.phase = "probe"
        if search.go_kind == "depth":
            search.probe_depth = max(1, search.main_depth - 3)
        else:
            search.probe_budget_ms = max(25, int(search.original_movetime_ms * 0.25))
            search.probe_movetime_ms = max(25, search.probe_budget_ms // len(labels))
        self._send_probe(search)
        return True

    def _send_probe(self, search: Search) -> None:
        label = search.probe_moves[search.probe_index]
        search.probe_records = {}
        search.probe_kind = "null" if label == "null" else "candidate"
        board = self._feature_board(search)
        if board is None:
            self._finish_probes(search)
            return
        if label == "null":
            null_fen = board.null_move_fen()
            if null_fen is None:
                self._advance_probe(search)
                return
            position = f"position fen {null_fen}"
            multipv = 1
        else:
            try:
                position = f"position fen {board.apply_uci(label).to_fen()}"
            except ValueError:
                self._log("probe skipped invalid move %s", label)
                self._advance_probe(search)
                return
            multipv = 3
        if search.go_kind == "depth":
            go = f"go depth {search.probe_depth}"
        else:
            go = f"go movetime {search.probe_movetime_ms}"
        self._log("probe %s %s", label, go)
        self._send(f"setoption name MultiPV value {multipv}")
        self._send(position)
        self._send(go)

    def _advance_probe(self, search: Search) -> None:
        search.probe_index += 1
        if search.probe_index < len(search.probe_moves):
            self._send_probe(search)
        else:
            self._finish_probes(search)

    def _finish_probe(self, bestmove_line: str) -> None:
        assert self.search is not None
        search = self.search
        label = search.probe_moves[search.probe_index]
        records = list(search.probe_records.values())
        if records:
            deepest = max(c.depth for c in records)
            records = [c for c in records if c.depth == deepest]
        if any(c.score_kind == "mate" for c in records):
            search.probe_mate_seen = True
        if records and not search.probe_mate_seen:
            expected = sorted((c.expected_score for c in records), reverse=True)
            if label == "null":
                search.null_threat = expected[0]
            else:
                search.probe_results[label] = {
                    "best": expected[0],
                    "second": expected[1] if len(expected) > 1 else None,
                    "replies": expected,
                }
        if search.stop_requested:
            self._log("stopped during probe; returning Stockfish best")
            self._out(search.sf_best_line)
            self._search_finished()
            return
        self._advance_probe(search)

    def _finish_probes(self, search: Search) -> None:
        if search.stop_requested or search.probe_mate_seen:
            self._log("probe uncertainty; returning Stockfish best")
            self._out(search.sf_best_line)
            self._search_finished()
            return
        search.scored = self._score_candidates(
            search, [(candidate, features, loss) for _score, candidate, features, loss in search.scored]
        )
        self._finish_scoring(search)

    def _finish_scoring(self, search: Search) -> None:
        if not search.scored:
            self._log("no eligible rerank; returning Stockfish best")
            self._out(search.sf_best_line)
            self._search_finished()
            return
        _score, picked, features, loss_pct = search.scored[0]
        baseline_item = next((item for item in search.scored if item[1].move == search.sf_best), None)
        # Require a strict personality advantage; ties stay with Stockfish.
        if picked.move == search.sf_best or baseline_item is None or _score <= baseline_item[0] + 1e-12:
            self._log("no eligible rerank; returning Stockfish best")
            self._out(search.sf_best_line)
            self._search_finished()
            return
        search.selected = picked
        search.selected_features = features
        search.selected_loss_pct = loss_pct
        search.phase = "verify"
        if search.go_kind == "depth":
            verify_go = f"go depth {search.main_depth + 2} searchmoves {search.sf_best} {picked.move}"
        else:
            verify_ms = search.verify_movetime_ms or max(50, int(search.original_movetime_ms * 0.10))
            verify_go = f"go movetime {verify_ms} searchmoves {search.sf_best} {picked.move}"
        self._send("setoption name MultiPV value 2")
        self._send(search.position)
        self._log("verify candidate=%s versus sf_best=%s budget=%.3f%%", picked.move, search.sf_best, search.budget_pct)
        self._send(verify_go)

    def _finish_main(self, bestmove_line: str) -> None:
        assert self.search is not None
        search = self.search
        parts = bestmove_line.split()
        search.sf_best = parts[1] if len(parts) > 1 else ""
        search.sf_best_line = bestmove_line
        if search.stop_requested:
            self._log("stopped during main search; returning Stockfish best")
            self._out(bestmove_line)
            self._search_finished()
            return
        if search.mate_seen or any(c.score_kind == "mate" for c in search.candidates.values()):
            self._log("mate score observed; returning Stockfish best")
            self._out(bestmove_line)
            self._search_finished()
            return
        mix = self.posture.mix
        search.posture_mix = dict(mix)
        search.posture = dominant(mix)
        search.confidence = max(mix.values())
        eligible, budget_pct = self._eligible_candidates(search)
        if not eligible:
            self._log("no eligible rerank; returning Stockfish best")
            self._out(bestmove_line)
            self._search_finished()
            return
        search.budget_pct = budget_pct
        search.scored = self._score_candidates(search, eligible)
        if self._probes_enabled(search) and self._start_probes(search):
            return
        self._finish_scoring(search)

    def _finish_verification(self, verify_bestmove_line: str) -> None:
        assert self.search is not None
        search = self.search
        picked = search.selected
        accepted = False
        verified_loss = float("inf")
        reason = "missing-verification-data"
        if search.verify_mate_seen:
            reason = "mate-guard"
        elif search.stop_requested:
            reason = "stopped-during-verification"
        elif picked is not None:
            records = list(search.verify_candidates.values())
            by_move = {c.move: c for c in records}
            sf_record = by_move.get(search.sf_best)
            candidate_record = by_move.get(picked.move)
            if sf_record and candidate_record:
                if sf_record.depth != candidate_record.depth:
                    reason = "verification-depth-mismatch"
                elif sf_record.score_kind == "mate" or candidate_record.score_kind == "mate":
                    reason = "mate-guard"
                else:
                    verified_loss = max(0.0, (sf_record.expected_score - candidate_record.expected_score) * 100.0)
                    same_band = result_band(candidate_record.expected_score) >= result_band(sf_record.expected_score)
                    accepted = verified_loss <= search.budget_pct + 1e-9 and same_band
                    if accepted and is_saturated(sf_record.expected_score):
                        # Same saturation guard as the main corridor, applied
                        # to the verifier's own WDL/cp records.
                        if (sf_record.score_kind != "cp" or candidate_record.score_kind != "cp"
                                or candidate_record.score_value < sf_record.score_value - SATURATION_CP_MARGIN):
                            accepted = False
                            reason = "saturated-score-margin"
                    if accepted:
                        reason = "verified"
                    elif reason != "saturated-score-margin":
                        reason = "verification-outside-corridor-or-result-band"
            else:
                reason = "candidate-or-baseline-not-returned-by-verifier"
        if accepted and picked is not None:
            f = search.selected_features
            rationale = (
                f"info string kairos posture={search.posture.upper()} "
                f"conf={search.confidence:.2f} "
                f"T={f.get('T', 0)} budget={search.budget_pct:.3f}% "
                f"loss={verified_loss:.3f}% pick={picked.multipv}/5 "
                f"sf_best={search.sf_best} "
                f"F_T={float(f.get('F_T', 0)):.3f} "
                f"F_N={float(f.get('F_N', 0)):.3f} "
                f"F_R={float(f.get('F_R', 0)):.3f} "
                f"F_C={float(f.get('F_C', 0)):.3f} "
                f"F_F={float(f.get('F_F', 0)):.3f} "
                f"F_P={float(f.get('F_P', 0)):.3f} "
                f"F_K={float(f.get('F_K', 0)):.3f} "
                f"F_S={float(f.get('F_S', 0)):.3f} "
                f"F_I={float(f.get('F_I', 0)):.3f}"
            )
            if self.verbose:
                self._out(rationale)
            self._log("accepted pick=%s verified_loss=%.4f%%", picked.move, verified_loss)
            self._out(f"bestmove {picked.move}")
        else:
            self._log("verification rejected pick=%s reason=%s loss=%s", picked.move if picked else None, reason, verified_loss)
            self._out(search.sf_best_line)
        self._search_finished()

    def _search_finished(self) -> None:
        self.search = None
        self._send("setoption name MultiPV value 1")
        if self.quit_after_search:
            self._send("quit")
            self.running = False
            return
        while self.deferred and self.search is None and self.running:
            line = self.deferred.pop(0)
            self._handle_input(line)

    def _shutdown(self) -> None:
        try:
            if self.engine.poll() is None:
                try:
                    self._send("quit")
                except Exception:
                    pass
                try:
                    self.engine.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    self.engine.terminate()
                    try:
                        self.engine.wait(timeout=1.0)
                    except subprocess.TimeoutExpired:
                        self.engine.kill()
        finally:
            if self.log_file:
                self.log_file.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="KAIROS UCI wrapper around an unmodified Stockfish process")
    parser.add_argument("--engine", default=os.environ.get("STOCKFISH19_EXECUTABLE", "stockfish"),
                        help="Stockfish 19 executable command (default: STOCKFISH19_EXECUTABLE or stockfish)")
    parser.add_argument("--log", default="kairos.log", help="diagnostic log file; empty string disables file logging")
    parser.add_argument("--log-stderr", action="store_true", help="also mirror diagnostics to stderr")
    parser.add_argument("--allow-unverified-engine", action="store_true",
                        help="test-only: permit a non-Stockfish backend fixture")
    args = parser.parse_args()
    command = shlex.split(args.engine)
    if not command:
        parser.error("--engine must name an executable")
    try:
        proxy = KairosProxy(command, args.log, args.log_stderr, args.allow_unverified_engine)
    except (OSError, ValueError) as exc:
        print(f"KAIROS: cannot start Stockfish subprocess: {exc}", file=sys.stderr, flush=True)
        return 2
    return proxy.run()


if __name__ == "__main__":
    raise SystemExit(main())

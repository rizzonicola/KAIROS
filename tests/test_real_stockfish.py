"""Real Stockfish 19 integration tests.

Skipped when the pinned build is absent. These tests exercise the actual
engine process; the mock suite remains the protocol-only fast path.
"""

import hashlib
import os
import queue
import re
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "build" / "stockfish19"
NNUE = ROOT / "third_party" / "Stockfish" / "src" / "nn-1a298aa575a0.nnue"
NNUE_SHA256 = "1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2"
QUEENS_GAMBIT_FEN = "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2"
BESTMOVE_RE = re.compile(r"^bestmove [a-h][1-8][a-h][1-8][qrbn]?(?: ponder [a-h][1-8][a-h][1-8][qrbn]?)?$")

sys.path.insert(0, str(ROOT / "tests"))
from test_protocol import UCIClient  # noqa: E402


class RawEngine:
    """Minimal direct UCI client used to compare neutral mode with Stockfish."""

    def __init__(self):
        self.proc = subprocess.Popen(
            [str(ENGINE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self.output = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for raw in self.proc.stdout:
            self.output.put(raw.rstrip("\r\n"))
        self.output.put(None)

    def send(self, line):
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def read_until(self, predicate, timeout=60):
        lines = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                line = self.output.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                break
            if line is None:
                break
            lines.append(line)
            if predicate(line):
                return lines
        raise AssertionError(f"timed out waiting for engine output; received: {lines}")

    def handshake(self):
        self.send("uci")
        self.read_until(lambda x: x == "uciok")

    def close(self):
        if self.proc.poll() is None:
            try:
                self.send("quit")
            except OSError:
                pass
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=2)
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                if stream:
                    stream.close()
            except OSError:
                pass


@unittest.skipUnless(
    ENGINE.is_file() and os.access(ENGINE, os.X_OK),
    "build/stockfish19 not present; run scripts/build_stockfish19.sh",
)
class RealStockfishTests(unittest.TestCase):
    def setUp(self):
        self.client = UCIClient(allow_unverified=False, engine=str(ENGINE))

    def tearDown(self):
        self.client.close()

    def test_identity_nnue_hash_and_single_thread(self):
        if not NNUE.is_file():
            self.skipTest("original NNUE not present; the native build embeds it")
        self.assertEqual(hashlib.sha256(NNUE.read_bytes()).hexdigest(), NNUE_SHA256)
        lines = self.client.handshake()
        self.assertTrue(any(line == "id name Stockfish 19" for line in lines), lines)
        log = self.client.kairos_log.read_text(encoding="utf-8")
        self.assertIn("setoption name Threads value 1", log)

    def test_style_zero_matches_direct_stockfish(self):
        self.client.handshake()
        self.client.send("setoption name KairosStyle value 0")
        self.client.send("position startpos")
        self.client.send("go depth 8")
        wrapper_best = self.client.read_until(lambda x: x.startswith("bestmove "))[-1]

        direct = RawEngine()
        try:
            direct.handshake()
            direct.send("setoption name Threads value 1")
            direct.send("setoption name Hash value 32")
            direct.send("setoption name MultiPV value 1")
            direct.send("setoption name UCI_ShowWDL value true")
            direct.send("isready")
            direct.read_until(lambda x: x == "readyok")
            direct.send("position startpos")
            direct.send("go depth 8")
            direct_best = direct.read_until(lambda x: x.startswith("bestmove "))[-1]
        finally:
            direct.close()

        self.assertEqual(wrapper_best.split()[1], direct_best.split()[1])

    def test_real_searchmoves_verification_and_info_suppression(self):
        self.client.handshake()
        self.client.send("setoption name KairosVerbose value true")
        self.client.send(f"position fen {QUEENS_GAMBIT_FEN}")
        self.client.send("go depth 10")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1].split()[1], "c2c4")
        self.assertTrue(any("kairos posture=COIL" in line for line in lines))
        self.assertTrue(any("Using 1 thread" in line for line in lines))
        self.assertFalse(any(line.startswith("info depth 12") for line in lines))
        log = self.client.kairos_log.read_text(encoding="utf-8")
        self.assertIn("verify candidate=c2c4 versus sf_best=g1f3", log)
        self.assertIn("go depth 12 searchmoves g1f3 c2c4", log)
        self.assertIn("accepted pick=c2c4", log)

    def test_real_movetime_reserves_verification_time(self):
        self.client.handshake()
        self.client.send(f"position fen {QUEENS_GAMBIT_FEN}")
        start = time.monotonic()
        self.client.send("go movetime 2000")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "), timeout=10)
        elapsed = time.monotonic() - start
        self.assertRegex(lines[-1], BESTMOVE_RE)
        self.assertLess(elapsed, 3.5)
        log = self.client.kairos_log.read_text(encoding="utf-8")
        self.assertIn("go movetime 1500", log)

    def test_real_wdl_saturation_falls_back_to_best(self):
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 10")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1].split()[1], "e4d5")
        log = self.client.kairos_log.read_text(encoding="utf-8")
        self.assertIn("no eligible rerank", log)
        self.assertNotIn("verify candidate", log)

    def test_real_stop_and_quit(self):
        self.client.handshake()
        self.client.send("go infinite")
        time.sleep(0.3)
        self.client.send("stop")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "), timeout=10)
        self.assertRegex(lines[-1], BESTMOVE_RE)
        self.client.send("quit")
        self.client.proc.wait(timeout=5)
        self.assertEqual(self.client.proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()

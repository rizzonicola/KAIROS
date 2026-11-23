import os
import queue
import threading
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "kairos" / "uci_proxy.py"
MOCK = ROOT / "tests" / "mock_stockfish.py"
sys.path.insert(0, str(ROOT / "kairos"))
from uci_proxy import parse_info, supported_personality_search  # noqa: E402


class UCIClient:
    def __init__(self, env=None, allow_unverified=True, engine=None):
        self.tmp = tempfile.TemporaryDirectory(prefix="kairos-test-")
        self.mock_log = Path(self.tmp.name) / "mock.log"
        self.kairos_log = Path(self.tmp.name) / "kairos.log"
        merged = os.environ.copy()
        merged["KAIROS_MOCK_LOG"] = str(self.mock_log)
        if env:
            merged.update(env)
        engine_command = engine or f"{sys.executable} {MOCK}"
        command = [sys.executable, str(WRAPPER), "--engine", engine_command, "--log", str(self.kairos_log)]
        if allow_unverified:
            command.append("--allow-unverified-engine")
        self.proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=merged,
        )
        self.output = queue.Queue()
        threading.Thread(target=self._read_stdout, daemon=True).start()

    def _read_stdout(self):
        for line in self.proc.stdout:
            self.output.put(line.rstrip("\r\n"))
        self.output.put(None)

    def send(self, line):
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def read_until(self, predicate, timeout=5):
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
        raise AssertionError(f"timed out waiting for output; received: {lines}; stderr={self.proc.stderr.read() if self.proc.poll() is not None else ''}")

    def handshake(self):
        self.send("uci")
        lines = self.read_until(lambda x: x == "uciok")
        self.assert_in = lines
        self.send("isready")
        self.read_until(lambda x: x == "readyok")
        return lines

    def close(self):
        if self.proc.poll() is None:
            try:
                self.send("quit")
            except (BrokenPipeError, OSError):
                pass
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=2)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                if stream:
                    stream.close()
            except OSError:
                pass
        self.tmp.cleanup()


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.client = UCIClient()

    def tearDown(self):
        self.client.close()

    def test_handshake_and_threads_one(self):
        lines = self.client.handshake()
        self.assertTrue(any("KairosStyle" in line for line in lines))
        self.assertTrue(any("KairosVerbose" in line for line in lines))
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertIn("setoption name Threads value 1", log)
        self.assertIn("setoption name UCI_ShowWDL value true", log)

    def test_handshake_advertises_personality_options(self):
        lines = self.client.handshake()
        self.assertTrue(any("KairosPosture" in line for line in lines))
        self.assertTrue(any("KairosVariety" in line for line in lines))

    def test_forced_fog_posture_reranks(self):
        self.client.handshake()
        self.client.send("setoption name KairosPosture value Fog")
        self.client.send("setoption name KairosVerbose value true")
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertTrue(any(x.startswith("info string kairos posture=FOG") for x in lines))
        self.assertEqual(lines[-1], "bestmove c2c4")

    def test_forced_distill_posture_keeps_stockfish_best(self):
        self.client.handshake()
        self.client.send("setoption name KairosPosture value Distill")
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e1d2")
        self.assertNotIn("searchmoves", self.client.mock_log.read_text(encoding="utf-8"))

    def test_non_stockfish_backend_is_refused_by_default(self):
        self.client.close()
        self.client = UCIClient(allow_unverified=False)
        self.client.send("uci")
        lines = self.client.read_until(lambda x: x == "uciok")
        self.assertTrue(any("startup refused: expected Stockfish 19" in line for line in lines))
        self.client.proc.wait(timeout=3)

    def test_style_zero_is_stockfish_best_move_passthrough(self):
        self.client.handshake()
        self.client.send("setoption name KairosStyle value 0")
        self.client.send("position startpos")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e2e4")
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertNotIn("setoption name MultiPV value 5", log)

    def test_coil_reranks_within_corridor_and_verifies(self):
        self.client.handshake()
        self.client.send("setoption name KairosVerbose value true")
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertTrue(any(x.startswith("info string kairos posture=COIL") for x in lines))
        self.assertEqual(lines[-1], "bestmove c2c4")
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertIn("setoption name MultiPV value 5", log)
        self.assertIn("searchmoves e1d2 c2c4", log)

    def test_depth_search_probes_narrowness_and_prophylaxis(self):
        self.client.handshake()
        self.client.send("setoption name KairosVerbose value true")
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 6")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove c2c4")
        rationale = next(x for x in lines if x.startswith("info string kairos"))
        self.assertIn("mix=", rationale)
        self.assertIn("N=1.000", rationale)
        self.assertIn("F_N=1.000", rationale)
        self.assertIn("F_P=0.250", rationale)
        self.assertFalse(any(x.startswith("info depth 3") for x in lines))
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertIn("go depth 3", log)
        self.assertIn("setoption name MultiPV value 3", log)
        self.assertIn("searchmoves e1d2 c2c4", log)

    def test_probe_mate_score_falls_back_to_stockfish_best(self):
        self.client.close()
        self.client = UCIClient(env={"KAIROS_MOCK_PROBE_MATE": "1"})
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 6")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e1d2")
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertNotIn("searchmoves", log)

    def test_long_movetime_splits_main_probes_and_verification(self):
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go movetime 4000")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove c2c4")
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertIn("go movetime 2600", log)
        self.assertIn("go movetime 333", log)
        self.assertIn("go movetime 400 searchmoves e1d2 c2c4", log)

    def test_multipv_depth_mismatch_falls_back(self):
        self.client.close()
        self.client = UCIClient(env={"KAIROS_MOCK_DEPTH_MISMATCH": "1"})
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e1d2")
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertNotIn("searchmoves", log)

    def test_mate_score_anywhere_triggers_bestmove_fallback(self):
        self.client.close()
        self.client = UCIClient(env={"KAIROS_MOCK_MATE": "1"})
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e1d2")
        self.assertFalse(any("kairos posture=COIL" in x for x in lines))

    def test_missing_wdl_falls_back_to_stockfish_best(self):
        self.client.close()
        self.client = UCIClient(env={"KAIROS_MOCK_NO_WDL": "1"})
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e1d2")

    def test_verification_rejection_falls_back(self):
        self.client.close()
        self.client = UCIClient(env={"KAIROS_MOCK_REJECT_VERIFY": "1"})
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e1d2")
        self.assertFalse(any("kairos posture=COIL" in x for x in lines))

    def test_movetime_search_reserves_time_for_verification(self):
        self.client.handshake()
        self.client.send("setoption name KairosVerbose value true")
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go movetime 2000")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove c2c4")
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertIn("go movetime 1500", log)
        self.assertIn("go movetime 200 searchmoves e1d2 c2c4", log)

    def test_clock_search_is_preserved_as_passthrough(self):
        self.client.handshake()
        self.client.send("go wtime 60000 btime 60000 winc 1000 binc 1000")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e2e4")

    def test_stop_and_quit(self):
        self.client.handshake()
        self.client.send("go infinite")
        time.sleep(0.1)
        self.client.send("stop")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e2e4")
        self.client.send("quit")
        self.client.proc.wait(timeout=3)
        self.assertEqual(self.client.proc.returncode, 0)

    def test_batched_handshake_sends_options_before_go(self):
        self.client.send("uci")
        self.client.send("setoption name KairosStyle value 50")
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove c2c4")
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertLess(
            log.index("setoption name UCI_ShowWDL value true"),
            log.index("go depth 4"),
        )

    def test_bound_score_is_not_used_for_reranking(self):
        self.client.close()
        self.client = UCIClient(env={"KAIROS_MOCK_BOUND": "1"})
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e1d2")
        self.assertFalse(any("kairos posture=COIL" in x for x in lines))
        self.assertNotIn("searchmoves", self.client.mock_log.read_text(encoding="utf-8"))

    def test_wdl_saturation_blocks_large_centipawn_loss(self):
        self.client.close()
        self.client = UCIClient(env={"KAIROS_MOCK_SATURATED_MAIN": "1"})
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e1d2")
        self.assertFalse(any("kairos posture=COIL" in x for x in lines))
        self.assertNotIn("searchmoves", self.client.mock_log.read_text(encoding="utf-8"))

    def test_verification_wdl_saturation_blocks_large_centipawn_loss(self):
        self.client.close()
        self.client = UCIClient(env={"KAIROS_MOCK_SATURATED_VERIFY": "1"})
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e1d2")
        self.assertFalse(any("kairos posture=COIL" in x for x in lines))
        self.assertIn("searchmoves e1d2 c2c4", self.client.mock_log.read_text(encoding="utf-8"))

    def test_verification_info_is_not_forwarded(self):
        self.client.handshake()
        self.client.send("position fen 4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1")
        self.client.send("go depth 4")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove c2c4")
        self.assertFalse(any(x.startswith("info depth 6") for x in lines))
        self.assertTrue(any(x.startswith("info depth 4") for x in lines))

    def test_multiple_limits_are_passthrough(self):
        self.client.handshake()
        self.client.send("go depth 4 movetime 2000")
        lines = self.client.read_until(lambda x: x.startswith("bestmove "))
        self.assertEqual(lines[-1], "bestmove e2e4")
        log = self.client.mock_log.read_text(encoding="utf-8")
        self.assertIn("go depth 4 movetime 2000", log)
        self.assertNotIn("setoption name MultiPV value 5", log)
        self.assertNotIn("searchmoves", log)


class ParseInfoTests(unittest.TestCase):
    def test_exact_score_is_parsed(self):
        candidate = parse_info(
            "info depth 20 seldepth 30 multipv 1 score cp 35 wdl 900 100 0 pv e2e4 e7e5"
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.score_kind, "cp")
        self.assertEqual(candidate.score_value, 35)
        self.assertEqual(candidate.wdl, (900, 100, 0))

    def test_bound_scores_are_rejected(self):
        for bound in ("lowerbound", "upperbound"):
            with self.subTest(bound=bound):
                line = f"info depth 20 score cp 35 {bound} wdl 900 100 0 pv e2e4"
                self.assertIsNone(parse_info(line))

    def test_multiple_limits_bypass_personality(self):
        self.assertFalse(supported_personality_search("go depth 4 movetime 1000")[0])
        self.assertFalse(supported_personality_search("go movetime 1000 depth 4")[0])
        self.assertTrue(supported_personality_search("go depth 4")[0])
        self.assertTrue(supported_personality_search("go movetime 2000")[0])


if __name__ == "__main__":
    unittest.main()

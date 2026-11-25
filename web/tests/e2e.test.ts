import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { KairosOptions } from "../src/controller";
import { parseInfo } from "../src/uci";
import { coreAvailable, loadNodeCore } from "../tools/node-core";
import { NodeEnginePort } from "../tools/node-engine";
import { KairosSession } from "../tools/session";
import { assertSafety } from "./harness";

/**
 * Real Stockfish Lite (single thread, run under Node) + the Rust/WASM core.
 * Skipped unless both `web/public/engine/stockfish-19-lite-single.js` (see
 * scripts/fetch_engine.sh) and `src/core/pkg` (scripts/build_core.sh) exist.
 */

const ENGINE_PATH =
  process.env.KAIROS_ENGINE ??
  new URL("../public/engine/stockfish-19-lite-single.js", import.meta.url).pathname;
const AVAILABLE = existsSync(ENGINE_PATH) && coreAvailable();

const Session = {
  start: (options: Partial<KairosOptions>) => KairosSession.start(ENGINE_PATH, options),
};

const SCENARIOS: { name: string; position: string }[] = [
  { name: "start position", position: "position startpos" },
  { name: "Queen's Gambit", position: "position startpos moves d2d4 d7d5 c2c4 e7e6 b1c3 g8f6" },
  { name: "Italian", position: "position startpos moves e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6" },
  { name: "pawn endgame", position: "position fen 8/5pk1/6p1/8/5PK1/6P1/8/8 w - - 0 1" },
  { name: "rook endgame", position: "position fen 8/5pk1/6p1/3r4/8/5PK1/4R1P1/8 w - - 0 1" },
  { name: "mate in one", position: "position fen r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4" },
  { name: "king attack", position: "position fen r1b2rk1/pp1nqppp/2p1pn2/3p4/2PP4/2NBPN2/PP3PPP/R2QK2R w KQ - 0 9" },
  { name: "tension-rich middlegame", position: "position startpos moves e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 c1g5 e7e6" },
];

describe.skipIf(!AVAILABLE)("real Stockfish Lite + Rust core", () => {
  it("KairosStyle 0 plays exactly what plain Stockfish plays", async () => {
    const plain = await Session.start({ style: 0 });
    const styled = await Session.start({ style: 0, independence: 100 });
    try {
      for (const scenario of SCENARIOS.slice(0, 3)) {
        const a = await plain.move(scenario.position, "go depth 8");
        const b = await styled.move(scenario.position, "go depth 8");
        expect(b.move, scenario.name).toBe(a.move);
        expect(b.rationale.kind).toBe("stockfish");
      }
    } finally {
      plain.close();
      styled.close();
    }
  }, 120_000);

  it("scenario suite keeps every safety property (unverified reranks are impossible)", async () => {
    const session = await Session.start({ style: 100, independence: 100, posture: "Auto" });
    try {
      for (const scenario of SCENARIOS) {
        await session.move(scenario.position, "go depth 8");
      }
      assertSafety(session);
      for (const played of session.played) {
        if (played.rationale.reason === "mate-score") {
          expect(played.rationale.kind).toBe("fallback");
        }
        if (played.rationale.kind === "rerank") {
          expect(played.rationale.lossPct).toBeLessThanOrEqual(played.rationale.budgetPct + 1e-9);
        }
      }
    } finally {
      session.close();
    }
  }, 300_000);

  it("a real searchmoves judge measures a KAIROS-proposed move outside Stockfish's top 5", async () => {
    const core = await loadNodeCore();
    const port = await NodeEnginePort.start(ENGINE_PATH);
    const position = "position startpos moves d2d4 d7d5 c2c4 e7e6 b1c3 g8f6";
    const lines: string[] = [];
    port.onLine = (line) => lines.push(line);
    try {
      const send = async (line: string, until?: RegExp): Promise<void> => {
        port.send(line);
        if (until) {
          for (let i = 0; i < 600 && !lines.some((l) => until.test(l)); i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      };
      await send("uci", /^uciok/);
      await send("setoption name UCI_ShowWDL value true");
      await send("isready", /^readyok/);
      await send(position);
      lines.length = 0;
      await send("setoption name MultiPV value 5");
      await send("go depth 10", /^bestmove/);
      const top5 = new Set(
        lines
          .map((l) => parseInfo(l))
          .filter((c): c is NonNullable<typeof c> => c !== null && c.depth === 10)
          .map((c) => c.move),
      );
      expect(top5.size).toBeGreaterThan(0);
      core.setPosition(position);
      core.updatePlan("Coil");
      const outside = core
        .propose([1, 0, 0, 0, 0, 0], 12, 80_000)
        .map((p) => p.move)
        .find((m) => !top5.has(m));
      expect(outside, "proposer returned only Stockfish top-5 moves").toBeDefined();
      lines.length = 0;
      await send("setoption name MultiPV value 1");
      await send(`go depth 10 searchmoves ${outside}`, /^bestmove/);
      const judged = lines
        .map((l) => parseInfo(l))
        .filter((c): c is NonNullable<typeof c> => c !== null && c.depth === 10);
      expect(judged.length).toBeGreaterThan(0);
      expect(judged[0].move).toBe(outside);
      expect(judged[0].wdl[0] + judged[0].wdl[1] + judged[0].wdl[2]).toBe(1000);
    } finally {
      port.terminate();
    }
  }, 120_000);

  it("saturated winning positions never lose more than the saturation margin", async () => {
    const session = await Session.start({ style: 100, independence: 100 });
    try {
      const played = await session.move("position fen 4k3/8/4K3/8/8/8/8/Q7 w - - 0 1", "go depth 8");
      assertSafety(session);
      expect(["fallback", "rerank", "stockfish"]).toContain(played.rationale.kind);
    } finally {
      session.close();
    }
  }, 60_000);
});

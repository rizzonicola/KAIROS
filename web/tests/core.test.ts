import { readFileSync } from "node:fs";
import { Chess } from "chess.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { WasmCore } from "../src/core-wasm";
import { mulberry32 } from "../src/postures";
import { coreAvailable, loadNodeCore } from "../tools/node-core";

/**
 * Conformance tests for the Rust/WASM core. They are skipped until
 * `scripts/build_core.sh` has produced `src/core/pkg` (CI always builds it first).
 */

const STARTPOS = "position startpos";
const KIWIPETE = "position fen r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";

/** FEN without the en-passant field (v0.2.1 printed it always, Stockfish only when capturable). */
function comparableFen(fen: string): string {
  const fields = fen.split(" ");
  return [fields[0], fields[1], fields[2], fields[4], fields[5]].join(" ");
}

describe.skipIf(!coreAvailable())("kairos-core (Rust/WASM)", () => {
  let core: WasmCore;
  beforeAll(async () => {
    core = await loadNodeCore();
  });

  it("is perft-correct through the WASM boundary", () => {
    core.setPosition(STARTPOS);
    expect(core.perft(4)).toBe(197_281);
    expect(core.perftUci(3)).toBe(8_902);
    core.setPosition(KIWIPETE);
    expect(core.perft(3)).toBe(97_862);
    expect(core.perftUci(3)).toBe(97_862);
  });

  it("generates the same legal moves as chess.js on thousands of random positions", () => {
    const random = mulberry32(20260615);
    let positions = 0;
    for (let game = 0; game < 150; game++) {
      const chess = new Chess();
      const moves: string[] = [];
      for (let ply = 0; ply < 70 && !chess.isGameOver(); ply++) {
        const verbose = chess.moves({ verbose: true }) as { from: string; to: string; promotion?: string }[];
        const expected = verbose.map((m) => `${m.from}${m.to}${m.promotion ?? ""}`).sort();
        expect(core.setPosition(`position startpos${moves.length ? " moves " + moves.join(" ") : ""}`)).toBe(true);
        expect([...core.legalMoves()].sort()).toEqual(expected);
        expect(comparableFen(core.fen())).toBe(comparableFen(chess.fen()));
        positions += 1;
        const pick = verbose[Math.floor(random() * verbose.length)];
        const uci = `${pick.from}${pick.to}${pick.promotion ?? ""}`;
        chess.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
        moves.push(uci);
      }
    }
    expect(positions).toBeGreaterThan(3000);
  });

  it("matches the frozen v0.2.1 board cases (FEN after move, halfmove reset, check)", () => {
    const { cases } = JSON.parse(
      readFileSync(new URL("./vectors/legacy-v0.2.1/board.json", import.meta.url), "utf8"),
    ) as { cases: { fen: string; move: string; fenAfter: string; halfmoveReset: boolean; givesCheck: boolean }[] };
    for (const item of cases) {
      expect(core.setPosition(`position fen ${item.fen}`)).toBe(true);
      if (!core.isLegal(item.move)) {
        continue;
      }
      const after = core.childFen(item.move);
      expect(after, `${item.fen} ${item.move}`).not.toBeNull();
      expect(comparableFen(after as string), `${item.fen} ${item.move}`).toBe(comparableFen(item.fenAfter));
      expect(core.resetsHalfmove(item.move)).toBe(item.halfmoveReset);
      expect(core.features(item.move)?.givesCheck).toBe(item.givesCheck);
    }
  });

  it("matches the generated v0.3 feature fixture", () => {
    const { cases } = JSON.parse(
      readFileSync(new URL("./vectors/v0.3/features.json", import.meta.url), "utf8"),
    ) as { cases: { fen: string; features: Record<string, Record<string, number | boolean>> }[] };
    for (const item of cases) {
      expect(core.setPosition(`position fen ${item.fen}`), item.fen).toBe(true);
      for (const [move, expected] of Object.entries(item.features)) {
        const actual = core.features(move) as Record<string, number | boolean> | null;
        expect(actual, `${item.fen} ${move}`).not.toBeNull();
        for (const [key, value] of Object.entries(expected)) {
          const got = (actual as Record<string, number | boolean>)[key];
          if (typeof value === "number") {
            expect(Number(got), `${item.fen} ${move} ${key}`).toBeCloseTo(value, 12);
          } else {
            expect(got, `${item.fen} ${move} ${key}`).toBe(value);
          }
        }
      }
    }
  });

  it("rejects illegal positions and moves", () => {
    expect(core.setPosition("position startpos moves e2e5")).toBe(false);
    expect(core.lastError().length).toBeGreaterThan(0);
    core.setPosition(STARTPOS);
    expect(core.isLegal("e2e5")).toBe(false);
    expect(core.features("e2e5")).toBeNull();
    expect(core.repetitionCount("e2e5")).toBe(-1);
  });

  it("counts repetitions and the halfmove clock", () => {
    core.setPosition("position startpos moves g1f3 g8f6 f3g1 f6g8");
    expect(core.repetitionCount("g1f3")).toBe(1);
    expect(core.halfmoveClock()).toBe(4);
    expect(core.resetsHalfmove("e2e4")).toBe(true);
  });

  it("computes bounded features and a quiet start", () => {
    core.setPosition(STARTPOS);
    expect(core.tensionIndex()).toBe(0);
    for (const move of core.legalMoves()) {
      const f = core.features(move);
      expect(f).not.toBeNull();
      for (const key of ["F_T", "F_R", "F_C", "F_F", "F_K", "F_S", "F_I"] as const) {
        const value = (f as NonNullable<typeof f>)[key];
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  function bestOwn(command: string, depth = 5, nodes = 600_000) {
    core.setPosition(command);
    core.searchStart(depth, nodes);
    for (let i = 0; i < 400; i++) {
      if (core.searchStep(20_000).done) {
        break;
      }
    }
    return core.ownBestMove();
  }

  it("standalone search finds mate in one and in two and does not hang the queen", () => {
    const one = bestOwn("position fen r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4");
    expect(one?.move).toBe("h5f7");
    expect(one?.mate).toBe(1);
    const two = bestOwn("position fen 7k/8/8/8/8/8/R7/1R4K1 w - - 0 1", 6, 2_000_000);
    expect(["a2a7", "b1b7"]).toContain(two?.move);
    const safe = bestOwn("position fen 4k3/8/4p3/8/8/8/3Q4/4K3 w - - 0 1", 4, 200_000);
    expect(safe?.move).not.toBe("d2d5");
  });

  it("standalone search returns legal moves with tiny budgets", () => {
    core.setPosition(STARTPOS);
    core.searchStart(8, 2_000);
    core.searchStep(1_000);
    const best = core.ownBestMove();
    expect(core.isLegal(best?.move ?? "")).toBe(true);
  });

  it("proposes legal, mostly quiet candidates of several classes in a quiet middlegame", () => {
    core.setPosition("position startpos moves d2d4 d7d5 c2c4 e7e6 b1c3 g8f6");
    core.updatePlan("Coil");
    const proposals = core.propose([1, 0, 0, 0, 0, 0], 10, 80_000);
    expect(proposals.length).toBeGreaterThanOrEqual(4);
    for (const p of proposals) {
      expect(core.isLegal(p.move)).toBe(true);
    }
    const quiet = proposals.filter((p) => p.class !== "release");
    expect(quiet.length).toBeGreaterThanOrEqual(3);
    expect(new Set(quiet.map((p) => p.class)).size).toBeGreaterThanOrEqual(2);
  });

  it("keeps a plan token across moves and expires it when a pawn disappears", () => {
    core.newGame();
    core.setPosition("position startpos moves e2e4 d7d5");
    const first = core.updatePlan("Coil");
    expect(first.active).toBe(true);
    expect(core.updatePlan("Coil").age).toBe(1);
    core.setPosition("position startpos moves e2e4 d7d5 e4d5");
    expect(core.updatePlan("Coil").age).toBe(0);
  });

  it("feature extraction stays cheap (average < 50 ms per position, 20 positions)", () => {
    const fens = [
      STARTPOS,
      KIWIPETE,
      "position startpos moves e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6",
      "position fen 8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    ];
    const started = performance.now();
    let positions = 0;
    for (let i = 0; i < 20; i++) {
      core.setPosition(fens[i % fens.length]);
      for (const move of core.legalMoves()) {
        core.features(move);
      }
      positions += 1;
    }
    const average = (performance.now() - started) / positions;
    console.log(`features: ${average.toFixed(2)} ms per position (all legal moves)`);
    expect(average).toBeLessThan(50);
  });
});

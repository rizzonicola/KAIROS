import { describe, expect, it } from "vitest";
import {
  Board,
  boardFromPositionCommand,
  candidateFeatures,
  positionStats,
} from "../src/chess-features";

const TENSION_FEN = "4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1";
const QUEEN_FEN = "4k3/5p2/8/8/8/5Q2/5PPP/4K3 w - - 0 1";

describe("chess features", () => {
  it("counts the pawn tension delta for c2c4", () => {
    const board = Board.fromFen(TENSION_FEN);
    expect(board.pawnLeverCount()).toBe(1);
    const features = candidateFeatures(board, "c2c4");
    expect(features.T).toBe(1);
    expect(features.F_T).toBeCloseTo(0.25, 12);
    expect(features.F_S).toBe(0);
  });

  it("measures capture material", () => {
    const board = Board.fromFen(QUEEN_FEN);
    const features = candidateFeatures(board, "f3f7");
    expect(features.F_S).toBeCloseTo(1 / 9, 12);
  });

  it("detects a check", () => {
    const board = Board.fromFen(QUEEN_FEN);
    expect(board.moveGivesCheck("f3f7")).toBe(true);
    expect(candidateFeatures(board, "f3f7").F_I).toBe(1);
  });

  it("reconstructs a position history", () => {
    const board = boardFromPositionCommand("position startpos moves e2e4 d7d5");
    expect(board).not.toBeNull();
    expect(board!.turn).toBe("w");
    expect(board!.squares[3 * 8 + 4]).toBe("P");
    expect(board!.squares[4 * 8 + 3]).toBe("p");
  });

  it("applies castling and promotion", () => {
    const castle = Board.fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1").applyUci("e1g1");
    expect(castle.squares[6]).toBe("K");
    expect(castle.squares[5]).toBe("R");
    const promoted = Board.fromFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1").applyUci("a7a8q");
    expect(promoted.squares[56]).toBe("Q");
  });

  it("counts absolute pins and pin creation", () => {
    const pinned = Board.fromFen("k3r3/8/8/8/8/8/4N3/4K3 w - - 0 1");
    expect(pinned.pinCount()).toBe(1);
    expect(pinned.tensionCount()).toBe(1);
    const board = Board.fromFen("4k3/4n3/8/8/8/8/8/R6K w - - 0 1");
    expect(board.pinCount()).toBe(0);
    const features = candidateFeatures(board, "a1e1");
    expect(features.F_T).toBeCloseTo(0.25, 12);
    // Two own pieces on the ray: the first is not pinned.
    const blocked = Board.fromFen("k3r3/8/8/8/8/4B3/4N3/4K3 w - - 0 1");
    expect(blocked.pinCount()).toBe(0);
  });

  it("reduces simplification on promotion", () => {
    const board = Board.fromFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
    expect(board.materialDelta("a7a8q")).toBe(-8);
    expect(candidateFeatures(board, "a7a8q").F_S).toBeCloseTo(-8 / 9, 12);
  });

  it("counts a queen threat as initiative", () => {
    const board = Board.fromFen("q6k/8/8/8/8/8/8/R6K w - - 0 1");
    expect(board.moveThreatensEnemyQueen("a1a7")).toBe(true);
    expect(candidateFeatures(board, "a1a7").F_I).toBe(1);
    expect(candidateFeatures(board, "a1b1").F_I).toBe(0);
  });

  it("measures reserve flexibility and coordination", () => {
    const reserveBoard = Board.fromFen("4k3/8/8/8/3N4/8/8/4K3 w - - 0 1");
    expect(reserveBoard.reserveCount(true)).toBe(1);
    expect(reserveBoard.safeMobility(true)).toBeGreaterThan(0);
    const rooks = Board.fromFen("R6R/8/8/8/8/8/8/4K3 w - - 0 1");
    const [mutual, kingAttacks, batteries] = rooks.coordination(true);
    expect(mutual).toBeGreaterThanOrEqual(2);
    expect(kingAttacks).toBe(0);
    expect(batteries).toBe(0);
  });

  it("counts pawn breaks and the king margin", () => {
    const board = Board.fromFen("4k3/8/8/3p4/8/8/2P5/4K3 w - - 0 1");
    expect(board.pawnBreaks(true)).toBe(1);
    const defended = Board.fromFen("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1");
    expect(defended.kingMargin(true)).toEqual([2, 0]);
  });

  it("computes phase and material balance", () => {
    const start = Board.fromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(start.phase()).toBeCloseTo(1.0, 12);
    expect(start.materialBalance()).toBe(0);
    const pawnEndgame = Board.fromFen("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1");
    expect(pawnEndgame.phase()).toBeCloseTo(0.0, 12);
    expect(pawnEndgame.materialBalance()).toBe(1);
  });

  it("builds a null move FEN and refuses an illegal one", () => {
    const start = Board.fromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    const nullFen = start.nullMoveFen();
    expect(nullFen).not.toBeNull();
    expect(nullFen!.split(" ")[1]).toBe("b");
    expect(nullFen!.split(" ")[3]).toBe("-");
    const inCheck = Board.fromFen("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1");
    expect(inCheck.nullMoveFen()).toBeNull();
  });

  it("detects halfmove resets", () => {
    const board = Board.fromFen("4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 90 1");
    expect(board.resetsHalfmove("c2c4")).toBe(true);
    expect(board.resetsHalfmove("e4d5")).toBe(true);
    expect(board.resetsHalfmove("e1d2")).toBe(false);
  });

  it("keeps probe features explicit, never inferred", () => {
    const board = Board.fromFen(TENSION_FEN);
    const neutral = candidateFeatures(board, "c2c4");
    expect(neutral.F_N).toBe(0);
    expect(neutral.F_P).toBe(0);
    const probed = candidateFeatures(board, "c2c4", { F_N: 0.5, F_P: -0.25 });
    expect(probed.F_N).toBeCloseTo(0.5, 12);
    expect(probed.F_P).toBeCloseTo(-0.25, 12);
  });

  it("exposes posture evidence in position stats", () => {
    const board = Board.fromFen(TENSION_FEN);
    const stats = positionStats(board);
    expect(stats.tension).toBe(1);
    expect(stats.ownKingDefenders).toBeGreaterThanOrEqual(1);
    expect(stats.materialBalance).toBe(1);
  });
});

import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { applyEngineMove, positionCommand } from "../src/game";

const PROMOTION_FEN = "8/P7/8/8/8/8/8/K6k w - - 0 1";

describe("positionCommand", () => {
  it("uses startpos with no moves", () => {
    expect(positionCommand(new Chess())).toBe("position startpos");
  });

  it("replays the move history", () => {
    const game = new Chess();
    game.move("e4");
    game.move("e5");
    expect(positionCommand(game)).toBe("position startpos moves e2e4 e7e5");
  });
});

describe("applyEngineMove", () => {
  it("applies a legal UCI move", () => {
    const game = new Chess();
    const move = applyEngineMove(game, "e2e4");
    expect(move?.san).toBe("e4");
    expect(game.fen()).toContain("4P3");
  });

  it("refuses illegal, null and empty moves without touching the game", () => {
    for (const uci of ["e2e5", "0000", "(none)", "", "e2e4q"]) {
      const game = new Chess();
      const before = game.fen();
      expect(applyEngineMove(game, uci), uci).toBeNull();
      expect(game.fen(), uci).toBe(before);
    }
  });

  it("applies an explicit promotion", () => {
    const game = new Chess(PROMOTION_FEN);
    const move = applyEngineMove(game, "a7a8q");
    expect(move?.promotion).toBe("q");
    expect(game.get("a8")?.type).toBe("q");
  });

  it("defaults a promotion UCI without a piece to queen", () => {
    const game = new Chess(PROMOTION_FEN);
    const move = applyEngineMove(game, "a7a8");
    expect(move?.promotion).toBe("q");
    expect(game.get("a8")?.type).toBe("q");
  });
});

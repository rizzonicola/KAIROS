import { describe, expect, it } from "vitest";
import { Board } from "../src/chess-features";
import {
  expectedScore,
  fiftyMoveBlocked,
  isSaturated,
  parseInfo,
  repetitionBlocked,
  resultBand,
  supportedPersonalitySearch,
} from "../src/controller";

const FEN = "4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 0 1";

describe("parseInfo", () => {
  it("parses an exact cp score", () => {
    const candidate = parseInfo(
      "info depth 20 seldepth 30 multipv 1 score cp 35 wdl 900 100 0 pv e2e4 e7e5",
    );
    expect(candidate).not.toBeNull();
    expect(candidate!.scoreKind).toBe("cp");
    expect(candidate!.scoreValue).toBe(35);
    expect(candidate!.wdl).toEqual([900, 100, 0]);
    expect(candidate!.pv).toEqual(["e2e4", "e7e5"]);
    expect(candidate!.multipv).toBe(1);
    expect(candidate!.depth).toBe(20);
    expect(candidate!.move).toBe("e2e4");
  });

  it("defaults the multipv index to one", () => {
    const candidate = parseInfo("info depth 12 score cp 10 wdl 500 400 100 pv g1f3");
    expect(candidate!.multipv).toBe(1);
  });

  it("rejects bound scores", () => {
    for (const bound of ["lowerbound", "upperbound"]) {
      expect(
        parseInfo(`info depth 20 score cp 35 ${bound} wdl 900 100 0 pv e2e4`),
      ).toBeNull();
    }
  });

  it("rejects lines without a usable pv, wdl, depth or score", () => {
    expect(parseInfo("info depth 20 score cp 35 wdl 900 100 0")).toBeNull();
    expect(parseInfo("info depth 20 score cp 35 pv e2e4")).toBeNull();
    expect(parseInfo("info depth 20 score cp 35 wdl 0 0 0 pv e2e4")).toBeNull();
    expect(parseInfo("info score cp 35 wdl 900 100 0 pv e2e4")).toBeNull();
    expect(parseInfo("info depth 20 wdl 900 100 0 pv e2e4")).toBeNull();
    expect(parseInfo("info string kairos posture=COIL")).toBeNull();
    expect(parseInfo("bestmove e2e4")).toBeNull();
  });

  it("computes expected score from WDL", () => {
    const candidate = parseInfo(
      "info depth 20 score cp 35 wdl 900 100 0 pv e2e4",
    )!;
    expect(expectedScore(candidate)).toBeCloseTo(0.95, 12);
    expect(expectedScore({ ...candidate, wdl: [0, 1000, 0] })).toBeCloseTo(0.5, 12);
  });
});

describe("guards", () => {
  it("maps expected score to conservative result bands", () => {
    expect(resultBand(0.55)).toBe(1);
    expect(resultBand(0.45)).toBe(-1);
    expect(resultBand(0.50)).toBe(0);
    expect(resultBand(0.56)).toBe(1);
    expect(resultBand(0.54)).toBe(0);
    expect(resultBand(0.44)).toBe(-1);
  });

  it("flags saturated expected scores", () => {
    expect(isSaturated(0.99)).toBe(true);
    expect(isSaturated(0.01)).toBe(true);
    expect(isSaturated(0.985)).toBe(false);
    expect(isSaturated(0.0101)).toBe(false);
    expect(isSaturated(0.5)).toBe(false);
  });

  it("supports bounded depth and movetime searches only", () => {
    expect(supportedPersonalitySearch("go depth 4")).toEqual({
      supported: true,
      kind: "depth",
      amount: 4,
      reason: "supported",
    });
    expect(supportedPersonalitySearch("go movetime 2000")).toEqual({
      supported: true,
      kind: "movetime",
      amount: 2000,
      reason: "supported",
    });
    expect(supportedPersonalitySearch("go movetime 1500").supported).toBe(true);
    expect(supportedPersonalitySearch("go depth 4 searchmoves e2e4").supported).toBe(true);
    for (const line of ["go depth 4 movetime 1000", "go movetime 1000 depth 4"]) {
      expect(supportedPersonalitySearch(line).reason).toBe("multiple-or-missing-limits");
    }
    for (const line of [
      "go wtime 60000 btime 60000 winc 1000 binc 1000",
      "go infinite",
      "go nodes 1000",
      "go mate 3",
      "go perft 5",
      "go ponder",
    ]) {
      expect(supportedPersonalitySearch(line).reason).toBe("unsupported-or-clock-search");
    }
    expect(supportedPersonalitySearch("go")).toEqual({
      supported: false,
      kind: "",
      amount: 0,
      reason: "unsupported-or-clock-search",
    });
    expect(supportedPersonalitySearch("go movetime 1000")).toEqual({
      supported: false,
      kind: "",
      amount: 1000,
      reason: "time-too-low",
    });
    expect(supportedPersonalitySearch("go depth 0").reason).toBe("invalid-depth");
    expect(supportedPersonalitySearch("go depth").reason).toBe("invalid-depth");
  });
});

describe("board guards", () => {
  it("blocks a non-resetting move near the fifty-move draw", () => {
    const board = Board.fromFen("4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 90 1");
    expect(fiftyMoveBlocked(board, "e1d2", 0.65)).toBe(true);
    expect(fiftyMoveBlocked(board, "c2c4", 0.65)).toBe(false);
    expect(fiftyMoveBlocked(board, "e1d2", 0.50)).toBe(false);
    expect(fiftyMoveBlocked(board, "e2e5", 0.65)).toBe(false);
    const early = Board.fromFen("4k3/8/8/3p4/4P3/8/2P5/4K3 w - - 89 1");
    expect(fiftyMoveBlocked(early, "e1d2", 0.65)).toBe(false);
  });

  it("blocks a third repetition while better than a draw", () => {
    const board = Board.fromFen(FEN);
    const key = board.applyUci("c2c4").positionKey();
    expect(repetitionBlocked(board, "c2c4", { [key]: 2 }, 0.65)).toBe(true);
    expect(repetitionBlocked(board, "c2c4", new Map([[key, 2]]), 0.65)).toBe(true);
    expect(repetitionBlocked(board, "c2c4", { [key]: 1 }, 0.65)).toBe(false);
    expect(repetitionBlocked(board, "c2c4", { [key]: 2 }, 0.50)).toBe(false);
    expect(repetitionBlocked(board, "c2c4", { [key]: 2 }, 0.49)).toBe(false);
    const otherKey = board.applyUci("e1d2").positionKey();
    expect(repetitionBlocked(board, "c2c4", { [otherKey]: 2 }, 0.65)).toBe(false);
    expect(repetitionBlocked(board, "e2e5", { [key]: 2 }, 0.65)).toBe(false);
  });
});

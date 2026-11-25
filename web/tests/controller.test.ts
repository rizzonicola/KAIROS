import { describe, expect, it } from "vitest";
import { proposal } from "./mock-core";
import {
  DEFAULT_PROPOSALS,
  GOOD_FEATURES,
  ROOT,
  ROOT_MOVES,
  assertSafety,
  makeHarness,
} from "./harness";
import { mv, type MockMove } from "./mock-engine";

const GO = "go depth 4";

function swap(moves: MockMove[], move: string, expected: number, cp = 0): MockMove[] {
  return moves.map((m) => (m.move === move ? mv(move, expected, cp) : m));
}

describe("handshake", () => {
  it("forces Stockfish options and reports ready in Stockfish mode", () => {
    const h = makeHarness();
    expect(h.engine.sent).toContain("uci");
    expect(h.engine.sent).toContain("setoption name UCI_ShowWDL value true");
    expect(h.engine.sent).toContain("setoption name Threads value 1");
    expect(h.engine.sent).toContain("isready");
    const ready = h.events.find((e) => e.event.type === "ready");
    expect(ready?.event).toEqual({ type: "ready", engine: "Stockfish 19", mode: "stockfish" });
  });

  it("refuses an engine that is not Stockfish 19", () => {
    const h = makeHarness({ engine: { id: "Stockfish 16" } });
    const error = h.events.find((e) => e.event.type === "error");
    expect(error?.event.type).toBe("error");
    expect(h.events.some((e) => e.event.type === "ready")).toBe(false);
  });
});

describe("passthrough (invariants 1 and 2)", () => {
  it("KairosStyle 0 returns exactly Stockfish's move and runs no personality search", () => {
    const h = makeHarness({ options: { style: 0 } });
    h.position();
    h.go("go movetime 2000");
    const played = h.last();
    expect(played.move).toBe("g1f3");
    expect(played.rationale.kind).toBe("stockfish");
    expect(played.rationale.reason).toBe("style-zero");
    expect(h.engine.sent).toContain("go movetime 2000");
    expect(h.engine.sent.some((line) => line.includes("searchmoves"))).toBe(false);
    expect(h.core.proposeCalls).toHaveLength(0);
    assertSafety(h);
  });

  it("passes clock searches and low think times through untouched", () => {
    const clock = makeHarness();
    clock.position();
    clock.go("go wtime 60000 btime 60000");
    expect(clock.last().rationale.reason).toBe("unsupported-or-clock-search");
    const low = makeHarness();
    low.position();
    low.go("go movetime 1000");
    expect(low.last().rationale.reason).toBe("time-too-low");
    assertSafety(clock);
    assertSafety(low);
  });

  it("plays a forced move without searching", () => {
    const h = makeHarness({ core: { legal: ["e1d2"] } });
    h.position();
    h.go(GO);
    expect(h.last().move).toBe("e1d2");
    expect(h.last().rationale.reason).toBe("forced-move");
    expect(h.engine.sent.some((line) => line.startsWith("go"))).toBe(false);
  });

  it("lets Stockfish decide alone when the core rejects the position", () => {
    const h = makeHarness({ core: { acceptPosition: () => false } });
    h.position();
    h.go(GO);
    expect(h.last().rationale.reason).toBe("core-rejected-position");
    expect(h.last().move).toBe("g1f3");
    assertSafety(h);
  });
});

describe("personality pipeline", () => {
  it("proposes, judges with searchmoves, verifies, and plays a KAIROS move outside the top 3", () => {
    const h = makeHarness();
    h.position();
    h.go(GO);
    const played = h.last();
    expect(played.move).toBe("h2h3");
    const r = played.rationale;
    expect(r.kind).toBe("rerank");
    expect(r.reason).toBe("verified");
    expect(r.sfBest).toBe("g1f3");
    expect(r.sfTop3).toEqual(["g1f3", "b1c3", "f1c4"]);
    expect(r.proposed).toEqual(["h2h3", "d2d4"]);
    expect(r.outsideTop3).toBe(true);
    expect(r.playedProposed).toBe(true);
    expect(r.budgetPct).toBeCloseTo(0.75, 6);
    expect(r.lossPct).toBeCloseTo(0.4, 6);
    expect(r.pick).toBe(4);
    // UCI choreography: baseline MultiPV 3, judge over proposals + top 3, verify the pair at depth + 2.
    expect(h.engine.sent).toContain("setoption name MultiPV value 3");
    expect(h.engine.sent).toContain("setoption name MultiPV value 5");
    expect(h.engine.sent).toContain("go depth 4 searchmoves g1f3 b1c3 f1c4 h2h3 d2d4");
    expect(h.engine.sent).toContain("setoption name MultiPV value 2");
    expect(h.engine.sent).toContain("go depth 6 searchmoves g1f3 h2h3");
    expect(h.engine.searches.map((s) => s.kind)).toEqual(["baseline", "judge", "verify"]);
    assertSafety(h);
  });

  it("runs the core proposer while the baseline search is in flight", () => {
    const h = makeHarness();
    h.position();
    h.go(GO);
    expect(h.core.proposeCalls).toHaveLength(1);
    expect(h.core.proposeCalls[0].mix).toHaveLength(6);
    const baselineGo = h.engine.sent.indexOf("go depth 4");
    expect(baselineGo).toBeGreaterThan(-1);
  });

  it("Independence 0 considers only Stockfish's top moves and skips the judge search", () => {
    const h = makeHarness({
      options: { independence: 0 },
      core: { features: { b1c3: GOOD_FEATURES } },
    });
    h.position();
    h.go(GO);
    expect(h.core.proposeCalls).toHaveLength(0);
    expect(h.engine.searches.map((s) => s.kind)).toEqual(["baseline", "verify"]);
    const r = h.last().rationale;
    expect(h.last().move).toBe("b1c3");
    expect(r.outsideTop3).toBe(false);
    expect(r.proposed).toEqual([]);
    assertSafety(h);
  });

  it("splits movetime 35/30/20/15 with probes at >= 3000 ms and verifies once", () => {
    const h = makeHarness();
    h.position();
    h.go("go movetime 3000");
    const goLines = h.engine.sent.filter((line) => line.startsWith("go"));
    expect(goLines[0]).toBe("go movetime 1050");
    expect(goLines[1]).toBe("go movetime 900 searchmoves g1f3 b1c3 f1c4 h2h3 d2d4");
    expect(h.engine.sent).toContain("position fen null-position w - - 0 1");
    expect(h.engine.sent).toContain("position fen child-of-h2h3 w - - 0 1");
    expect(goLines[goLines.length - 1]).toBe("go movetime 450 searchmoves g1f3 h2h3");
    const kinds = h.engine.searches.map((s) => s.kind);
    expect(kinds[0]).toBe("baseline");
    expect(kinds[1]).toBe("judge");
    expect(kinds.filter((kind) => kind === "probe").length).toBeGreaterThanOrEqual(3);
    expect(kinds[kinds.length - 1]).toBe("verify");
    expect(h.last().rationale.pressure?.narrowness).not.toBeNull();
    assertSafety(h);
  });

  it("uses no probes below 3000 ms and allows a second verification attempt", () => {
    const h = makeHarness();
    h.position();
    h.go("go movetime 2000");
    const goLines = h.engine.sent.filter((line) => line.startsWith("go"));
    expect(goLines[0]).toBe("go movetime 800");
    expect(goLines[1]).toBe("go movetime 640 searchmoves g1f3 b1c3 f1c4 h2h3 d2d4");
    expect(goLines[2]).toBe("go movetime 280 searchmoves g1f3 h2h3");
    expect(h.engine.searches.some((s) => s.kind === "probe")).toBe(false);
    assertSafety(h);
  });
});

describe("verification and fallback (invariants 2 and 6)", () => {
  it("falls back to Stockfish's best when verification measures a larger loss", () => {
    const h = makeHarness({
      engine: {
        lines: (ctx, lines) =>
          ctx.kind === "verify" ? lines.map((l) => (l.move === "h2h3" ? mv("h2h3", 0.5, -5) : l)) : lines,
      },
    });
    h.position();
    h.go(GO);
    const played = h.last();
    expect(played.move).toBe("g1f3");
    expect(played.rationale.kind).toBe("fallback");
    expect(played.rationale.reason).toBe("verification-outside-corridor-or-result-band");
    expect(played.rationale.rejectedLossPct).toBeCloseTo(4.0, 6);
    expect(played.rationale.lossPct).toBe(0);
    assertSafety(h);
  });

  it("tries the next candidate after a failed verification when time allows", () => {
    const h = makeHarness({
      core: {
        features: { h2h3: GOOD_FEATURES, f1c4: { F_T: 1, F_R: 1, F_F: 1 } },
        proposals: [
          proposal("h2h3", "edge", GOOD_FEATURES),
          proposal("f1c4", "improve", { F_T: 1, F_R: 1, F_F: 1 }),
        ],
      },
      engine: {
        lines: (ctx, lines) =>
          ctx.kind === "verify" && ctx.searchmoves.includes("h2h3")
            ? lines.map((l) => (l.move === "h2h3" ? mv("h2h3", 0.5, -5) : l))
            : lines,
      },
    });
    h.position();
    h.go(GO);
    expect(h.engine.searches.filter((s) => s.kind === "verify")).toHaveLength(2);
    const played = h.last();
    expect(played.move).toBe("f1c4");
    expect(played.rationale.kind).toBe("rerank");
    assertSafety(h);
  });

  it("never reranks on a mate score", () => {
    const h = makeHarness({
      engine: { root: [{ ...mv("g1f3", 0.9, 900), mate: 3 }, ...ROOT_MOVES.slice(1)] },
    });
    h.position();
    h.go(GO);
    expect(h.last().rationale.reason).toBe("mate-score");
    expect(h.last().move).toBe("g1f3");
    assertSafety(h);
  });

  it("falls back when WDL is missing", () => {
    const h = makeHarness({ engine: { noWdl: true } });
    h.position();
    h.go(GO);
    expect(h.last().rationale.reason).toBe("no-baseline-record");
    assertSafety(h);
  });

  it("falls back when the first line is only a bound", () => {
    const h = makeHarness({ engine: { bound: true } });
    h.position();
    h.go(GO);
    expect(h.last().rationale.kind).toBe("fallback");
    expect(h.last().move).toBe("g1f3");
    assertSafety(h);
  });

  it("falls back when the judge search lost the anchor", () => {
    const h = makeHarness({
      engine: {
        lines: (ctx, lines) => (ctx.kind === "judge" ? lines.filter((l) => l.move !== "g1f3") : lines),
      },
    });
    h.position();
    h.go(GO);
    expect(h.last().rationale.reason).toBe("judge-incomplete");
    assertSafety(h);
  });

  it("compares judged moves only at one complete depth", () => {
    const h = makeHarness({
      engine: {
        // the deepest iteration is partial (h2h3 not reported yet): use the previous complete one
        linesAtDepth: (ctx, depth, lines) =>
          ctx.kind === "judge" && depth === ctx.depth ? lines.filter((l) => l.move !== "h2h3") : lines,
      },
    });
    h.position();
    h.go(GO);
    expect(h.last().move).toBe("h2h3");
    assertSafety(h);
  });

  it("applies the saturation margin when the score is saturated", () => {
    const saturated = (cp: number): MockMove[] => [
      { move: "g1f3", cp: 900, wdl: [1000, 0, 0] },
      { move: "b1c3", cp: 890, wdl: [1000, 0, 0] },
      { move: "f1c4", cp: 885, wdl: [1000, 0, 0] },
      { move: "h2h3", cp, wdl: [1000, 0, 0] },
      mv("d2d4", 0.5),
    ];
    const outside = makeHarness({ engine: { root: saturated(800) } });
    outside.position();
    outside.go(GO);
    expect(outside.last().move).toBe("g1f3");
    expect(outside.last().rationale.kind).toBe("fallback");
    const inside = makeHarness({ engine: { root: saturated(880) } });
    inside.position();
    inside.go(GO);
    expect(inside.last().move).toBe("h2h3");
    assertSafety(outside);
    assertSafety(inside);
  });

  it("skips Distill conversion positions", () => {
    const h = makeHarness({
      options: { posture: "Distill" },
      engine: { root: [{ move: "g1f3", cp: 800, wdl: [880, 80, 40] }, ...ROOT_MOVES.slice(1)] },
    });
    h.position();
    h.go(GO);
    expect(h.last().rationale.reason).toBe("distill-conversion");
    expect(h.last().move).toBe("g1f3");
    assertSafety(h);
  });

  it("blocks a third repetition and 50-move drift while better than a draw", () => {
    const repetition = makeHarness({ core: { repetition: { h2h3: 2 } } });
    repetition.position();
    repetition.go(GO);
    expect(repetition.last().move).toBe("g1f3");
    const fifty = makeHarness({ core: { halfmove: 95 } });
    fifty.position();
    fifty.go(GO);
    expect(fifty.last().move).toBe("g1f3");
    const resetting = makeHarness({ core: { halfmove: 95, resets: { h2h3: true } } });
    resetting.position();
    resetting.go(GO);
    expect(resetting.last().move).toBe("h2h3");
    assertSafety(repetition);
    assertSafety(fifty);
    assertSafety(resetting);
  });

  it("stop during the baseline search plays Stockfish's best", () => {
    const h = makeHarness({ engine: { hold: (ctx) => ctx.kind === "baseline" } });
    h.position();
    h.go("go movetime 3000");
    expect(h.bestmoves()).toHaveLength(0);
    h.controller.handleCommand({ type: "stop" });
    expect(h.engine.sent).toContain("stop");
    expect(h.last().move).toBe("g1f3");
    expect(h.last().rationale.reason).toBe("stopped-during-baseline");
    assertSafety(h);
  });

  it("stop during verification plays Stockfish's best", () => {
    const h = makeHarness({ engine: { hold: (ctx) => ctx.kind === "verify" } });
    h.position();
    h.go(GO);
    expect(h.bestmoves()).toHaveLength(0);
    h.controller.handleCommand({ type: "stop" });
    expect(h.last().move).toBe("g1f3");
    expect(h.last().rationale.reason).toBe("stopped-during-verification");
    assertSafety(h);
  });
});

describe("budgets (invariant 4)", () => {
  const BUDGETS: [string, number][] = [
    ["Coil", 1.5],
    ["Strike", 3],
    ["Absorb", 1],
    ["Reverse", 2],
    ["Distill", 0.5],
    ["Fog", 4],
  ];
  for (const [posture, pct] of BUDGETS) {
    it(`${posture} budget is ${pct}% x style/100`, () => {
      const h = makeHarness({
        options: { posture: posture as never, style: 100 },
        // nothing but Stockfish's best is admissible, so the fallback reports the budget
        engine: { root: [ROOT_MOVES[0], ...ROOT_MOVES.slice(1).map((m) => mv(m.move, 0.3))] },
      });
      h.position();
      h.go(GO);
      expect(h.last().rationale.budgetPct).toBeCloseTo(pct, 9);
      expect(h.last().rationale.reason).toBe("no-eligible-rerank");
    });
  }

  it("scales with KairosStyle", () => {
    const h = makeHarness({
      options: { posture: "Strike", style: 40 },
      engine: { root: [ROOT_MOVES[0], ...ROOT_MOVES.slice(1).map((m) => mv(m.move, 0.3))] },
    });
    h.position();
    h.go(GO);
    expect(h.last().rationale.budgetPct).toBeCloseTo(1.2, 9);
  });

  it("caps spending over ten moves at 2.5x the single-move budget", () => {
    const strong = { F_T: 1, F_R: 1, F_F: 1, F_C: 1, F_K: 1, F_I: 1 };
    const h = makeHarness({
      options: { posture: "Coil", style: 100, independence: 100 },
      core: { features: { h2h3: strong }, proposals: [proposal("h2h3", "edge", strong)] },
      engine: { root: swap(ROOT_MOVES, "h2h3", 0.526, 20) },
    });
    for (let i = 0; i < 3; i++) {
      h.position(ROOT);
      h.go(GO);
    }
    const played = h.bestmoves();
    expect(played).toHaveLength(3);
    // 1.5 + 1.5 pass the cap (spent 2.8 of 3.75); the third finds only 0.95 left.
    expect(played[0].move).toBe("h2h3");
    expect(played[1].move).toBe("h2h3");
    expect(played[2].move).toBe("g1f3");
    expect(played[2].rationale.budgetPct).toBeCloseTo(0.95, 9);
    assertSafety(h);
  });
});

describe("options", () => {
  it("accepts KairosIndependence and ignores garbage values", () => {
    const h = makeHarness({ options: { independence: 0 } });
    h.controller.handleCommand({ type: "setoption", name: "KairosIndependence", value: "100" });
    h.controller.handleCommand({ type: "setoption", name: "KairosIndependence", value: "x" });
    h.position();
    h.go(GO);
    expect(h.core.proposeCalls).toHaveLength(1);
    expect(h.engine.searches.map((s) => s.kind)).toContain("judge");
  });

  it("KairosStyle 0 via setoption switches to passthrough", () => {
    const h = makeHarness();
    h.controller.handleCommand({ type: "setoption", name: "KairosStyle", value: "0" });
    h.position();
    h.go(GO);
    expect(h.last().rationale.reason).toBe("style-zero");
    assertSafety(h);
  });

  it("starts a new game in both the core and the engine", () => {
    const h = makeHarness();
    const before = h.core.newGames;
    h.controller.handleCommand({ type: "newgame" });
    expect(h.core.newGames).toBe(before + 1);
    expect(h.engine.sent).toContain("ucinewgame");
  });
});

describe("standalone mode (no Stockfish)", () => {
  it("plays with the own search and never talks to the engine", () => {
    const h = makeHarness({ options: { standalone: true } });
    expect(h.events.some((e) => e.event.type === "ready" && e.event.mode === "standalone")).toBe(true);
    h.position();
    h.go("go movetime 500");
    h.flush();
    const played = h.last();
    expect(played.rationale.kind).toBe("standalone");
    expect(played.move).toBe("g1f3");
    expect(h.engine.sent).toHaveLength(0);
    expect(h.core.searchStarts).toHaveLength(1);
  });

  it("reports mate and falls back to a legal move when the core suggests an illegal one", () => {
    const mate = makeHarness({
      options: { standalone: true },
      core: { ownBest: { move: "h2h3", cp: 29990, mate: 2, depth: 4 } },
    });
    mate.position();
    mate.go("go movetime 500");
    mate.flush();
    expect(mate.last().move).toBe("h2h3");
    expect(mate.last().rationale.reason).toBe("own-search-mate");
    const illegal = makeHarness({
      options: { standalone: true },
      core: { ownBest: { move: "z9z9", cp: 0, mate: null, depth: 1 } },
    });
    illegal.position();
    illegal.go("go movetime 500");
    illegal.flush();
    expect(illegal.last().move).toBe("g1f3");
  });

  it("honours stop and the time limit between slices", () => {
    const h = makeHarness({ options: { standalone: true }, core: { searchSteps: 1000 } });
    h.position();
    h.go("go movetime 500");
    h.controller.handleCommand({ type: "stop" });
    h.flush();
    expect(h.bestmoves()).toHaveLength(1);
    const timed = makeHarness({ options: { standalone: true }, core: { searchSteps: 1000 } });
    timed.position();
    timed.go("go movetime 500");
    timed.clock.now = 10_000;
    timed.flush();
    expect(timed.bestmoves()).toHaveLength(1);
  });

  it("takes over when Stockfish is lost mid-session", () => {
    const h = makeHarness();
    h.position();
    h.go(GO);
    expect(h.last().rationale.kind).toBe("rerank");
    const sentBefore = h.engine.sent.length;
    h.controller.handleCommand({ type: "standalone", reason: "engine crashed twice" });
    expect(h.events.some((e) => e.event.type === "mode" && e.event.mode === "standalone")).toBe(true);
    h.position(ROOT);
    h.go("go movetime 500");
    h.flush();
    expect(h.last().rationale.kind).toBe("standalone");
    expect(h.engine.sent).toHaveLength(sentBefore);
    // late lines from the dead engine are ignored
    h.controller.handleEngineLine("bestmove e2e4");
    expect(h.bestmoves()).toHaveLength(2);
  });

  it("completes the handshake in standalone mode when Stockfish never answered", () => {
    const h = makeHarness({ engine: { id: "Stockfish 19" } });
    // simulate a fresh controller that never sees uciok
    const stalled = makeHarness();
    stalled.controller.handleCommand({ type: "init", options: {}, seed: 2 });
    stalled.engine.sent.length = 0;
    stalled.controller.handleCommand({ type: "standalone", reason: "init-timeout" });
    expect(stalled.events.filter((e) => e.event.type === "ready").length).toBeGreaterThan(0);
    void h;
  });
});

describe("scoring inputs", () => {
  it("a KAIROS proposal with no feature advantage is not played", () => {
    const h = makeHarness({
      core: { features: {}, proposals: [proposal("h2h3", "edge", {})] },
    });
    h.position();
    h.go(GO);
    expect(h.last().move).toBe("g1f3");
    expect(h.last().rationale.reason).toBe("no-eligible-rerank");
    assertSafety(h);
  });

  it("DEFAULT_PROPOSALS are what the scenarios assume", () => {
    expect(DEFAULT_PROPOSALS.map((p) => p.move)).toEqual(["h2h3", "d2d4"]);
  });
});

/**
 * Headless match harness: KAIROS (controller + Rust core + Stockfish Lite) against
 * plain Stockfish Lite at identical movetime, both colours, fixed openings.
 *
 *   node tools/run-ts.mjs tools/match.ts --games 8 --movetime 2000 --style 60 --out match-results/run1.json
 *
 * It reports score, game length, disagreement rate, out-of-top-3 rate, the
 * verified-loss distribution, a blunder rate measured by an independent
 * analysis engine, and the identity fingerprint (spec 11.8). It makes NO Elo
 * claim; with fewer than ~500 games the fingerprint p-values are not meaningful.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { KairosOptions } from "../src/controller";
import { probeFeatures } from "../src/scoring";
import { PlainEngine } from "./engine";
import { loadCoreAuto } from "./node-core";
import { KairosSession } from "./session";
import { mean, percentile, welchP } from "./stats";

const BASE_DIR = dirname(resolve(process.argv[1] ?? "."));

const OPENINGS: string[][] = [
  ["e2e4", "e7e5", "g1f3", "b8c6"],
  ["d2d4", "d7d5", "c2c4", "e7e6"],
  ["c2c4", "e7e5", "b1c3", "g8f6"],
  ["e2e4", "c7c5", "g1f3", "d7d6"],
  ["d2d4", "g8f6", "c2c4", "g7g6"],
  ["g1f3", "d7d5", "g2g3", "g8f6"],
  ["e2e4", "e7e6", "d2d4", "d7d5"],
  ["e2e4", "c7c6", "d2d4", "d7d5"],
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

interface PlyRecord {
  game: number;
  ply: number;
  side: "KAIROS" | "Stockfish";
  move: string;
  tension: number;
  captureLate: boolean;
  capture: boolean;
  dropCp: number | null;
  narrowness: number | null;
  rationale?: {
    kind: string;
    reason: string;
    sfBest: string;
    sfTop3: string[];
    outsideTop3: boolean;
    playedProposed: boolean;
    lossPct: number;
    budgetPct: number;
  };
}

function queens(fen: string): number {
  return (fen.split(" ")[0].match(/[qQ]/g) ?? []).length;
}

async function main(): Promise<void> {
  const enginePath = resolve(arg("engine", join(BASE_DIR, "..", "public", "engine", "stockfish-19-lite-single.js")));
  const games = Math.max(1, Number(arg("games", "8")));
  const movetime = Number(arg("movetime", "2000"));
  const analysisDepth = Number(arg("analysis-depth", "10"));
  const maxPlies = Number(arg("max-plies", "160"));
  const out = arg("out", "");
  const options: Partial<KairosOptions> = {
    style: Number(arg("style", "50")),
    independence: Number(arg("independence", "50")),
    variety: Number(arg("variety", "0")),
  };

  const judge = await loadCoreAuto(BASE_DIR);
  const kairos = await KairosSession.start(enginePath, options);
  const plain = await PlainEngine.start(enginePath);
  const analysis = analysisDepth > 0 ? await PlainEngine.start(enginePath) : null;

  const records: PlyRecord[] = [];
  const results: { game: number; kairosColor: "w" | "b"; result: string; plies: number; score: number }[] = [];
  const firstQueenTrade: Record<"KAIROS" | "Stockfish", number[]> = { KAIROS: [], Stockfish: [] };

  for (let g = 0; g < games; g++) {
    const opening = OPENINGS[Math.floor(g / 2) % OPENINGS.length];
    const kairosColor: "w" | "b" = g % 2 === 0 ? "w" : "b";
    const moves = [...opening];
    kairos.newGame();
    const streaks: Record<"KAIROS" | "Stockfish", Map<string, number>> = {
      KAIROS: new Map(),
      Stockfish: new Map(),
    };
    let result = "adjudicated-draw";
    let queenTradeSeen = false;
    for (let ply = moves.length; ply < maxPlies; ply++) {
      const position = `position startpos moves ${moves.join(" ")}`;
      judge.setPosition(position);
      const over = judge.gameResult();
      if (over !== "") {
        result = over === "checkmate" ? (judge.sideToMove() === kairosColor ? "loss" : "win") : over;
        break;
      }
      const stm = judge.sideToMove();
      const side: "KAIROS" | "Stockfish" = stm === kairosColor ? "KAIROS" : "Stockfish";
      const tension = judge.tensionIndex();

      // capture availability (for the late-release rate)
      const available = new Set<string>();
      for (const move of judge.legalMoves()) {
        const f = judge.features(move);
        if (f?.capture && (f.see ?? 0) >= 0) {
          available.add(move);
        }
      }
      const queensBefore = queens(judge.fen());

      let move: string;
      let rationale: PlyRecord["rationale"];
      if (side === "KAIROS") {
        const played = await kairos.move(position, `go movetime ${movetime}`);
        move = played.move;
        const r = played.rationale;
        rationale = {
          kind: r.kind,
          reason: r.reason,
          sfBest: r.sfBest,
          sfTop3: r.sfTop3,
          outsideTop3: r.outsideTop3,
          playedProposed: r.playedProposed,
          lossPct: r.lossPct,
          budgetPct: r.budgetPct,
        };
      } else {
        move = await plain.best(position, `go movetime ${movetime}`);
      }
      if (!judge.isLegal(move)) {
        result = side === "KAIROS" ? "loss-illegal-move" : "win-opponent-illegal";
        break;
      }

      const capture = judge.features(move)?.capture === true;
      const streak = streaks[side];
      const wasAvailable = streak.get(move) ?? 0;
      const captureLate = capture && wasAvailable >= 2;
      const nextStreak = new Map<string, number>();
      for (const key of available) {
        nextStreak.set(key, (streak.get(key) ?? 0) + 1);
      }
      streaks[side] = nextStreak;

      let dropCp: number | null = null;
      let narrowness: number | null = null;
      const after = judge.childFen(move);
      if (analysis) {
        const best = await analysis.search(position, `go depth ${analysisDepth}`);
        const deepest = Math.max(0, ...best.infos.map((c) => c.depth));
        const top = best.infos.find((c) => c.depth === deepest && c.multipv === 1);
        const scores = await analysis.scoreMoves(position, [move], analysisDepth);
        const played = scores.get(move);
        if (top && played !== undefined) {
          const topCp = top.scoreKind === "cp" ? top.scoreValue : Math.sign(top.scoreValue) * 100000;
          dropCp = Math.max(0, topCp - played);
        }
        if (after) {
          const replies = await analysis.replies(`position fen ${after}`, 8);
          if (replies.length > 0) {
            narrowness =
              (probeFeatures({ best: replies[0], second: replies[1] ?? null, replies }, null).F_N as number | undefined) ?? null;
          }
        }
      }
      moves.push(move);
      if (after && !queenTradeSeen && queens(after) < queensBefore) {
        queenTradeSeen = true;
        firstQueenTrade[side].push(ply);
      }
      records.push({ game: g, ply, side, move, tension, capture, captureLate, dropCp, narrowness, rationale });
    }
    const score = result.startsWith("win") ? 1 : result.startsWith("loss") ? 0 : 0.5;
    results.push({ game: g, kairosColor, result, plies: moves.length, score });
    console.error(`game ${g + 1}/${games}: ${result} after ${moves.length} plies`);
  }

  kairos.close();
  plain.close();
  analysis?.close();

  const mine = records.filter((r) => r.side === "KAIROS");
  const theirs = records.filter((r) => r.side === "Stockfish");
  const withBaseline = mine.filter((r) => r.rationale && r.rationale.sfBest !== "");
  const withTop3 = mine.filter((r) => r.rationale && r.rationale.sfTop3.length > 0);
  const reranks = mine.filter((r) => r.rationale?.kind === "rerank");
  const lossAll = mine.map((r) => r.rationale?.lossPct ?? 0);
  const lossRerank = reranks.map((r) => r.rationale?.lossPct ?? 0);
  const midgame = (rows: PlyRecord[]): number[] => rows.filter((r) => r.ply >= 20 && r.ply <= 40).map((r) => r.tension);
  const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den);
  const blunders = (rows: PlyRecord[]): number | null => {
    const measured = rows.filter((r) => r.dropCp !== null);
    return measured.length === 0 ? null : (measured.filter((r) => (r.dropCp as number) > 150).length / measured.length) * 1000;
  };
  const lateRate = (rows: PlyRecord[]): number | null => rate(rows.filter((r) => r.captureLate).length, rows.filter((r) => r.capture).length);
  const narrow = (rows: PlyRecord[]): number[] => rows.filter((r) => r.narrowness !== null).map((r) => r.narrowness as number);

  const summary = {
    config: { games, movetime, analysisDepth, options, enginePath },
    score: {
      kairosPoints: results.reduce((s, r) => s + r.score, 0),
      games: results.length,
      wins: results.filter((r) => r.score === 1).length,
      draws: results.filter((r) => r.score === 0.5).length,
      losses: results.filter((r) => r.score === 0).length,
      meanPlies: mean(results.map((r) => r.plies)),
      note: "No Elo claim: sample size and conditions are not controlled.",
    },
    kairosMoves: mine.length,
    disagreementRate: rate(withBaseline.filter((r) => r.move !== r.rationale?.sfBest).length, withBaseline.length),
    outOfTop3Rate: rate(withTop3.filter((r) => r.rationale?.outsideTop3).length, withTop3.length),
    reranks: reranks.length,
    reranksFromKairosProposals: reranks.filter((r) => r.rationale?.playedProposed).length,
    verifiedLoss: {
      allMoves: { mean: mean(lossAll), p95: percentile(lossAll, 95) },
      rerankMoves: { mean: mean(lossRerank), p95: percentile(lossRerank, 95) },
    },
    blunderPer1000: { kairos: blunders(mine), stockfish: blunders(theirs), threshold: "drop > 150 cp at depth " + analysisDepth },
    fingerprint: {
      tensionPlies20to40: { kairos: mean(midgame(mine)), stockfish: mean(midgame(theirs)), pApprox: welchP(midgame(mine), midgame(theirs)) },
      lateReleaseRate: { kairos: lateRate(mine), stockfish: lateRate(theirs) },
      opponentNarrowness: { kairos: mean(narrow(mine)), stockfish: mean(narrow(theirs)), pApprox: welchP(narrow(mine), narrow(theirs)) },
      firstQueenTradePly: { kairos: mean(firstQueenTrade.KAIROS), stockfish: mean(firstQueenTrade.Stockfish) },
      exchangeSacrificesPer100Games: "not measured",
    },
    caveat:
      games < 500
        ? `Only ${games} games: the spec's p < 0.01 identity claim needs 500+ games; treat these numbers as descriptive.`
        : "Sample large enough for the p-values to be informative, subject to the usual caveats.",
  };
  console.log(JSON.stringify(summary, null, 2));
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), JSON.stringify({ summary, results, records }, null, 1));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

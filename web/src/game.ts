import { Chess, type Move, type Square } from "chess.js";

export function positionCommand(game: Chess): string {
  const moves = game.history({ verbose: true });
  return moves.length === 0
    ? "position startpos"
    : `position startpos moves ${moves.map((move) => move.lan).join(" ")}`;
}

export function applyEngineMove(game: Chess, uci: string): Move | null {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
    return null;
  }
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.length > 4 ? uci[4] : undefined;
  if (promotion !== undefined) {
    const piece = game.get(from);
    const lastRank = piece?.color === "w" ? "8" : "1";
    if (piece?.type !== "p" || to[1] !== lastRank) {
      return null;
    }
  }
  try {
    return game.move({ from, to, promotion });
  } catch {
    if (promotion === undefined) {
      try {
        return game.move({ from, to, promotion: "q" });
      } catch {
        return null;
      }
    }
    return null;
  }
}

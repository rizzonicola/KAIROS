/**
 * Small, non-generating chess position reader for KAIROS' first features.
 *
 * This module never generates or validates legal moves. It only applies moves
 * supplied by the UCI engine / GUI to a FEN position. Stockfish remains the
 * sole source of legal candidate moves and tactical verification.
 */

export const STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const MOVE_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export interface Features {
  T: number;
  F_T: number;
  F_N: number;
  F_R: number;
  F_C: number;
  F_F: number;
  F_P: number;
  F_K: number;
  F_S: number;
  F_I: number;
}

export interface PositionStats {
  tension: number;
  ownKingAttackers: number;
  ownKingDefenders: number;
  enemyKingAttackers: number;
  enemyKingDefenders: number;
  phase: number;
  materialBalance: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function squareToIndex(square: string): number {
  return (Number(square[1]) - 1) * 8 + (square.charCodeAt(0) - "a".charCodeAt(0));
}

function indexToSquare(index: number): string {
  return String.fromCharCode("a".charCodeAt(0) + (index % 8)) + (Math.floor(index / 8) + 1);
}

function isWhitePiece(piece: string): boolean {
  return piece === piece.toUpperCase();
}

function sliderOnRay(piece: string, df: number, dr: number): boolean {
  const kind = piece.toLowerCase();
  if (df === 0 || dr === 0) {
    return kind === "r" || kind === "q";
  }
  return kind === "b" || kind === "q";
}

export class Board {
  readonly squares: (string | null)[];
  readonly turn: string;
  readonly castling: string;
  readonly epSquare: number | null;
  readonly halfmove: number;
  readonly fullmove: number;

  constructor(
    squares: (string | null)[],
    turn: string,
    castling: string,
    epSquare: number | null,
    halfmove = 0,
    fullmove = 1,
  ) {
    this.squares = squares;
    this.turn = turn;
    this.castling = castling;
    this.epSquare = epSquare;
    this.halfmove = halfmove;
    this.fullmove = fullmove;
  }

  static fromFen(fen: string): Board {
    const fields = fen.trim().split(/\s+/);
    if (fields.length !== 6) {
      throw new Error("FEN must contain six fields");
    }
    const [placement, turn, castling, ep, halfmoveField, fullmoveField] = fields;
    if (turn !== "w" && turn !== "b") {
      throw new Error("invalid FEN active color");
    }
    const ranks = placement.split("/");
    if (ranks.length !== 8) {
      throw new Error("invalid FEN board");
    }
    const squares: (string | null)[] = new Array(64).fill(null);
    for (let fenRank = 0; fenRank < ranks.length; fenRank++) {
      const row = ranks[fenRank];
      let fileIndex = 0;
      const rankIndex = 7 - fenRank;
      for (const char of row) {
        if (/[0-9]/.test(char)) {
          fileIndex += Number(char);
        } else if ("PNBRQKpnbrqk".includes(char)) {
          if (fileIndex >= 8) {
            throw new Error("invalid FEN rank width");
          }
          squares[rankIndex * 8 + fileIndex] = char;
          fileIndex += 1;
        } else {
          throw new Error("invalid FEN piece");
        }
      }
      if (fileIndex !== 8) {
        throw new Error("invalid FEN rank width");
      }
    }
    const halfmove = parseFenCounter(halfmoveField);
    const fullmove = parseFenCounter(fullmoveField);
    return new Board(
      squares,
      turn,
      castling,
      ep === "-" ? null : squareToIndex(ep),
      halfmove,
      fullmove,
    );
  }

  toFen(): string {
    const rows: string[] = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = "";
      let empty = 0;
      for (let fileIndex = 0; fileIndex < 8; fileIndex++) {
        const piece = this.squares[rank * 8 + fileIndex];
        if (piece === null) {
          empty += 1;
        } else {
          if (empty) {
            row += String(empty);
            empty = 0;
          }
          row += piece;
        }
      }
      if (empty) {
        row += String(empty);
      }
      rows.push(row);
    }
    const castling = this.castling || "-";
    const ep = this.epSquare === null ? "-" : indexToSquare(this.epSquare);
    return `${rows.join("/")} ${this.turn} ${castling} ${ep} ${this.halfmove} ${this.fullmove}`;
  }

  /** Apply a syntactically valid move already supplied as legal by a UCI peer. */
  applyUci(move: string): Board {
    const match = MOVE_RE.exec(move);
    if (!match) {
      throw new Error(`unsupported UCI move: ${move}`);
    }
    const [, fromSq, toSq, promotion] = match;
    const source = squareToIndex(fromSq);
    const target = squareToIndex(toSq);
    const piece = this.squares[source];
    if (piece === null) {
      throw new Error(`no piece on ${fromSq}`);
    }
    if (isWhitePiece(piece) !== (this.turn === "w")) {
      throw new Error(`wrong side to move for ${move}`);
    }

    const board = this.squares.slice();
    let captured = board[target];
    const isPawn = piece.toLowerCase() === "p";
    const fromFile = source % 8;
    const fromRank = Math.floor(source / 8);
    const toFile = target % 8;
    const toRank = Math.floor(target / 8);

    // En passant: a pawn moves diagonally to the FEN en-passant target.
    if (isPawn && fromFile !== toFile && captured === null && this.epSquare === target) {
      const capturedSquare = this.turn === "w" ? target - 8 : target + 8;
      captured = board[capturedSquare];
      board[capturedSquare] = null;
    }

    board[source] = null;
    if (promotion) {
      if (!isPawn || (toRank !== 0 && toRank !== 7)) {
        throw new Error(`invalid promotion move: ${move}`);
      }
      board[target] = this.turn === "w" ? promotion.toUpperCase() : promotion;
    } else {
      board[target] = piece;
    }

    // Castling rook movement. The king move itself is trusted to Stockfish.
    if (piece.toLowerCase() === "k" && Math.abs(toFile - fromFile) === 2) {
      const rookFrom = toFile === 6 ? fromRank * 8 + 7 : fromRank * 8;
      const rookTo = toFile === 6 ? fromRank * 8 + 5 : fromRank * 8 + 3;
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    }

    const rights = new Set(this.castling.replace("-", "").split(""));
    if (piece.toLowerCase() === "k") {
      rights.delete(this.turn === "w" ? "K" : "k");
      rights.delete(this.turn === "w" ? "Q" : "q");
    }
    const rookRights: Record<string, string> = { a1: "Q", h1: "K", a8: "q", h8: "k" };
    if (fromSq in rookRights) {
      rights.delete(rookRights[fromSq]);
    }
    if (toSq in rookRights && captured !== null) {
      rights.delete(rookRights[toSq]);
    }
    const orderedRights = "KQkq"
      .split("")
      .filter((char) => rights.has(char))
      .join("") || "-";

    let epSquare: number | null = null;
    if (isPawn && Math.abs(toRank - fromRank) === 2) {
      epSquare = Math.floor((source + target) / 2);
    }
    const nextTurn = this.turn === "w" ? "b" : "w";
    const halfmove = isPawn || captured !== null ? 0 : this.halfmove + 1;
    const fullmove = this.fullmove + (this.turn === "b" ? 1 : 0);
    return new Board(board, nextTurn, orderedRights, epSquare, halfmove, fullmove);
  }

  /** True when the move is a pawn move or capture (50-move reset). */
  resetsHalfmove(move: string): boolean {
    return this.applyUci(move).halfmove === 0;
  }

  /** Count opposing pawn pairs that currently attack one another. */
  pawnLeverCount(): number {
    const white = this.squares.flatMap((piece, index) => (piece === "P" ? [index] : []));
    const black = this.squares.flatMap((piece, index) => (piece === "p" ? [index] : []));
    let count = 0;
    for (const w of white) {
      const wf = w % 8;
      const wr = Math.floor(w / 8);
      for (const b of black) {
        const bf = b % 8;
        const br = Math.floor(b / 8);
        if (br === wr + 1 && Math.abs(bf - wf) === 1) {
          count += 1;
        }
      }
    }
    return count;
  }

  /**
   * Count absolute pins: one own piece shielding its king from an enemy slider.
   *
   * Exact geometry for the current position, not full pin/x-ray analysis of
   * future lines.
   */
  pinCount(): number {
    let count = 0;
    for (const [king, kingIsWhite] of [["K", true], ["k", false]] as const) {
      const kingSquare = this.squares.indexOf(king);
      if (kingSquare === -1) {
        continue;
      }
      const kf = kingSquare % 8;
      const kr = Math.floor(kingSquare / 8);
      for (const [df, dr] of DIRECTIONS) {
        let filePos = kf + df;
        let rankPos = kr + dr;
        let pinnedSquare: number | null = null;
        while (filePos >= 0 && filePos < 8 && rankPos >= 0 && rankPos < 8) {
          const square = rankPos * 8 + filePos;
          const piece = this.squares[square];
          if (piece !== null) {
            if (pinnedSquare === null) {
              if (isWhitePiece(piece) !== kingIsWhite) {
                break; // enemy piece on the ray: attacker, not a pin
              }
              pinnedSquare = square;
            } else {
              if (isWhitePiece(piece) !== kingIsWhite && sliderOnRay(piece, df, dr)) {
                count += 1;
              }
              break;
            }
          }
          filePos += df;
          rankPos += dr;
        }
      }
    }
    return count;
  }

  /** Tension Index proxy: mutually attacking pawn pairs plus absolute pins. */
  tensionCount(): number {
    return this.pawnLeverCount() + this.pinCount();
  }

  capturedValue(move: string): number {
    const match = MOVE_RE.exec(move);
    if (!match) {
      return 0;
    }
    const source = squareToIndex(match[1]);
    const target = squareToIndex(match[2]);
    const piece = this.squares[source];
    let victim = this.squares[target];
    if (piece === null) {
      return 0;
    }
    if (
      piece.toLowerCase() === "p" &&
      source % 8 !== target % 8 &&
      victim === null &&
      this.epSquare === target
    ) {
      const victimSquare = this.turn === "w" ? target - 8 : target + 8;
      victim = this.squares[victimSquare];
    }
    return victim ? (PIECE_VALUE[victim.toLowerCase()] ?? 0) : 0;
  }

  /** Net material change for the mover: captured value minus promotion gain. */
  materialDelta(move: string): number {
    const match = MOVE_RE.exec(move);
    if (!match) {
      return 0;
    }
    const promotion = match[3];
    const promotionGain = promotion ? PIECE_VALUE[promotion] - PIECE_VALUE["p"] : 0;
    return this.capturedValue(move) - promotionGain;
  }

  moveGivesCheck(move: string): boolean {
    const after = this.applyUci(move);
    const enemyKing = this.turn === "w" ? "k" : "K";
    return after.kingAttacked(enemyKing);
  }

  /** True when the moved piece attacks the enemy queen from its destination. */
  moveThreatensEnemyQueen(move: string): boolean {
    const match = MOVE_RE.exec(move);
    if (!match) {
      return false;
    }
    const after = this.applyUci(move);
    const enemyQueen = this.turn === "w" ? "q" : "Q";
    const queenSquare = after.squares.indexOf(enemyQueen);
    if (queenSquare === -1) {
      return false;
    }
    return after.attacksSquare(squareToIndex(match[2]), queenSquare);
  }

  kingAttacked(king: string): boolean {
    const kingSquare = this.squares.indexOf(king);
    if (kingSquare === -1) {
      return false;
    }
    const kingIsWhite = king === "K";
    return this.squares.some(
      (piece, index) =>
        piece !== null &&
        isWhitePiece(piece) !== kingIsWhite &&
        this.attacksSquare(index, kingSquare),
    );
  }

  attacksSquare(source: number, target: number): boolean {
    const piece = this.squares[source];
    if (piece === null || source === target) {
      return false;
    }
    const sf = source % 8;
    const sr = Math.floor(source / 8);
    const tf = target % 8;
    const tr = Math.floor(target / 8);
    const df = tf - sf;
    const dr = tr - sr;
    const kind = piece.toLowerCase();
    if (kind === "p") {
      const direction = isWhitePiece(piece) ? 1 : -1;
      return dr === direction && Math.abs(df) === 1;
    }
    if (kind === "n") {
      return (Math.abs(df) === 1 && Math.abs(dr) === 2) || (Math.abs(df) === 2 && Math.abs(dr) === 1);
    }
    if (kind === "k") {
      return Math.max(Math.abs(df), Math.abs(dr)) === 1;
    }

    if (kind === "b" && Math.abs(df) !== Math.abs(dr)) {
      return false;
    }
    if (kind === "r" && !(df === 0 || dr === 0)) {
      return false;
    }
    if (kind === "q" && !(df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr))) {
      return false;
    }
    if (kind !== "b" && kind !== "r" && kind !== "q") {
      return false;
    }
    const stepF = Math.sign(df);
    const stepR = Math.sign(dr);
    let filePos = sf + stepF;
    let rankPos = sr + stepR;
    while (filePos !== tf || rankPos !== tr) {
      if (this.squares[rankPos * 8 + filePos] !== null) {
        return false;
      }
      filePos += stepF;
      rankPos += stepR;
    }
    return true;
  }

  kingSquare(white: boolean): number | null {
    const square = this.squares.indexOf(white ? "K" : "k");
    return square === -1 ? null : square;
  }

  kingZone(white: boolean): Set<number> {
    const king = this.kingSquare(white);
    if (king === null) {
      return new Set();
    }
    const fileIndex = king % 8;
    const rankIndex = Math.floor(king / 8);
    const zone = new Set<number>();
    for (let rank = Math.max(0, rankIndex - 1); rank <= Math.min(7, rankIndex + 1); rank++) {
      for (let file = Math.max(0, fileIndex - 1); file <= Math.min(7, fileIndex + 1); file++) {
        zone.add(rank * 8 + file);
      }
    }
    return zone;
  }

  isAttackedByPawn(target: number, byWhite: boolean): boolean {
    return this.squares.some(
      (piece, source) =>
        piece === (byWhite ? "P" : "p") && this.attacksSquare(source, target),
    );
  }

  /**
   * Pseudo-legal destinations for a piece. Not a legality claim.
   *
   * Castling and en-passant capture beyond the FEN target are omitted.
   */
  pseudoMoves(source: number): number[] {
    const piece = this.squares[source];
    if (piece === null) {
      return [];
    }
    const white = isWhitePiece(piece);
    const kind = piece.toLowerCase();
    const fileIndex = source % 8;
    const rankIndex = Math.floor(source / 8);
    const targets: number[] = [];
    if (kind === "p") {
      const direction = white ? 1 : -1;
      const oneRank = rankIndex + direction;
      if (!(oneRank >= 0 && oneRank < 8)) {
        return [];
      }
      const one = oneRank * 8 + fileIndex;
      if (this.squares[one] === null) {
        targets.push(one);
        const startRank = white ? 1 : 6;
        const twoRank = rankIndex + 2 * direction;
        if (rankIndex === startRank && this.squares[twoRank * 8 + fileIndex] === null) {
          targets.push(twoRank * 8 + fileIndex);
        }
      }
      for (const df of [-1, 1]) {
        const nf = fileIndex + df;
        if (nf >= 0 && nf < 8) {
          const target = oneRank * 8 + nf;
          const victim = this.squares[target];
          if (victim !== null && isWhitePiece(victim) !== white) {
            targets.push(target);
          } else if (victim === null && this.epSquare === target) {
            targets.push(target);
          }
        }
      }
      return targets;
    }
    for (let target = 0; target < 64; target++) {
      if (target === source) {
        continue;
      }
      const victim = this.squares[target];
      if (victim !== null && isWhitePiece(victim) === white) {
        continue;
      }
      if (this.attacksSquare(source, target)) {
        targets.push(target);
      }
    }
    return targets;
  }

  /** Non-king pseudo-legal moves whose destination is not attacked by a pawn. */
  safeMobility(white: boolean): number {
    let total = 0;
    for (let source = 0; source < 64; source++) {
      const piece = this.squares[source];
      if (piece === null || isWhitePiece(piece) !== white || piece.toLowerCase() === "k") {
        continue;
      }
      for (const target of this.pseudoMoves(source)) {
        if (!this.isAttackedByPawn(target, !white)) {
          total += 1;
        }
      }
    }
    return total;
  }

  /** Pawn pushes that would create a new lever on an enemy pawn. */
  pawnBreaks(white: boolean): number {
    let breaks = 0;
    for (let source = 0; source < 64; source++) {
      const piece = this.squares[source];
      if (piece !== (white ? "P" : "p")) {
        continue;
      }
      const fileIndex = source % 8;
      const rankIndex = Math.floor(source / 8);
      const direction = white ? 1 : -1;
      for (const steps of [1, 2]) {
        if (steps === 2 && rankIndex !== (white ? 1 : 6)) {
          continue;
        }
        const targetRank = rankIndex + steps * direction;
        if (!(targetRank >= 0 && targetRank < 8)) {
          continue;
        }
        const target = targetRank * 8 + fileIndex;
        if (this.squares[target] !== null) {
          break;
        }
        const attackRank = targetRank + direction;
        if (
          attackRank >= 0 &&
          attackRank < 8 &&
          [-1, 1].some(
            (df) =>
              fileIndex + df >= 0 &&
              fileIndex + df < 8 &&
              this.squares[attackRank * 8 + fileIndex + df] === (white ? "p" : "P"),
          )
        ) {
          breaks += 1;
        }
      }
    }
    return breaks;
  }

  /** Non-pawn pieces not committed to an enemy pawn and with two safe squares. */
  reserveCount(white: boolean): number {
    let reserve = 0;
    for (let source = 0; source < 64; source++) {
      const piece = this.squares[source];
      if (
        piece === null ||
        isWhitePiece(piece) !== white ||
        piece.toLowerCase() === "p" ||
        piece.toLowerCase() === "k"
      ) {
        continue;
      }
      if (this.isAttackedByPawn(source, !white)) {
        continue;
      }
      const safe = this.pseudoMoves(source).filter(
        (target) => !this.isAttackedByPawn(target, !white),
      );
      if (safe.length >= 2) {
        reserve += 1;
      }
    }
    return reserve;
  }

  /** Return [mutually protected pieces, enemy-king-zone attackers, batteries]. */
  coordination(white: boolean): [number, number, number] {
    let mutual = 0;
    for (let source = 0; source < 64; source++) {
      const piece = this.squares[source];
      if (piece === null || isWhitePiece(piece) !== white) {
        continue;
      }
      if (
        this.squares.some(
          (otherPiece, other) =>
            other !== source &&
            otherPiece !== null &&
            isWhitePiece(otherPiece) === white &&
            this.attacksSquare(other, source),
        )
      ) {
        mutual += 1;
      }
    }
    const enemyZone = this.kingZone(!white);
    let kingAttacks = 0;
    for (let source = 0; source < 64; source++) {
      const piece = this.squares[source];
      if (
        piece !== null &&
        isWhitePiece(piece) === white &&
        [...enemyZone].some((target) => this.attacksSquare(source, target))
      ) {
        kingAttacks += 1;
      }
    }
    let batteries = 0;
    for (let source = 0; source < 64; source++) {
      const piece = this.squares[source];
      if (piece === null || isWhitePiece(piece) !== white) {
        continue;
      }
      const kind = piece.toLowerCase();
      if (kind !== "q" && kind !== "r" && kind !== "b") {
        continue;
      }
      for (const [df, dr] of DIRECTIONS) {
        if (kind === "r" && !(df === 0 || dr === 0)) {
          continue;
        }
        if (kind === "b" && !(df !== 0 && dr !== 0)) {
          continue;
        }
        let fileIndex = (source % 8) + df;
        let rankIndex = Math.floor(source / 8) + dr;
        let ownSeen = false;
        while (fileIndex >= 0 && fileIndex < 8 && rankIndex >= 0 && rankIndex < 8) {
          const other = this.squares[rankIndex * 8 + fileIndex];
          if (other !== null) {
            if (!ownSeen) {
              if (isWhitePiece(other) !== white) {
                break;
              }
              ownSeen = true;
            } else {
              if (isWhitePiece(other) !== white) {
                batteries += 1;
              }
              break;
            }
          }
          fileIndex += df;
          rankIndex += dr;
        }
      }
    }
    return [mutual, kingAttacks, batteries];
  }

  /** Return [defenders, attackers] of the given side's 3x3 king zone. */
  kingMargin(white: boolean): [number, number] {
    const zone = this.kingZone(white);
    if (zone.size === 0) {
      return [0, 0];
    }
    const defenders = new Set<number>();
    const attackers = new Set<number>();
    for (let source = 0; source < 64; source++) {
      const piece = this.squares[source];
      if (piece === null) {
        continue;
      }
      if ([...zone].some((target) => this.attacksSquare(source, target))) {
        if (isWhitePiece(piece) === white) {
          defenders.add(source);
        } else {
          attackers.add(source);
        }
      }
    }
    return [defenders.size, attackers.size];
  }

  materialBalance(): number {
    let total = 0;
    for (const piece of this.squares) {
      if (piece !== null) {
        const value = PIECE_VALUE[piece.toLowerCase()];
        total += isWhitePiece(piece) ? value : -value;
      }
    }
    return total;
  }

  phase(): number {
    let nonPawn = 0;
    for (const piece of this.squares) {
      if (piece !== null && piece.toLowerCase() !== "p" && piece.toLowerCase() !== "k") {
        nonPawn += PIECE_VALUE[piece.toLowerCase()];
      }
    }
    return clamp(nonPawn / 62.0, 0.0, 1.0);
  }

  positionKey(): string {
    return this.toFen().split(/\s+/).slice(0, 4).join(" ");
  }

  /** FEN with the side to move flipped. Null when that position is illegal. */
  nullMoveFen(): string | null {
    const ownKing = this.turn === "w" ? "K" : "k";
    if (this.kingAttacked(ownKing)) {
      return null;
    }
    const fields = this.toFen().split(/\s+/);
    fields[1] = this.turn === "w" ? "b" : "w";
    fields[3] = "-";
    return fields.join(" ");
  }

  /** Share of checks/captures among the first six PV moves. */
  forcingDensity(moves: string[]): number {
    let board: Board = this;
    let forcing = 0;
    let total = 0;
    for (const move of moves.slice(0, 6)) {
      let givesCheck: boolean;
      let captures: boolean;
      try {
        givesCheck = board.moveGivesCheck(move);
        captures = board.capturedValue(move) > 0;
        board = board.applyUci(move);
      } catch {
        break;
      }
      total += 1;
      if (givesCheck || captures) {
        forcing += 1;
      }
    }
    return total ? forcing / total : 0.0;
  }
}

function parseFenCounter(field: string): number {
  if (!/^-?\d+$/.test(field)) {
    throw new Error("invalid FEN counter");
  }
  return Number(field);
}

/**
 * Reconstruct a board from `position startpos|fen ... [moves ...]`.
 *
 * Returns null for unsupported/malformed history. No move legality is checked.
 */
export function boardFromPositionCommand(command: string): Board | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] !== "position") {
    return null;
  }
  try {
    let board: Board;
    let moveIndex: number;
    if (tokens.length >= 2 && tokens[1] === "startpos") {
      board = Board.fromFen(STARTPOS_FEN);
      moveIndex = 2;
    } else if (tokens.length >= 8 && tokens[1] === "fen") {
      board = Board.fromFen(tokens.slice(2, 8).join(" "));
      moveIndex = 8;
    } else {
      return null;
    }
    if (moveIndex < tokens.length) {
      if (tokens[moveIndex] !== "moves") {
        return null;
      }
      for (const move of tokens.slice(moveIndex + 1)) {
        board = board.applyUci(move);
      }
    }
    return board;
  } catch {
    return null;
  }
}

/** Static evidence for posture inference, from the side to move's view. */
export function positionStats(board: Board | null): PositionStats {
  if (board === null) {
    return {
      tension: 0.0,
      ownKingAttackers: 0.0,
      ownKingDefenders: 0.0,
      enemyKingAttackers: 0.0,
      enemyKingDefenders: 0.0,
      phase: 0.0,
      materialBalance: 0.0,
    };
  }
  const white = board.turn === "w";
  const [ownDefenders, ownAttackers] = board.kingMargin(white);
  const [enemyDefenders, enemyAttackers] = board.kingMargin(!white);
  const balance = board.materialBalance();
  return {
    tension: board.tensionCount(),
    ownKingAttackers: ownAttackers,
    ownKingDefenders: ownDefenders,
    enemyKingAttackers: enemyAttackers,
    enemyKingDefenders: enemyDefenders,
    phase: board.phase(),
    materialBalance: white ? balance : -balance,
  };
}

/**
 * Return the nine personality features for one Stockfish candidate.
 *
 * Cheap features are static proxies, not a full SEE/legal-move model. F_N and
 * F_P are probe features: they stay neutral until the caller supplies measured
 * child-search values in `probes`; they are never inferred from a static rule.
 */
export function candidateFeatures(
  board: Board | null,
  move: string,
  probes: Partial<Record<"F_N" | "F_P", number>> = {},
): Features {
  const zero: Features = {
    T: 0,
    F_T: 0.0,
    F_N: 0.0,
    F_R: 0.0,
    F_C: 0.0,
    F_F: 0.0,
    F_P: 0.0,
    F_K: 0.0,
    F_S: 0.0,
    F_I: 0.0,
  };
  if (board === null) {
    return zero;
  }
  let tBefore: number;
  let captured: number;
  let material: number;
  let tAfter: number;
  let givesCheck: boolean;
  let threatensQueen: boolean;
  let reserve: number;
  let mutual: number;
  let kingAttacks: number;
  let batteries: number;
  let mobility: number;
  let breaks: number;
  let defenders: number;
  let attackers: number;
  try {
    tBefore = board.tensionCount();
    captured = board.capturedValue(move);
    material = board.materialDelta(move);
    const after = board.applyUci(move);
    tAfter = after.tensionCount();
    const white = board.turn === "w";
    const enemyKing = white ? "k" : "K";
    givesCheck = after.kingAttacked(enemyKing);
    threatensQueen = board.moveThreatensEnemyQueen(move);
    reserve = after.reserveCount(white);
    [mutual, kingAttacks, batteries] = after.coordination(white);
    mobility = after.safeMobility(white);
    breaks = after.pawnBreaks(white);
    [defenders, attackers] = after.kingMargin(white);
  } catch {
    return zero;
  }
  const forcing = givesCheck || captured === PIECE_VALUE["q"] || threatensQueen;
  return {
    T: tBefore,
    F_T: clamp((tAfter - tBefore) / 4.0, -1.0, 1.0),
    F_N: clamp(probes.F_N ?? 0.0, -1.0, 1.0),
    F_R: clamp(reserve / 4.0, 0.0, 1.0),
    F_C: clamp((mutual + kingAttacks + 2 * batteries) / 10.0, 0.0, 1.0),
    F_F: clamp((mobility + 3 * breaks) / 20.0, 0.0, 1.0),
    F_P: clamp(probes.F_P ?? 0.0, -1.0, 1.0),
    F_K: clamp((defenders - attackers) / 8.0, -1.0, 1.0),
    F_S: clamp(material / 9.0, -1.0, 1.0),
    F_I: clamp(forcing ? 1.0 : 0.25 * kingAttacks, 0.0, 1.0),
  };
}

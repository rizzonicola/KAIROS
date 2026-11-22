"""Small, non-generating chess position reader for KAIROS' first features.

This module never generates or validates legal moves. It only applies moves
provided by the UCI engine / GUI to a FEN position. Stockfish remains the sole
source of legal candidate moves and tactical verification.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Optional

STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
MOVE_RE = re.compile(r"^([a-h][1-8])([a-h][1-8])([qrbn])?$")
PIECE_VALUE = {"p": 1, "n": 3, "b": 3, "r": 5, "q": 9, "k": 0}


def _square_to_index(square: str) -> int:
    return (int(square[1]) - 1) * 8 + (ord(square[0]) - ord("a"))


def _index_to_square(index: int) -> str:
    return f"{chr(ord('a') + index % 8)}{index // 8 + 1}"


def _slider_on_ray(piece: str, df: int, dr: int) -> bool:
    kind = piece.lower()
    if df == 0 or dr == 0:
        return kind in ("r", "q")
    return kind in ("b", "q")


@dataclass(frozen=True)
class Board:
    squares: tuple[Optional[str], ...]  # a1=0, h8=63
    turn: str
    castling: str
    ep_square: Optional[int]
    halfmove: int = 0
    fullmove: int = 1

    @classmethod
    def from_fen(cls, fen: str) -> "Board":
        fields = fen.strip().split()
        if len(fields) != 6:
            raise ValueError("FEN must contain six fields")
        placement, turn, castling, ep, halfmove, fullmove = fields
        if turn not in ("w", "b"):
            raise ValueError("invalid FEN active color")
        ranks = placement.split("/")
        if len(ranks) != 8:
            raise ValueError("invalid FEN board")
        squares: list[Optional[str]] = [None] * 64
        for fen_rank, row in enumerate(ranks):
            file_index = 0
            rank_index = 7 - fen_rank
            for char in row:
                if char.isdigit():
                    file_index += int(char)
                elif char in "PNBRQKpnbrqk":
                    if file_index >= 8:
                        raise ValueError("invalid FEN rank width")
                    squares[rank_index * 8 + file_index] = char
                    file_index += 1
                else:
                    raise ValueError("invalid FEN piece")
            if file_index != 8:
                raise ValueError("invalid FEN rank width")
        ep_square = None if ep == "-" else _square_to_index(ep)
        return cls(tuple(squares), turn, castling, ep_square, int(halfmove), int(fullmove))

    def to_fen(self) -> str:
        rows = []
        for rank in range(7, -1, -1):
            row = ""
            empty = 0
            for file_index in range(8):
                piece = self.squares[rank * 8 + file_index]
                if piece is None:
                    empty += 1
                else:
                    if empty:
                        row += str(empty)
                        empty = 0
                    row += piece
            if empty:
                row += str(empty)
            rows.append(row)
        castling = self.castling or "-"
        ep = "-" if self.ep_square is None else _index_to_square(self.ep_square)
        return f"{'/'.join(rows)} {self.turn} {castling} {ep} {self.halfmove} {self.fullmove}"

    def apply_uci(self, move: str) -> "Board":
        """Apply a syntactically valid move already supplied as legal by a UCI peer."""
        match = MOVE_RE.fullmatch(move)
        if not match:
            raise ValueError(f"unsupported UCI move: {move}")
        from_sq, to_sq, promotion = match.groups()
        source = _square_to_index(from_sq)
        target = _square_to_index(to_sq)
        piece = self.squares[source]
        if piece is None:
            raise ValueError(f"no piece on {from_sq}")
        if (piece.isupper() and self.turn != "w") or (piece.islower() and self.turn != "b"):
            raise ValueError(f"wrong side to move for {move}")

        board = list(self.squares)
        captured = board[target]
        is_pawn = piece.lower() == "p"
        from_file, from_rank = source % 8, source // 8
        to_file, to_rank = target % 8, target // 8

        # En passant: a pawn moves diagonally to the FEN en-passant target.
        if is_pawn and from_file != to_file and captured is None and self.ep_square == target:
            captured_square = target - 8 if self.turn == "w" else target + 8
            captured = board[captured_square]
            board[captured_square] = None

        board[source] = None
        if promotion:
            if not is_pawn or to_rank not in (0, 7):
                raise ValueError(f"invalid promotion move: {move}")
            placed = promotion.upper() if self.turn == "w" else promotion
        else:
            placed = piece
        board[target] = placed

        # Castling rook movement. The king move itself is trusted to Stockfish.
        if piece.lower() == "k" and abs(to_file - from_file) == 2:
            if to_file == 6:  # O-O
                rook_from, rook_to = (from_rank * 8 + 7, from_rank * 8 + 5)
            else:  # O-O-O
                rook_from, rook_to = (from_rank * 8, from_rank * 8 + 3)
            board[rook_to] = board[rook_from]
            board[rook_from] = None

        rights = set(self.castling.replace("-", ""))
        if piece.lower() == "k":
            rights.discard("K" if self.turn == "w" else "k")
            rights.discard("Q" if self.turn == "w" else "q")
        rook_rights = {"a1": "Q", "h1": "K", "a8": "q", "h8": "k"}
        if from_sq in rook_rights:
            rights.discard(rook_rights[from_sq])
        if to_sq in rook_rights and captured is not None:
            rights.discard(rook_rights[to_sq])
        ordered_rights = "".join(ch for ch in "KQkq" if ch in rights) or "-"

        ep_square = None
        if is_pawn and abs(to_rank - from_rank) == 2:
            ep_square = (source + target) // 2
        next_turn = "b" if self.turn == "w" else "w"
        halfmove = 0 if is_pawn or captured is not None else self.halfmove + 1
        fullmove = self.fullmove + (1 if self.turn == "b" else 0)
        return Board(tuple(board), next_turn, ordered_rights, ep_square, halfmove, fullmove)

    def pawn_lever_count(self) -> int:
        """Count opposing pawn pairs that currently attack one another."""
        white = [i for i, p in enumerate(self.squares) if p == "P"]
        black = [i for i, p in enumerate(self.squares) if p == "p"]
        count = 0
        for w in white:
            wf, wr = w % 8, w // 8
            for b in black:
                bf, br = b % 8, b // 8
                if br == wr + 1 and abs(bf - wf) == 1:
                    count += 1
        return count

    def pin_count(self) -> int:
        """Count absolute pins: one own piece shielding its king from an enemy slider.

        This is exact geometry for the current position, not full pin/x-ray
        analysis of future lines.
        """
        count = 0
        for king, king_is_white in (("K", True), ("k", False)):
            try:
                king_square = self.squares.index(king)
            except ValueError:
                continue
            kf, kr = king_square % 8, king_square // 8
            for df, dr in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                file_pos, rank_pos = kf + df, kr + dr
                pinned_square: Optional[int] = None
                while 0 <= file_pos < 8 and 0 <= rank_pos < 8:
                    square = rank_pos * 8 + file_pos
                    piece = self.squares[square]
                    if piece is not None:
                        if pinned_square is None:
                            if piece.isupper() != king_is_white:
                                break  # enemy piece on the ray: attacker, not a pin
                            pinned_square = square
                        else:
                            if piece.isupper() != king_is_white and _slider_on_ray(piece, df, dr):
                                count += 1
                            break
                    file_pos += df
                    rank_pos += dr
        return count

    def tension_count(self) -> int:
        """Tension Index proxy: mutually attacking pawn pairs plus absolute pins."""
        return self.pawn_lever_count() + self.pin_count()

    def captured_value(self, move: str) -> int:
        match = MOVE_RE.fullmatch(move)
        if not match:
            return 0
        from_sq, to_sq, _ = match.groups()
        source, target = _square_to_index(from_sq), _square_to_index(to_sq)
        piece = self.squares[source]
        victim = self.squares[target]
        if piece is None:
            return 0
        if piece.lower() == "p" and source % 8 != target % 8 and victim is None and self.ep_square == target:
            victim_square = target - 8 if self.turn == "w" else target + 8
            victim = self.squares[victim_square]
        return PIECE_VALUE.get(victim.lower(), 0) if victim else 0

    def material_delta(self, move: str) -> int:
        """Net material change for the mover: captured value minus promotion gain."""
        match = MOVE_RE.fullmatch(move)
        if not match:
            return 0
        promotion = match.group(3)
        promotion_gain = PIECE_VALUE[promotion] - PIECE_VALUE["p"] if promotion else 0
        return self.captured_value(move) - promotion_gain

    def move_gives_check(self, move: str) -> bool:
        after = self.apply_uci(move)
        enemy_king = "k" if self.turn == "w" else "K"
        return after._king_attacked(enemy_king)

    def move_threatens_enemy_queen(self, move: str) -> bool:
        """True when the moved piece attacks the enemy queen from its destination."""
        match = MOVE_RE.fullmatch(move)
        if not match:
            return False
        after = self.apply_uci(move)
        enemy_queen = "q" if self.turn == "w" else "Q"
        try:
            queen_square = after.squares.index(enemy_queen)
        except ValueError:
            return False
        return after._attacks_square(_square_to_index(match.group(2)), queen_square)

    def _king_attacked(self, king: str) -> bool:
        try:
            king_square = self.squares.index(king)
        except ValueError:
            return False
        king_is_white = king == "K"
        return any(
            piece is not None
            and piece.isupper() != king_is_white
            and self._attacks_square(index, king_square)
            for index, piece in enumerate(self.squares)
        )

    def _attacks_square(self, source: int, target: int) -> bool:
        piece = self.squares[source]
        if piece is None or source == target:
            return False
        sf, sr = source % 8, source // 8
        tf, tr = target % 8, target // 8
        df, dr = tf - sf, tr - sr
        kind = piece.lower()
        if kind == "p":
            direction = 1 if piece.isupper() else -1
            return dr == direction and abs(df) == 1
        if kind == "n":
            return (abs(df), abs(dr)) in ((1, 2), (2, 1))
        if kind == "k":
            return max(abs(df), abs(dr)) == 1

        if kind == "b" and abs(df) != abs(dr):
            return False
        if kind == "r" and not (df == 0 or dr == 0):
            return False
        if kind == "q" and not (df == 0 or dr == 0 or abs(df) == abs(dr)):
            return False
        if kind not in ("b", "r", "q"):
            return False
        step_f = (df > 0) - (df < 0)
        step_r = (dr > 0) - (dr < 0)
        file_pos, rank_pos = sf + step_f, sr + step_r
        while (file_pos, rank_pos) != (tf, tr):
            if self.squares[rank_pos * 8 + file_pos] is not None:
                return False
            file_pos += step_f
            rank_pos += step_r
        return True


def board_from_position_command(command: str) -> Optional[Board]:
    """Reconstruct a board from `position startpos|fen ... [moves ...]`.

    Returns None for unsupported/malformed history. No move legality is checked.
    """
    tokens = command.strip().split()
    if not tokens or tokens[0] != "position":
        return None
    try:
        if len(tokens) >= 2 and tokens[1] == "startpos":
            board = Board.from_fen(STARTPOS_FEN)
            move_index = 2
        elif len(tokens) >= 8 and tokens[1] == "fen":
            board = Board.from_fen(" ".join(tokens[2:8]))
            move_index = 8
        else:
            return None
        if move_index < len(tokens):
            if tokens[move_index] != "moves":
                return None
            for move in tokens[move_index + 1:]:
                board = board.apply_uci(move)
        return board
    except (ValueError, IndexError):
        return None


def candidate_features(board: Optional[Board], move: str) -> dict[str, float | int]:
    """Return the implemented subset of T/S/I features for one SF candidate.

    F_T is the change in a Tension Index proxy: directly mutually attacking
    pawn pairs plus absolute pins. It is not the full Tension Index (no
    near-zero SEE captures, x-rays or key files). F_S is net captured material
    minus promotion gain, not a full exchange/SEE sequence. F_I is 1 for a
    check, a queen capture, or a direct attack on the enemy queen; broader
    threats remain unimplemented.
    """
    # TODO(KAIROS roadmap): add near-zero-SEE captures, x-rays, key-file
    # tension, reserve, reply narrowness and release-value probes only when
    # they can be measured reliably; do not infer them from approximate rules.
    if board is None:
        return {"T": 0, "F_T": 0.0, "F_S": 0.0, "F_I": 0.0}
    try:
        t_before = board.tension_count()
        captured = board.captured_value(move)
        material = board.material_delta(move)
        after = board.apply_uci(move)
        t_after = after.tension_count()
        enemy_king = "k" if board.turn == "w" else "K"
        gives_check = after._king_attacked(enemy_king)
        threatens_queen = board.move_threatens_enemy_queen(move)
    except ValueError:
        return {"T": t_before if "t_before" in locals() else 0, "F_T": 0.0, "F_S": 0.0, "F_I": 0.0}
    delta = t_after - t_before
    forcing = gives_check or captured == PIECE_VALUE["q"] or threatens_queen
    return {
        "T": t_before,
        "F_T": max(-1.0, min(1.0, delta / 4.0)),
        "F_S": max(-1.0, min(1.0, material / 9.0)),
        "F_I": 1.0 if forcing else 0.0,
    }

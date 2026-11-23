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
DIRECTIONS = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


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

    def resets_halfmove(self, move: str) -> bool:
        """True when the move is a pawn move or capture (50-move reset)."""
        return self.apply_uci(move).halfmove == 0

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


    def king_square(self, white: bool) -> Optional[int]:
        try:
            return self.squares.index("K" if white else "k")
        except ValueError:
            return None

    def king_zone(self, white: bool) -> set[int]:
        king = self.king_square(white)
        if king is None:
            return set()
        file_index, rank_index = king % 8, king // 8
        return {
            rank * 8 + file
            for rank in range(max(0, rank_index - 1), min(7, rank_index + 1) + 1)
            for file in range(max(0, file_index - 1), min(7, file_index + 1) + 1)
        }

    def is_attacked_by_pawn(self, target: int, by_white: bool) -> bool:
        return any(
            piece == ("P" if by_white else "p") and self._attacks_square(source, target)
            for source, piece in enumerate(self.squares)
        )

    def pseudo_moves(self, source: int) -> list[int]:
        """Pseudo-legal destinations for a piece. Not a legality claim.

        Castling and en-passant capture beyond the FEN target are omitted.
        """
        piece = self.squares[source]
        if piece is None:
            return []
        white = piece.isupper()
        kind = piece.lower()
        file_index, rank_index = source % 8, source // 8
        targets: list[int] = []
        if kind == "p":
            direction = 1 if white else -1
            one_rank = rank_index + direction
            if not (0 <= one_rank < 8):
                return []
            one = one_rank * 8 + file_index
            if self.squares[one] is None:
                targets.append(one)
                start_rank = 1 if white else 6
                two_rank = rank_index + 2 * direction
                if rank_index == start_rank and self.squares[two_rank * 8 + file_index] is None:
                    targets.append(two_rank * 8 + file_index)
            for df in (-1, 1):
                nf = file_index + df
                if 0 <= nf < 8:
                    target = one_rank * 8 + nf
                    victim = self.squares[target]
                    if victim is not None and victim.isupper() != white:
                        targets.append(target)
                    elif victim is None and self.ep_square == target:
                        targets.append(target)
            return targets
        for target, victim in enumerate(self.squares):
            if target == source:
                continue
            if victim is not None and victim.isupper() == white:
                continue
            if self._attacks_square(source, target):
                targets.append(target)
        return targets

    def safe_mobility(self, white: bool) -> int:
        """Non-king pseudo-legal moves whose destination is not attacked by a pawn."""
        return sum(
            1
            for source, piece in enumerate(self.squares)
            if piece is not None and piece.isupper() == white and piece.lower() != "k"
            for target in self.pseudo_moves(source)
            if not self.is_attacked_by_pawn(target, not white)
        )

    def pawn_breaks(self, white: bool) -> int:
        """Pawn pushes that would create a new lever on an enemy pawn."""
        breaks = 0
        for source, piece in enumerate(self.squares):
            if piece != ("P" if white else "p"):
                continue
            file_index, rank_index = source % 8, source // 8
            direction = 1 if white else -1
            for steps in (1, 2):
                if steps == 2 and rank_index != (1 if white else 6):
                    continue
                target_rank = rank_index + steps * direction
                if not (0 <= target_rank < 8):
                    continue
                target = target_rank * 8 + file_index
                if self.squares[target] is not None:
                    break
                attack_rank = target_rank + direction
                if 0 <= attack_rank < 8 and any(
                    0 <= file_index + df < 8
                    and self.squares[attack_rank * 8 + file_index + df] == ("p" if white else "P")
                    for df in (-1, 1)
                ):
                    breaks += 1
        return breaks

    def reserve_count(self, white: bool) -> int:
        """Non-pawn pieces not committed to an enemy pawn and with two safe squares."""
        reserve = 0
        for source, piece in enumerate(self.squares):
            if piece is None or piece.isupper() != white or piece.lower() in ("p", "k"):
                continue
            if self.is_attacked_by_pawn(source, not white):
                continue
            safe = [
                target
                for target in self.pseudo_moves(source)
                if not self.is_attacked_by_pawn(target, not white)
            ]
            if len(safe) >= 2:
                reserve += 1
        return reserve

    def coordination(self, white: bool) -> tuple[int, int, int]:
        """Return (mutually protected pieces, enemy-king-zone attackers, batteries)."""
        mutual = 0
        for source, piece in enumerate(self.squares):
            if piece is None or piece.isupper() != white:
                continue
            if any(
                other != source
                and other_piece is not None
                and other_piece.isupper() == white
                and self._attacks_square(other, source)
                for other, other_piece in enumerate(self.squares)
            ):
                mutual += 1
        enemy_zone = self.king_zone(not white)
        king_attacks = sum(
            1
            for source, piece in enumerate(self.squares)
            if piece is not None
            and piece.isupper() == white
            and any(self._attacks_square(source, target) for target in enemy_zone)
        )
        batteries = 0
        for source, piece in enumerate(self.squares):
            if piece is None or piece.isupper() != white:
                continue
            kind = piece.lower()
            if kind not in ("q", "r", "b"):
                continue
            for df, dr in DIRECTIONS:
                if kind == "r" and not (df == 0 or dr == 0):
                    continue
                if kind == "b" and not (df != 0 and dr != 0):
                    continue
                file_index, rank_index = source % 8 + df, source // 8 + dr
                own_seen = False
                while 0 <= file_index < 8 and 0 <= rank_index < 8:
                    other = self.squares[rank_index * 8 + file_index]
                    if other is not None:
                        if not own_seen:
                            if other.isupper() != white:
                                break
                            own_seen = True
                        else:
                            if other.isupper() != white:
                                batteries += 1
                            break
                    file_index += df
                    rank_index += dr
        return mutual, king_attacks, batteries

    def king_margin(self, white: bool) -> tuple[int, int]:
        """Return (defenders, attackers) of the given side's 3x3 king zone."""
        zone = self.king_zone(white)
        if not zone:
            return 0, 0
        defenders: set[int] = set()
        attackers: set[int] = set()
        for source, piece in enumerate(self.squares):
            if piece is None:
                continue
            if any(self._attacks_square(source, target) for target in zone):
                if piece.isupper() == white:
                    defenders.add(source)
                else:
                    attackers.add(source)
        return len(defenders), len(attackers)

    def material_balance(self) -> int:
        total = 0
        for piece in self.squares:
            if piece is not None:
                value = PIECE_VALUE[piece.lower()]
                total += value if piece.isupper() else -value
        return total

    def phase(self) -> float:
        non_pawn = sum(
            PIECE_VALUE[piece.lower()]
            for piece in self.squares
            if piece is not None and piece.lower() not in ("p", "k")
        )
        return clamp(non_pawn / 62.0, 0.0, 1.0)

    def position_key(self) -> str:
        return " ".join(self.to_fen().split()[:4])

    def null_move_fen(self) -> Optional[str]:
        """FEN with the side to move flipped. None when that position is illegal."""
        own_king = "K" if self.turn == "w" else "k"
        if self._king_attacked(own_king):
            return None
        fields = self.to_fen().split()
        fields[1] = "b" if self.turn == "w" else "w"
        fields[3] = "-"
        return " ".join(fields)

    def forcing_density(self, moves: list[str]) -> float:
        """Share of checks/captures among the first six PV moves."""
        board = self
        forcing = 0
        total = 0
        for move in moves[:6]:
            try:
                gives_check = board.move_gives_check(move)
                captures = board.captured_value(move) > 0
                board = board.apply_uci(move)
            except ValueError:
                break
            total += 1
            if gives_check or captures:
                forcing += 1
        return forcing / total if total else 0.0


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


def position_stats(board: Optional[Board]) -> dict[str, float]:
    """Static evidence for posture inference, from the side to move's view."""
    if board is None:
        return {
            "tension": 0.0,
            "own_king_attackers": 0.0,
            "own_king_defenders": 0.0,
            "enemy_king_attackers": 0.0,
            "enemy_king_defenders": 0.0,
            "phase": 0.0,
            "material_balance": 0.0,
        }
    white = board.turn == "w"
    own_defenders, own_attackers = board.king_margin(white)
    enemy_defenders, enemy_attackers = board.king_margin(not white)
    balance = board.material_balance()
    return {
        "tension": float(board.tension_count()),
        "own_king_attackers": float(own_attackers),
        "own_king_defenders": float(own_defenders),
        "enemy_king_attackers": float(enemy_attackers),
        "enemy_king_defenders": float(enemy_defenders),
        "phase": board.phase(),
        "material_balance": float(balance if white else -balance),
    }


def candidate_features(
    board: Optional[Board], move: str, probes: Optional[dict[str, float]] = None
) -> dict[str, float | int]:
    """Return the nine personality features for one Stockfish candidate.

    Cheap features are static proxies, not a full SEE/legal-move model:

    - F_T: change in the Tension Index proxy (pawn levers + absolute pins).
    - F_R: non-pawn pieces with at least two safe pseudo-legal destinations.
    - F_C: mutual protection, enemy-king-zone attackers and batteries.
    - F_F: safe mobility plus pawn breaks that would create a lever.
    - F_K: own king-zone defenders minus attackers.
    - F_S: net captured material minus promotion gain.
    - F_I: check/queen capture/queen attack, or enemy king-zone pressure.

    F_N and F_P are probe features. They stay neutral until the caller supplies
    measured child-search values in ``probes``; they are never inferred from an
    approximate static rule.
    """
    probes = probes or {}
    zero = {
        "T": 0,
        "F_T": 0.0,
        "F_N": 0.0,
        "F_R": 0.0,
        "F_C": 0.0,
        "F_F": 0.0,
        "F_P": 0.0,
        "F_K": 0.0,
        "F_S": 0.0,
        "F_I": 0.0,
    }
    if board is None:
        return zero
    try:
        t_before = board.tension_count()
        captured = board.captured_value(move)
        material = board.material_delta(move)
        after = board.apply_uci(move)
        t_after = after.tension_count()
        white = board.turn == "w"
        enemy_king = "k" if white else "K"
        gives_check = after._king_attacked(enemy_king)
        threatens_queen = board.move_threatens_enemy_queen(move)
        reserve = after.reserve_count(white)
        mutual, king_attacks, batteries = after.coordination(white)
        mobility = after.safe_mobility(white)
        breaks = after.pawn_breaks(white)
        defenders, attackers = after.king_margin(white)
    except ValueError:
        return zero
    forcing = gives_check or captured == PIECE_VALUE["q"] or threatens_queen
    return {
        "T": t_before,
        "F_T": clamp((t_after - t_before) / 4.0, -1.0, 1.0),
        "F_N": clamp(float(probes.get("F_N", 0.0)), -1.0, 1.0),
        "F_R": clamp(reserve / 4.0, 0.0, 1.0),
        "F_C": clamp((mutual + king_attacks + 2 * batteries) / 10.0, 0.0, 1.0),
        "F_F": clamp((mobility + 3 * breaks) / 20.0, 0.0, 1.0),
        "F_P": clamp(float(probes.get("F_P", 0.0)), -1.0, 1.0),
        "F_K": clamp((defenders - attackers) / 8.0, -1.0, 1.0),
        "F_S": clamp(material / 9.0, -1.0, 1.0),
        "F_I": clamp(1.0 if forcing else 0.25 * king_attacks, 0.0, 1.0),
    }

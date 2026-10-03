from dataclasses import asdict, dataclass
from typing import Literal

from .protocol import GameError

Color = Literal["BLACK", "WHITE"]
SIZE = 15


def opposite(color: Color) -> Color:
    return "WHITE" if color == "BLACK" else "BLACK"


@dataclass(frozen=True)
class Stone:
    row: int
    col: int
    color: Color

    def wire(self) -> dict:
        return asdict(self)


def turn(moves: list[Stone]) -> Color:
    return "BLACK" if len(moves) % 2 == 0 else "WHITE"


def place(moves: list[Stone], row: int, col: int) -> tuple[Stone, dict | None]:
    """Validate without mutation. The move log is the sole board authority."""
    if type(row) is not int or type(col) is not int or not (0 <= row < SIZE and 0 <= col < SIZE):
        raise GameError("INVALID_MESSAGE", "Coordinates must be integers from 0 to 14")
    board = {(move.row, move.col): move.color for move in moves}
    if (row, col) in board:
        raise GameError("CELL_OCCUPIED", "This intersection is occupied")
    stone = Stone(row, col, turn(moves))
    board[row, col] = stone.color
    for dr, dc in [(0, 1), (1, 0), (1, 1), (1, -1)]:
        halves = []
        for sign in (-1, 1):
            cells = []
            r, c = row + dr * sign, col + dc * sign
            while board.get((r, c)) == stone.color:
                cells.append({"row": r, "col": c})
                r, c = r + dr * sign, c + dc * sign
            halves.append(cells)
        line = list(reversed(halves[0])) + [{"row": row, "col": col}] + halves[1]
        if len(line) >= 5:
            return stone, {"winner": stone.color, "reason": "FIVE_IN_ROW", "winningLine": line}
    if len(moves) + 1 == SIZE * SIZE:
        return stone, {"winner": None, "reason": "DRAW", "winningLine": []}
    return stone, None


def undo_target(moves: list[Stone], color: Color) -> int:
    for index in range(len(moves) - 1, -1, -1):
        if moves[index].color == color:
            return index
    raise GameError("UNDO_UNAVAILABLE", "You have not placed a stone")

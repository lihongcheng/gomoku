import pytest
from pydantic import ValidationError

from gomoku.protocol import CreateRoom, GameError, Join, command_adapter
from gomoku.rules import Stone, place, turn, undo_target


@pytest.mark.parametrize("dr,dc", [(0, 1), (1, 0), (1, 1), (1, -1)])
@pytest.mark.parametrize("length", [5, 6, 7])
def test_winning_directions_and_overlines(dr, dc, length):
    # Complete a gap: longer lines must count as a win in free-style Gomoku.
    cells = [(2 + dr * i, 10 + dc * i) for i in range(length)]
    if dc == 1:
        cells = [(r, c - 8) for r, c in cells]
    target = cells.pop(2)
    moves = [Stone(r, c, "BLACK") for r, c in cells]
    # Rule turn is determined by parity, independent of cached board state.
    if len(moves) % 2:
        moves.append(Stone(14, 0, "WHITE"))
    _, result = place(moves, *target)
    assert result["winner"] == "BLACK"
    assert len(result["winningLine"]) == length


def test_real_full_board_draw():
    colors = {"BLACK": [], "WHITE": []}
    for row in range(15):
        for col in range(15):
            color = "BLACK" if (row + 2 * col) % 4 < 2 else "WHITE"
            colors[color].append((row, col))
    assert [len(colors[c]) for c in ["BLACK", "WHITE"]] == [113, 112]
    moves = []
    while len(moves) < 225:
        color = turn(moves)
        stone, result = place(moves, *colors[color].pop())
        moves.append(stone)
        assert result == (
            {"winner": None, "reason": "DRAW", "winningLine": []} if len(moves) == 225 else None
        )


@pytest.mark.parametrize("value", [True, False, "7", 7.0, -1, 15, None])
def test_coordinate_schema_is_strict(value):
    with pytest.raises(ValidationError):
        command_adapter.validate_python(
            {
                "type": "move.play",
                "requestId": "one",
                "expectedRevision": 1,
                "payload": {"row": value, "col": 7},
            }
        )
    with pytest.raises(GameError, match="Coordinates"):
        place([], value, 7)


def test_occupied_and_undo_log():
    moves = [Stone(7, 7, "BLACK"), Stone(7, 8, "WHITE"), Stone(8, 8, "BLACK")]
    with pytest.raises(GameError) as error:
        place(moves, 7, 7)
    assert error.value.code == "CELL_OCCUPIED"
    assert undo_target(moves, "BLACK") == 2
    assert undo_target(moves, "WHITE") == 1
    with pytest.raises(GameError):
        undo_target([], "WHITE")


def test_reject_forged_color_and_boolean_revision():
    command = {
        "type": "move.play",
        "requestId": "one",
        "expectedRevision": True,
        "payload": {"row": 7, "col": 7},
    }
    with pytest.raises(ValidationError):
        command_adapter.validate_python(command)
    command["expectedRevision"] = 1
    command["payload"]["color"] = "WHITE"
    with pytest.raises(ValidationError):
        command_adapter.validate_python(command)


@pytest.mark.parametrize("nickname", [" leading", "trailing ", "\n", "a\u0000b", "\ud800"])
def test_reject_unserializable_or_control_nicknames(nickname):
    with pytest.raises(ValidationError):
        CreateRoom(nickname=nickname)


def test_session_token_must_be_url_safe_ascii():
    with pytest.raises(ValidationError):
        Join(
            type="room.join",
            protocolVersion=1,
            roomId="ABCDEFGH",
            sessionToken="\ud800" * 32,
            nickname="玩家",
        )

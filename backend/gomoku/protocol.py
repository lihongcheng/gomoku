from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    TypeAdapter,
)

PROTOCOL_VERSION = 1


def safe_nickname(value: str) -> str:
    if value != value.strip() or any(
        ord(char) < 32 or 127 <= ord(char) <= 159 or 0xD800 <= ord(char) <= 0xDFFF for char in value
    ):
        raise ValueError("Nickname cannot contain controls, invalid Unicode or outer whitespace")
    return value


Nickname = Annotated[str, Field(min_length=1, max_length=20), AfterValidator(safe_nickname)]
RequestId = Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")]
Token = Annotated[str, Field(min_length=16, max_length=256, pattern=r"^[a-zA-Z0-9_-]+$")]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CreateRoom(Model):
    nickname: Nickname


class Join(Model):
    type: Literal["room.join"]
    protocolVersion: StrictInt
    roomId: Annotated[str, Field(min_length=6, max_length=12, pattern=r"^[A-Z0-9]+$")]
    sessionToken: Token
    inviteToken: Token | None = None
    nickname: Nickname


class Control(Model):
    type: Literal["heartbeat", "room.sync"]


class Empty(Model):
    pass


class ReadyPayload(Model):
    ready: StrictBool


class MovePayload(Model):
    row: Annotated[StrictInt, Field(ge=0, lt=15)]
    col: Annotated[StrictInt, Field(ge=0, lt=15)]


class UndoResponse(Model):
    undoId: RequestId
    accept: StrictBool


class Command(Model):
    requestId: RequestId
    expectedRevision: Annotated[StrictInt, Field(ge=0)]


class Ready(Command):
    type: Literal["game.ready"]
    payload: ReadyPayload


class Move(Command):
    type: Literal["move.play"]
    payload: MovePayload


class Respond(Command):
    type: Literal["undo.respond"]
    payload: UndoResponse


class Simple(Command):
    type: Literal["undo.request", "game.resign", "room.leave", "room.close"]
    payload: Empty = Field(default_factory=Empty)


Incoming = Annotated[Control | Ready | Move | Respond | Simple, Field(discriminator="type")]
command_adapter = TypeAdapter(Incoming)


class GameError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code = code
        self.message = message
        self.status = status
        super().__init__(message)

    def wire(self, request_id: str | None = None) -> dict:
        return {
            "type": "error",
            "code": self.code,
            "message": self.message,
            "requestId": request_id,
        }

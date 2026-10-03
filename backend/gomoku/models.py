import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Literal

from .rules import Color, Stone
from .transport import Peer


@dataclass
class CreateRecord:
    fingerprint: str
    response: dict


@dataclass
class Session:
    member_id: str
    expires_at: float
    creates: dict[str, CreateRecord] = field(default_factory=dict)


@dataclass
class Receipt:
    fingerprint: str
    message: dict
    expires_at: float


@dataclass
class Member:
    member_id: str
    nickname: str
    role: Literal["PLAYER", "SPECTATOR"]
    color: Color | None
    ready: bool = False
    generation: int = 0
    offline_at: float | None = None
    reconnect_at: float | None = None
    last_undo_at: float = float("-inf")
    rejected_board: int | None = None
    receipts: OrderedDict[str, Receipt] = field(default_factory=OrderedDict)


@dataclass
class Undo:
    undo_id: str
    member_id: str
    revision: int
    target_length: int
    expires_at: float


@dataclass
class Room:
    room_id: str
    owner_id: str
    invite_digest: str
    watch_digest: str
    created_at: float
    members: dict[str, Member]
    phase: str = "WAITING"
    revision: int = 1
    seq: int = 1
    board_revision: int = 0
    moves: list[Stone] = field(default_factory=list)
    pending_undo: Undo | None = None
    result: dict | None = None
    close_reason: str | None = None
    last_activity: float | None = None
    finished_at: float | None = None
    empty_since: float | None = None
    connections: dict[str, Peer] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def players(self) -> list[Member]:
        return sorted(
            (m for m in self.members.values() if m.role == "PLAYER"),
            key=lambda m: m.color != "BLACK",
        )

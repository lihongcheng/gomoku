import secrets

import pytest

from gomoku.config import Clock, Settings
from gomoku.protocol import CreateRoom, Join, command_adapter
from gomoku.service import Service


class FakeClock(Clock):
    def __init__(self):
        self.value = 1000.0

    def now(self):
        return self.value


class MemoryPeer:
    def __init__(self):
        self.member_id = ""
        self.generation = 0
        self.last_seen = 0.0
        self.closing = False
        self.messages = []
        self.close_reason = None

    def emit(self, message):
        if self.closing:
            return False
        # Mimic serialization so future room mutations cannot change sent state.
        import copy

        self.messages.append(copy.deepcopy(message))
        return True

    def stop(self, code, reason, *, discard=False):
        self.closing = True
        self.close_reason = reason


class Harness:
    def __init__(self, settings=None):
        self.clock = FakeClock()
        self.service = Service(settings or Settings(_env_file=None), self.clock)
        self.room = None
        self.created = None
        self.identities = []
        self.peers = []

    def identity(self):
        identity = self.service.new_session()
        self.identities.append(identity)
        return identity

    async def create(self):
        identity = self.identity()
        self.created = await self.service.create(
            self.service.authenticate(identity["sessionToken"]),
            "create-1",
            CreateRoom(nickname="黑方"),
        )
        self.room = self.service.rooms[self.created["roomId"]]
        return await self.join(identity)

    async def join(self, identity=None, *, watch=False, peer=None, token=None):
        identity = identity or self.identity()
        peer = peer or MemoryPeer()
        await self.service.join(
            Join(
                type="room.join",
                protocolVersion=1,
                roomId=self.created["roomId"],
                sessionToken=identity["sessionToken"],
                inviteToken=token or self.created["watchToken" if watch else "inviteToken"],
                nickname="同名玩家",
            ),
            peer,
        )
        self.peers.append(peer)
        return peer

    async def command(self, peer, kind, payload=None, *, revision=None, request_id=None):
        command = {
            "type": kind,
            "requestId": request_id or secrets.token_hex(8),
            "expectedRevision": self.room.revision if revision is None else revision,
            "payload": payload or {},
        }
        return await self.service.handle(self.room, peer, command_adapter.validate_python(command))

    async def start(self):
        black = await self.create()
        white = await self.join()
        assert await self.command(black, "game.ready", {"ready": True}) == "OK"
        assert self.room.phase == "WAITING"
        assert await self.command(white, "game.ready", {"ready": True}) == "OK"
        assert self.room.phase == "PLAYING"
        return black, white

    async def move(self, peer, row, col, **kwargs):
        return await self.command(peer, "move.play", {"row": row, "col": col}, **kwargs)

    def advance(self, seconds, *, keep_online=True):
        self.clock.value += seconds
        if keep_online and self.room:
            for peer in self.room.connections.values():
                peer.last_seen = self.clock.now()


@pytest.fixture
def game():
    return Harness()

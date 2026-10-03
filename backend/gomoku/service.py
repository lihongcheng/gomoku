import hashlib
import json
import secrets
from typing import Any
from urllib.parse import urlencode

from .config import Clock, Settings
from .limits import RateLimiter
from .models import CreateRecord, Member, Receipt, Room, Session, Undo
from .protocol import PROTOCOL_VERSION, Command, Control, CreateRoom, GameError, Join
from .rules import opposite, place, turn, undo_target
from .transport import Peer


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def fingerprint(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class Service:
    def __init__(self, settings: Settings, clock: Clock | None = None):
        self.settings = settings
        self.clock = clock or Clock()
        self.epoch = secrets.token_hex(16)
        self.rooms: dict[str, Room] = {}
        self.sessions: dict[str, Session] = {}
        self.by_member: dict[str, Session] = {}
        self.draining = False
        self.sources = RateLimiter(
            settings.source_burst, settings.source_per_second, settings.max_rate_keys
        )
        self.commands = RateLimiter(
            settings.command_burst, settings.command_per_second, settings.max_rate_keys
        )

    def health(self) -> dict:
        return {
            "status": "draining" if self.draining else "ok",
            "protocolVersion": PROTOCOL_VERSION,
            "serverEpoch": self.epoch,
        }

    def new_session(self) -> dict:
        now = self.clock.now()
        self._prune_sessions(now)
        if len(self.sessions) >= self.settings.max_sessions:
            raise GameError("CAPACITY_REACHED", "Session capacity reached", 503)
        token = secrets.token_urlsafe(32)
        session = Session(secrets.token_hex(16), now + self.settings.session_ttl)
        self.sessions[digest(token)] = session
        self.by_member[session.member_id] = session
        return {
            **self.health(),
            "sessionToken": token,
            "memberId": session.member_id,
            "expiresAt": self.clock.utc(session.expires_at),
        }

    def authenticate(self, token: str) -> Session:
        session = self.sessions.get(digest(token))
        if session is None or session.expires_at <= self.clock.now():
            raise GameError("AUTH_REQUIRED", "Session is missing or expired", 401)
        return session

    def _touch(self, session: Session) -> None:
        session.expires_at = self.clock.now() + self.settings.session_ttl

    async def create(self, session: Session, key: str, body: CreateRoom) -> dict:
        content = fingerprint(body.model_dump())
        if record := session.creates.get(key):
            if record.fingerprint != content:
                raise GameError(
                    "REQUEST_ID_CONFLICT", "Creation key was used with different data", 409
                )
            room = self.rooms.get(record.response["roomId"])
            if room is not None:
                async with room.lock:
                    self._expire(room)
            if room is None or room.phase == "CLOSED":
                raise GameError("ROOM_GONE", "The original room has closed", 410)
            self._touch(session)
            return record.response
        if self.draining:
            raise GameError("SERVER_DRAINING", "Server is preparing for maintenance", 503)
        if len(session.creates) >= self.settings.max_create_keys:
            raise GameError("CREATE_LIMIT", "Session creation-key limit reached", 429)
        owned = sum(room.owner_id == session.member_id for room in self.rooms.values())
        if owned >= self.settings.max_owned_rooms:
            raise GameError("CREATE_LIMIT", "Too many open rooms for this identity", 429)
        if len(self.rooms) >= self.settings.max_rooms:
            raise GameError("CAPACITY_REACHED", "Room capacity reached", 503)
        now = self.clock.now()
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        while True:
            room_id = "".join(secrets.choice(alphabet) for _ in range(8))
            if room_id not in self.rooms:
                break
        invite, watch = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        owner = Member(
            session.member_id,
            body.nickname,
            "PLAYER",
            "BLACK",
            offline_at=now,
            reconnect_at=now + self.settings.reconnect_seconds,
        )
        room = Room(
            room_id,
            session.member_id,
            digest(invite),
            digest(watch),
            now,
            {owner.member_id: owner},
            empty_since=now,
        )
        self.rooms[room_id] = room
        base = f"{self.settings.frontend_url}#/room/{room_id}"
        response = {
            "protocolVersion": PROTOCOL_VERSION,
            "serverEpoch": self.epoch,
            "roomId": room_id,
            "inviteToken": invite,
            "watchToken": watch,
            "inviteUrl": f"{base}?{urlencode({'invite': invite})}",
            "watchUrl": f"{base}?{urlencode({'watch': watch})}",
        }
        session.creates[key] = CreateRecord(content, response)
        self._touch(session)
        return response

    @property
    def connection_count(self) -> int:
        return sum(len(room.connections) for room in self.rooms.values())

    async def join(self, message: Join, peer: Peer) -> Room:
        if message.protocolVersion != PROTOCOL_VERSION:
            raise GameError("PROTOCOL_UNSUPPORTED", "Refresh the client to use protocol version 1")
        session = self.authenticate(message.sessionToken)
        self.commands.take(f"join:{session.member_id}", self.clock.now())
        room = self.rooms.get(message.roomId)
        if room is None:
            raise GameError("ROOM_GONE", "Room no longer exists", 410)
        async with room.lock:
            self._expire(room)
            if room.phase == "CLOSED":
                raise GameError("ROOM_GONE", "Room no longer exists", 410)
            self._prune_spectators(room)
            member = room.members.get(session.member_id)
            existing_player = member is not None and member.role == "PLAYER"
            old = room.connections.get(session.member_id)
            count = self.connection_count - (1 if old else 0)
            limit = self.settings.max_connections
            if not existing_player:
                limit = max(0, limit - self.settings.reconnect_reserve)
            if count >= limit:
                raise GameError("CAPACITY_REACHED", "Connection capacity reached", 503)
            new_player = False
            if member is None:
                supplied = digest(message.inviteToken or "")
                candidate = secrets.compare_digest(supplied, room.invite_digest)
                watcher = secrets.compare_digest(supplied, room.watch_digest)
                if not candidate and not watcher:
                    raise GameError("INVITE_INVALID", "A valid invite is required", 403)
                new_player = candidate and room.phase == "WAITING" and len(room.players()) == 1
                if not new_player:
                    records = sum(m.role == "SPECTATOR" for m in room.members.values())
                    if records >= self.settings.max_spectator_records:
                        raise GameError("ROOM_FULL", "Spectator recovery capacity reached", 409)
                member = Member(
                    session.member_id,
                    message.nickname,
                    "PLAYER" if new_player else "SPECTATOR",
                    "WHITE" if new_player else None,
                )
            if member.role == "SPECTATOR" and old is None:
                online = sum(room.members[mid].role == "SPECTATOR" for mid in room.connections)
                if online >= self.settings.max_spectators:
                    raise GameError("ROOM_FULL", "Spectator capacity reached", 409)
            room.members[member.member_id] = member
            member.generation += 1
            member.offline_at = member.reconnect_at = None
            peer.member_id = member.member_id
            peer.generation = member.generation
            peer.last_seen = self.clock.now()
            room.connections[member.member_id] = peer
            room.empty_since = None
            if old is not None:
                old.stop(4001, "SESSION_REPLACED", discard=True)
            self._touch(session)
            peer.emit(
                {
                    "type": "room.joined",
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverEpoch": self.epoch,
                    "roomId": room.room_id,
                    "self": {
                        "memberId": member.member_id,
                        "nickname": member.nickname,
                        "role": member.role,
                        "color": member.color,
                        "isOwner": member.member_id == room.owner_id,
                        "generation": member.generation,
                    },
                }
            )
            self._commit(room, revision=new_player)
        return room

    def snapshot(self, room: Room) -> dict:
        players = room.players()
        idle_at = (
            room.last_activity + self.settings.idle_seconds
            if room.phase == "PLAYING" and room.last_activity is not None
            else None
        )
        undo = room.pending_undo
        return {
            "type": "room.state",
            "protocolVersion": PROTOCOL_VERSION,
            "serverEpoch": self.epoch,
            "roomId": room.room_id,
            "seq": room.seq,
            "revision": room.revision,
            "phase": room.phase,
            "players": [
                {
                    "memberId": m.member_id,
                    "nickname": m.nickname,
                    "color": m.color,
                    "isOwner": m.member_id == room.owner_id,
                    "connected": m.member_id in room.connections,
                    "ready": m.ready,
                    "reconnectDeadline": self.clock.utc(m.reconnect_at),
                }
                for m in players
            ],
            "spectatorCount": sum(
                room.members[mid].role == "SPECTATOR" for mid in room.connections
            ),
            "moves": [stone.wire() for stone in room.moves],
            "currentTurn": turn(room.moves) if room.phase == "PLAYING" else None,
            "result": room.result,
            "closeReason": room.close_reason,
            "pendingUndo": {
                "undoId": undo.undo_id,
                "requesterId": undo.member_id,
                "requestedRevision": undo.revision,
                "targetLength": undo.target_length,
                "removeCount": len(room.moves) - undo.target_length,
                "expiresAt": self.clock.utc(undo.expires_at),
            }
            if undo
            else None,
            "serverTime": self.clock.utc(self.clock.now()),
            "deadlines": {
                "waiting": self.clock.utc(
                    room.created_at + self.settings.waiting_seconds
                    if room.phase == "WAITING"
                    else None
                ),
                "idle": self.clock.utc(idle_at),
                "idleWarning": self.clock.utc(idle_at - 60 if idle_at is not None else None),
                "finished": self.clock.utc(
                    room.finished_at + self.settings.finished_seconds
                    if room.phase == "FINISHED" and room.finished_at is not None
                    else None
                ),
                "empty": self.clock.utc(self._empty_deadline(room)),
            },
            "maintenance": self.draining,
        }

    def _commit(self, room: Room, *, revision: bool = True) -> None:
        if revision:
            room.revision += 1
        room.seq += 1
        # A full queue is removed synchronously. Publish the resulting presence change
        # in a newer snapshot; a slow peer cannot stall a room or remain a live player.
        while True:
            state = self.snapshot(room)
            failed = [peer for peer in list(room.connections.values()) if not peer.emit(state)]
            if not failed or room.phase == "CLOSED":
                break
            changed = False
            for peer in failed:
                changed |= self._offline(room, peer, self.clock.now())
            room.seq += 1
            if changed:
                room.revision += 1
        if room.phase == "CLOSED":
            for peer in room.connections.values():
                peer.stop(1000, "ROOM_GONE")
            room.connections.clear()
            room.members.clear()
            self.rooms.pop(room.room_id, None)

    def _offline(self, room: Room, peer: Peer, now: float) -> bool:
        if room.connections.get(peer.member_id) is not peer:
            return False
        del room.connections[peer.member_id]
        member = room.members[peer.member_id]
        member.offline_at = now
        changed = False
        if member.role == "PLAYER" and room.phase in {"WAITING", "PLAYING"}:
            member.reconnect_at = now + self.settings.reconnect_seconds
            if room.phase == "WAITING":
                for player in room.players():
                    changed |= player.ready
                    player.ready = False
            if room.pending_undo:
                room.pending_undo = None
                changed = True
        if not room.connections:
            room.empty_since = now
        return changed

    async def disconnect(self, room: Room, peer: Peer) -> None:
        async with room.lock:
            # Old connection cleanup never affects a replacement.
            if room.connections.get(peer.member_id) is not peer:
                return
            self._expire(room)
            if room.phase != "CLOSED" and room.connections.get(peer.member_id) is peer:
                changed = self._offline(room, peer, self.clock.now())
                self._commit(room, revision=changed)

    def _finish(self, room: Room, result: dict, at: float) -> None:
        room.phase = "FINISHED"
        room.result = result
        room.finished_at = at
        room.pending_undo = None
        for player in room.players():
            player.reconnect_at = None
            player.ready = False

    def _close(self, room: Room, reason: str) -> None:
        room.phase = "CLOSED"
        room.close_reason = reason
        room.pending_undo = None
        for player in room.players():
            player.reconnect_at = None
            player.ready = False

    def _empty_deadline(self, room: Room) -> float | None:
        if room.empty_since is None:
            return None
        # Reconnect adjudication must finish even with a shorter configured empty TTL.
        reconnects = [p.reconnect_at for p in room.players() if p.reconnect_at is not None]
        deadline = room.empty_since + self.settings.empty_seconds
        return max([deadline, *(d + 0.001 for d in reconnects)])

    def _expire(self, room: Room) -> None:
        now = self.clock.now()
        for peer in list(room.connections.values()):
            if peer.closing or now - peer.last_seen >= self.settings.heartbeat_timeout:
                peer.stop(4000, "HEARTBEAT_TIMEOUT")
                changed = self._offline(room, peer, now)
                self._commit(room, revision=changed)
        while room.phase != "CLOSED":
            events: list[tuple[float, int, str, Any]] = []
            if (empty_at := self._empty_deadline(room)) is not None:
                events.append((empty_at, 0, "close", "EMPTY"))
            if room.phase == "WAITING":
                events.append(
                    (room.created_at + self.settings.waiting_seconds, 0, "close", "WAITING_TIMEOUT")
                )
            if room.phase == "FINISHED" and room.finished_at is not None:
                events.append(
                    (
                        room.finished_at + self.settings.finished_seconds,
                        0,
                        "close",
                        "FINISHED_TIMEOUT",
                    )
                )
            if room.phase in {"WAITING", "PLAYING"}:
                events.extend(
                    (m.reconnect_at, 1, "disconnect", m)
                    for m in room.players()
                    if m.reconnect_at is not None
                )
            if room.phase == "PLAYING" and room.last_activity is not None:
                events.append((room.last_activity + self.settings.idle_seconds, 2, "idle", None))
            if room.pending_undo:
                events.append((room.pending_undo.expires_at, 3, "undo", room.pending_undo))
            due = sorted((e for e in events if e[0] <= now), key=lambda e: (e[0], e[1]))
            if not due:
                break
            at, _, kind, data = due[0]
            if kind == "close":
                self._close(room, data)
            elif kind == "disconnect":
                if room.phase == "WAITING":
                    self._close(room, "DISCONNECT_TIMEOUT")
                else:
                    opponent = next(p for p in room.players() if p.member_id != data.member_id)
                    online = opponent.member_id in room.connections
                    self._finish(
                        room,
                        {
                            "winner": opponent.color if online else None,
                            "reason": "DISCONNECT_TIMEOUT" if online else "ABANDONED",
                            "winningLine": [],
                        },
                        at,
                    )
            elif kind == "idle":
                self._finish(
                    room,
                    {
                        "winner": None,
                        "reason": "ABANDONED",
                        "winningLine": [],
                    },
                    at,
                )
            else:
                room.members[data.member_id].rejected_board = room.board_revision
                room.pending_undo = None
            self._commit(room)

    async def handle(self, room: Room, peer: Peer, command: Command | Control) -> str:
        request_id = getattr(command, "requestId", None)
        async with room.lock:
            member = room.members.get(peer.member_id)
            try:
                if room.phase == "CLOSED":
                    raise GameError("ROOM_GONE", "Room no longer exists", 410)
                if (
                    member is None
                    or room.connections.get(peer.member_id) is not peer
                    or member.generation != peer.generation
                    or peer.closing
                ):
                    raise GameError("SESSION_REPLACED", "Another connection controls this identity")
                session = self.by_member.get(peer.member_id)
                if session is None or session.expires_at <= self.clock.now():
                    raise GameError("AUTH_REQUIRED", "Session expired", 401)
                if member.role != "PLAYER" and command.type not in {
                    "room.sync",
                    "heartbeat",
                    "room.leave",
                }:
                    raise GameError("NOT_PLAYER", "Spectators cannot control the game", 403)
                self._expire(room)
                if room.phase == "CLOSED":
                    return "ROOM_GONE"
                if room.connections.get(peer.member_id) is not peer:
                    return "HEARTBEAT_TIMEOUT"
                if isinstance(command, Control):
                    peer.last_seen = self.clock.now()
                    self._touch(session)
                    peer.emit(
                        self.snapshot(room)
                        if command.type == "room.sync"
                        else {
                            "type": "heartbeat.ack",
                            "serverEpoch": self.epoch,
                            "serverTime": self.clock.utc(self.clock.now()),
                        }
                    )
                    return "OK"
                self._prune_receipts(member)
                content = fingerprint(command.model_dump())
                if record := member.receipts.get(command.requestId):
                    if record.fingerprint != content:
                        raise GameError("REQUEST_ID_CONFLICT", "Request ID has different content")
                    peer.last_seen = self.clock.now()
                    self._touch(session)
                    peer.emit(record.message)
                    peer.emit(self.snapshot(room))
                    return record.message.get("code", "OK")
                try:
                    if command.expectedRevision != room.revision:
                        raise GameError("STALE_REVISION", "Synchronize the latest room state", 409)
                    revision_changed = self._action(room, member, command)
                except GameError as error:
                    message = error.wire(command.requestId)
                    self._remember(member, command.requestId, content, message)
                    peer.emit(message)
                    peer.emit(self.snapshot(room))
                    return error.code
                peer.last_seen = self.clock.now()
                self._touch(session)
                ack = {
                    "type": "command.ack",
                    "requestId": command.requestId,
                    "command": command.type,
                    "revision": room.revision + int(revision_changed),
                    "result": {"accepted": True},
                }
                self._remember(member, command.requestId, content, ack)
                peer.emit(ack)
                self._commit(room, revision=revision_changed)
                if command.type == "room.leave" and room.phase != "CLOSED":
                    changed = self._offline(room, peer, self.clock.now())
                    self._commit(room, revision=changed)
                    peer.stop(1000, "LEFT")
                return "OK"
            except GameError as error:
                peer.emit(error.wire(request_id))
                return error.code

    def _action(self, room: Room, member: Member, command: Command) -> bool:
        kind = command.type
        now = self.clock.now()
        if kind == "room.close":
            if member.member_id != room.owner_id:
                raise GameError("NOT_OWNER", "Only the owner can close the room", 403)
            if room.phase == "PLAYING":
                raise GameError("USE_RESIGN", "Resign or leave to end your participation")
            self._close(room, "OWNER_CLOSED")
            return True
        if kind == "room.leave":
            if member.role == "SPECTATOR" or room.phase == "FINISHED":
                return False
            if room.phase == "WAITING":
                self._close(room, "PLAYER_LEFT")
            else:
                self._finish(
                    room,
                    {
                        "winner": opposite(member.color),
                        "reason": "PLAYER_LEFT",
                        "winningLine": [],
                    },
                    now,
                )
            return True
        if kind == "game.ready":
            if room.phase != "WAITING":
                raise GameError("INVALID_PHASE", "Readiness is only available before the game")
            member.ready = command.payload.ready
            players = room.players()
            if len(players) == 2 and all(
                p.ready and p.member_id in room.connections for p in players
            ):
                room.phase = "PLAYING"
                room.last_activity = now
            return True
        if room.phase != "PLAYING":
            raise GameError("INVALID_PHASE", "This game is not in progress")
        if kind == "game.resign":
            self._finish(
                room,
                {
                    "winner": opposite(member.color),
                    "reason": "RESIGNED",
                    "winningLine": [],
                },
                now,
            )
            return True
        if not all(p.member_id in room.connections for p in room.players()):
            raise GameError("PLAYER_OFFLINE", "Wait for both players to reconnect")
        if kind == "undo.respond":
            undo = room.pending_undo
            if undo is None or undo.undo_id != command.payload.undoId:
                raise GameError("UNDO_EXPIRED", "This undo request is no longer active")
            if undo.member_id == member.member_id:
                raise GameError("UNDO_SELF_APPROVAL", "Only your opponent can respond")
            if command.payload.accept:
                del room.moves[undo.target_length :]
                room.board_revision += 1
                room.last_activity = now
            else:
                room.members[undo.member_id].rejected_board = room.board_revision
            room.pending_undo = None
            return True
        if room.pending_undo is not None:
            raise GameError("UNDO_PENDING", "Wait for the pending undo request")
        if kind == "undo.request":
            if now - member.last_undo_at < self.settings.undo_cooldown:
                raise GameError("UNDO_COOLDOWN", "Wait before requesting another undo")
            if member.rejected_board == room.board_revision:
                raise GameError("UNDO_REPEATED", "A new move is required before another request")
            target = undo_target(room.moves, member.color)
            room.pending_undo = Undo(
                secrets.token_hex(16),
                member.member_id,
                room.revision,
                target,
                now + self.settings.undo_seconds,
            )
            member.last_undo_at = now
            return True
        if kind == "move.play":
            if turn(room.moves) != member.color:
                raise GameError("NOT_YOUR_TURN", "Wait for your turn")
            stone, result = place(room.moves, command.payload.row, command.payload.col)
            room.moves.append(stone)
            room.board_revision += 1
            room.last_activity = now
            if result:
                self._finish(room, result, now)
            return True
        raise GameError("INVALID_MESSAGE", "Unsupported command")

    def _remember(self, member: Member, key: str, content: str, message: dict) -> None:
        member.receipts[key] = Receipt(
            content, message, self.clock.now() + self.settings.request_ttl
        )
        while len(member.receipts) > self.settings.max_request_records:
            member.receipts.popitem(last=False)

    def _prune_receipts(self, member: Member) -> None:
        for key, record in list(member.receipts.items()):
            if record.expires_at <= self.clock.now():
                del member.receipts[key]

    def _prune_spectators(self, room: Room) -> None:
        for mid, member in list(room.members.items()):
            if (
                member.role == "SPECTATOR"
                and member.offline_at is not None
                and self.clock.now() - member.offline_at >= self.settings.spectator_ttl
            ):
                del room.members[mid]

    def _prune_sessions(self, now: float) -> None:
        for key, session in list(self.sessions.items()):
            if session.expires_at <= now:
                del self.by_member[session.member_id]
                del self.sessions[key]

    async def tick(self) -> None:
        for room in list(self.rooms.values()):
            async with room.lock:
                self._expire(room)
                self._prune_spectators(room)
                for member in room.members.values():
                    self._prune_receipts(member)
                for mid in room.connections:
                    if session := self.by_member.get(mid):
                        self._touch(session)
        self._prune_sessions(self.clock.now())
        self.sources.prune(self.clock.now())
        self.commands.prune(self.clock.now())

    async def set_draining(self, enabled: bool) -> None:
        if self.draining == enabled:
            return
        self.draining = enabled
        for room in list(self.rooms.values()):
            async with room.lock:
                self._expire(room)
                if room.phase != "CLOSED":
                    self._commit(room, revision=False)

    async def shutdown(self) -> None:
        self.draining = True
        for room in list(self.rooms.values()):
            async with room.lock:
                self._close(room, "SERVER_SHUTDOWN")
                self._commit(room)

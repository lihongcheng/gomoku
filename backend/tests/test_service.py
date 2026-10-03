import asyncio
import json

import pytest
from conftest import Harness

from gomoku.config import Settings
from gomoku.limits import RateLimiter
from gomoku.protocol import CreateRoom, GameError, command_adapter
from gomoku.transport import Peer


async def test_invite_roles_race_and_private_state(game):
    await game.create()
    watcher_identity = game.identity()
    watch = await game.join(watcher_identity, watch=True)
    assert game.room.members[watch.member_id].role == "SPECTATOR"
    await game.join(watcher_identity)
    assert len(game.room.players()) == 1
    peers = await asyncio.gather(*(game.join() for _ in range(5)))
    assert sum(game.room.members[p.member_id].color == "WHITE" for p in peers) == 1
    assert len(game.room.players()) == 2
    public = json.dumps(game.service.snapshot(game.room))
    assert "sessionToken" not in public and "inviteToken" not in public and '"self"' not in public
    assert game.created["inviteToken"] not in public
    with pytest.raises(GameError) as error:
        await game.join(token="invalid-invitation-token")
    assert error.value.code == "INVITE_INVALID"


async def test_readiness_disconnect_and_no_replacement(game):
    black = await game.create()
    white = await game.join()
    await game.command(black, "game.ready", {"ready": True})
    await game.command(black, "game.ready", {"ready": False})
    assert not game.room.members[black.member_id].ready
    await game.command(black, "game.ready", {"ready": True})
    await game.service.disconnect(game.room, white)
    assert not any(p.ready for p in game.room.players())
    outsider = await game.join()
    assert game.room.members[outsider.member_id].role == "SPECTATOR"
    assert await game.move(outsider, 0, 0) == "NOT_PLAYER"


async def test_idempotency_before_revision_and_request_conflict(game):
    black, white = await game.start()
    revision = game.room.revision
    assert await game.move(black, 7, 7, request_id="first", revision=revision) == "OK"
    await game.move(white, 7, 8)
    latest_revision = game.room.revision
    assert await game.move(black, 7, 7, request_id="first", revision=revision) == "OK"
    assert len(game.room.moves) == 2 and game.room.revision == latest_revision
    assert black.messages[-2]["revision"] == revision + 1
    assert black.messages[-1]["revision"] == latest_revision
    assert (
        await game.move(black, 7, 9, request_id="first", revision=revision) == "REQUEST_ID_CONFLICT"
    )
    assert await game.move(black, 7, 9, revision=revision) == "STALE_REVISION"


async def test_spectators_do_not_stale_moves(game):
    black, _ = await game.start()
    revision, seq = game.room.revision, game.room.seq
    watcher = await game.join()
    await game.service.disconnect(game.room, watcher)
    assert game.room.seq > seq and game.room.revision == revision
    assert await game.move(black, 7, 7, revision=revision) == "OK"
    for peer in game.peers:
        seqs = [m["seq"] for m in peer.messages if m["type"] == "room.state"]
        assert seqs == sorted(seqs)


async def test_concurrent_moves_commit_once(game):
    black, _ = await game.start()
    revision = game.room.revision
    codes = await asyncio.gather(
        game.move(black, 0, 0, revision=revision),
        game.move(black, 1, 1, revision=revision),
    )
    assert sorted(codes) == ["OK", "STALE_REVISION"]
    assert len(game.room.moves) == 1


@pytest.mark.parametrize("requester_index,target", [(0, 2), (1, 1)])
async def test_undo_one_or_two_stones(game, requester_index, target):
    players = await game.start()
    await game.move(players[0], 7, 7)
    await game.move(players[1], 7, 8)
    await game.move(players[0], 8, 8)
    requester, opponent = players[requester_index], players[1 - requester_index]
    assert await game.command(requester, "undo.request") == "OK"
    undo_id = game.room.pending_undo.undo_id
    assert await game.move(players[1], 8, 7) == "UNDO_PENDING"
    payload = {"undoId": undo_id, "accept": True}
    assert await game.command(requester, "undo.respond", payload) == "UNDO_SELF_APPROVAL"
    revision = game.room.revision
    assert (
        await game.command(
            opponent, "undo.respond", payload, request_id="approve", revision=revision
        )
        == "OK"
    )
    assert len(game.room.moves) == target
    assert game.service.snapshot(game.room)["currentTurn"] == (
        "BLACK" if requester_index == 0 else "WHITE"
    )
    assert (
        await game.command(
            opponent, "undo.respond", payload, request_id="approve", revision=revision
        )
        == "OK"
    )
    assert len(game.room.moves) == target


@pytest.mark.parametrize("expire", [False, True])
async def test_undo_reject_timeout_cooldown_and_new_board(game, expire):
    black, white = await game.start()
    await game.move(black, 7, 7)
    await game.command(black, "undo.request")
    undo_id = game.room.pending_undo.undo_id
    original_activity = game.room.last_activity
    if expire:
        game.advance(30)
        await game.service.tick()
        assert (
            await game.command(white, "undo.respond", {"undoId": undo_id, "accept": True})
            == "UNDO_EXPIRED"
        )
    else:
        await game.command(white, "undo.respond", {"undoId": undo_id, "accept": False})
        assert await game.command(black, "undo.request") == "UNDO_COOLDOWN"
        game.advance(30)
    assert len(game.room.moves) == 1
    assert game.room.last_activity == original_activity
    assert await game.command(black, "undo.request") == "UNDO_REPEATED"
    await game.move(white, 7, 8)
    assert await game.command(black, "undo.request") == "OK"


async def test_disconnect_cancels_undo_and_requires_online(game):
    black, white = await game.start()
    await game.move(black, 7, 7)
    await game.command(black, "undo.request")
    await game.service.disconnect(game.room, black)
    assert game.room.pending_undo is None
    assert await game.move(white, 7, 8) == "PLAYER_OFFLINE"
    recovered = await game.join(game.identities[0])
    assert recovered.member_id == black.member_id
    assert await game.move(white, 7, 8) == "OK"


async def test_takeover_old_commands_and_cleanup_cannot_disconnect_new(game):
    black, _ = await game.start()
    recovered = await game.join(game.identities[0])
    assert black.close_reason == "SESSION_REPLACED"
    assert recovered.generation == black.generation + 1
    await game.service.disconnect(game.room, black)
    assert game.room.connections[black.member_id] is recovered
    assert await game.move(black, 0, 0) == "SESSION_REPLACED"
    assert await game.move(recovered, 0, 0) == "OK"


@pytest.mark.parametrize("both", [False, True])
async def test_disconnect_deadline_with_spectator(game, both):
    black, white = await game.start()
    await game.join()
    await game.service.disconnect(game.room, black)
    if both:
        await game.service.disconnect(game.room, white)
    game.advance(60)
    await game.service.tick()
    assert game.room.phase == "FINISHED"
    assert game.room.result["winner"] == (None if both else "WHITE")
    assert game.room.result["reason"] == ("ABANDONED" if both else "DISCONNECT_TIMEOUT")
    await game.join(game.identities[0])
    assert game.room.phase == "FINISHED"


@pytest.mark.parametrize("delay,phase", [(59.999, "PLAYING"), (60, "FINISHED")])
async def test_reconnect_exact_boundary(game, delay, phase):
    black, _ = await game.start()
    await game.service.disconnect(game.room, black)
    game.advance(delay)
    await game.join(game.identities[0])
    assert game.room.phase == phase


async def test_return_does_not_reset_other_deadline(game):
    black, white = await game.start()
    await game.service.disconnect(game.room, black)
    game.advance(10)
    await game.service.disconnect(game.room, white)
    white_deadline = game.room.members[white.member_id].reconnect_at
    game.advance(40)
    await game.join(game.identities[0])
    assert game.room.members[white.member_id].reconnect_at == white_deadline
    game.advance(20)
    await game.service.tick()
    assert game.room.result["winner"] == "BLACK"


async def test_heartbeat_detection_has_separate_grace(game):
    black, _ = await game.start()
    game.advance(60, keep_online=False)
    await game.service.tick()
    assert game.room.phase == "PLAYING"
    assert not game.room.connections
    assert game.room.members[black.member_id].reconnect_at == game.clock.now() + 60
    game.advance(60)
    await game.service.tick()
    assert game.room.result["reason"] == "ABANDONED"


async def test_waiting_closes_on_expired_owner_and_old_creation_key(game):
    await game.create()
    await game.service.disconnect(game.room, game.peers[0])
    game.advance(60)
    await game.service.tick()
    assert game.room.phase == "CLOSED" and not game.service.rooms
    session = game.service.authenticate(game.identities[0]["sessionToken"])
    with pytest.raises(GameError) as error:
        await game.service.create(session, "create-1", CreateRoom(nickname="黑方"))
    assert error.value.code == "ROOM_GONE"


async def test_create_idempotency_limit_and_conflict(game):
    await game.create()
    session = game.service.authenticate(game.identities[0]["sessionToken"])
    response = await game.service.create(session, "create-1", CreateRoom(nickname="黑方"))
    assert response == game.created and len(game.service.rooms) == 1
    with pytest.raises(GameError) as error:
        await game.service.create(session, "create-1", CreateRoom(nickname="不同"))
    assert error.value.code == "REQUEST_ID_CONFLICT"
    for key in ["create-2", "create-3"]:
        await game.service.create(session, key, CreateRoom(nickname="黑方"))
    with pytest.raises(GameError) as error:
        await game.service.create(session, "create-4", CreateRoom(nickname="黑方"))
    assert error.value.code == "CREATE_LIMIT"


@pytest.mark.parametrize("kind", ["game.resign", "room.leave"])
async def test_end_game_is_immutable_and_owner_cannot_close_midgame(game, kind):
    black, white = await game.start()
    assert await game.command(black, "room.close") == "USE_RESIGN"
    await game.move(black, 7, 7)
    await game.command(black, "undo.request")
    assert await game.command(black, kind) == "OK"
    result = game.room.result.copy()
    assert result["winner"] == "WHITE" and game.room.pending_undo is None
    assert await game.command(white, "game.resign") == "INVALID_PHASE"
    assert game.room.result == result


async def test_actual_five_in_row_then_reject_moves(game):
    black, white = await game.start()
    for col in range(4):
        assert await game.move(black, 7, col) == "OK"
        assert await game.move(white, 8, col) == "OK"
    await game.move(black, 7, 4)
    assert game.room.phase == "FINISHED"
    assert game.room.result["winner"] == "BLACK"
    assert await game.move(white, 8, 4) == "INVALID_PHASE"
    assert await game.command(black, "undo.request") == "INVALID_PHASE"


async def test_deadline_order_idle_before_later_disconnect():
    game = Harness(Settings(_env_file=None, idle_seconds=50))
    black, _ = await game.start()
    game.advance(10)
    await game.service.disconnect(game.room, black)
    game.advance(61)
    await game.service.tick()
    assert game.room.result["reason"] == "ABANDONED"


async def test_tie_prioritizes_disconnect_over_idle():
    game = Harness(Settings(_env_file=None, idle_seconds=60))
    black, _ = await game.start()
    await game.service.disconnect(game.room, black)
    game.advance(60)
    await game.service.tick()
    assert game.room.result["reason"] == "DISCONNECT_TIMEOUT"


async def test_finished_retention_waiting_timeout_and_empty_reclaim():
    game = Harness(
        Settings(_env_file=None, waiting_seconds=20, finished_seconds=10, empty_seconds=5)
    )
    black = await game.create()
    game.advance(20)
    await game.service.tick()
    assert game.room.close_reason == "WAITING_TIMEOUT"
    game = Harness(Settings(_env_file=None, finished_seconds=10))
    black, _ = await game.start()
    await game.join()
    await game.command(black, "game.resign")
    game.advance(10)
    await game.service.tick()
    assert game.room.close_reason == "FINISHED_TIMEOUT"
    game = Harness(Settings(_env_file=None, empty_seconds=5))
    black, white = await game.start()
    await game.service.disconnect(game.room, black)
    await game.service.disconnect(game.room, white)
    game.advance(5)
    await game.service.tick()
    assert game.room.phase == "PLAYING"
    game.advance(55)
    await game.service.tick()
    assert game.room.phase == "CLOSED"
    assert game.room.result["reason"] == "ABANDONED"


async def test_spectator_record_expires_and_room_capacity():
    game = Harness(Settings(_env_file=None, max_spectators=1))
    await game.create()
    identity = game.identity()
    watcher = await game.join(identity, watch=True)
    with pytest.raises(GameError) as error:
        await game.join(watch=True)
    assert error.value.code == "ROOM_FULL"
    await game.service.disconnect(game.room, watcher)
    game.advance(300)
    await game.service.tick()
    assert watcher.member_id not in game.room.members
    # Only a cleared spectator record permits a fresh invitation to allocate white.
    recovered = await game.join(identity)
    assert game.room.members[recovered.member_id].color == "WHITE"


async def test_reconnect_reserve_excludes_new_spectators():
    game = Harness(Settings(_env_file=None, max_connections=3, reconnect_reserve=1))
    black, white = await game.start()
    with pytest.raises(GameError) as error:
        await game.join()
    assert error.value.code == "CAPACITY_REACHED"
    await game.service.disconnect(game.room, white)
    await game.join()
    recovered = await game.join(game.identities[1])
    assert game.room.connections[white.member_id] is recovered
    assert len(game.room.connections) == 3


async def test_slow_spectator_queue_does_not_block_players(game):
    black, white = await game.start()
    slow = Peer(None, Settings(_env_file=None, send_queue_size=2))
    await game.join(peer=slow)
    # Joined + state fill the queue; the next update evicts only this peer.
    assert await game.move(black, 7, 7) == "OK"
    assert slow.closing and slow.member_id not in game.room.connections
    assert await game.move(white, 7, 8) == "OK"
    assert len(game.room.moves) == 2
    assert game.service.snapshot(game.room)["spectatorCount"] == 0


async def test_drain_keeps_active_game_and_retries_working(game):
    black, _ = await game.start()
    await game.service.set_draining(True)
    assert game.service.snapshot(game.room)["maintenance"]
    assert await game.move(black, 7, 7) == "OK"
    session = game.service.authenticate(game.identities[0]["sessionToken"])
    assert await game.service.create(session, "create-1", CreateRoom(nickname="黑方"))
    with pytest.raises(GameError) as error:
        await game.service.create(session, "new", CreateRoom(nickname="黑方"))
    assert error.value.code == "SERVER_DRAINING"


async def test_sessions_and_receipts_are_bounded_and_expire():
    game = Harness(
        Settings(
            _env_file=None,
            session_ttl=100,
            max_sessions=3,
            max_request_records=2,
            request_ttl=10,
        )
    )
    black, _ = await game.start()
    for _ in range(3):
        await game.command(black, "undo.request")
    assert len(game.room.members[black.member_id].receipts) == 2
    game.advance(10)
    await game.service.tick()
    assert not game.room.members[black.member_id].receipts
    game.identity()
    with pytest.raises(GameError):
        game.identity()
    game.advance(101, keep_online=False)
    await game.service.tick()
    assert not game.service.sessions


async def test_heartbeat_does_not_advance_public_versions(game):
    black, _ = await game.start()
    before = game.room.revision, game.room.seq, game.room.last_activity
    await game.service.handle(
        game.room, black, command_adapter.validate_python({"type": "heartbeat"})
    )
    assert before == (game.room.revision, game.room.seq, game.room.last_activity)
    assert black.messages[-1]["type"] == "heartbeat.ack"


def test_rate_limit_refill_and_bounded_source_keys():
    limiter = RateLimiter(2, 1, 1)
    limiter.take("one", 0)
    limiter.take("one", 0)
    with pytest.raises(GameError):
        limiter.take("one", 0)
    with pytest.raises(GameError):
        limiter.take("two", 0)
    limiter.take("two", 2)
    assert len(limiter.buckets) == 1

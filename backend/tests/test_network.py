import asyncio
import json
import secrets
import socket
from contextlib import AsyncExitStack

import httpx
import pytest
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from gomoku.config import Settings
from gomoku.main import create_app

ORIGIN = "http://localhost:5173"


@pytest.fixture
async def server():
    app = create_app(
        Settings(
            _env_file=None,
            tick_seconds=0.02,
            join_timeout=0.3,
            source_burst=5000,
            command_burst=1000,
            admin_token="test-admin-token",
        )
    )
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    instance = uvicorn.Server(
        uvicorn.Config(
            app,
            log_level="error",
            ws="websockets-sansio",
            ws_max_size=4096,
            lifespan="on",
            proxy_headers=False,
        )
    )
    task = asyncio.create_task(instance.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(5):
            while not instance.started:
                if task.done():
                    task.result()
                await asyncio.sleep(0.01)
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
            yield client, f"ws://127.0.0.1:{port}/ws", app.state.service
    finally:
        instance.should_exit = True
        async with asyncio.timeout(10):
            await task
        sock.close()


async def receive(ws, kind, **matching):
    async with asyncio.timeout(3):
        while True:
            message = json.loads(await ws.recv())
            if message["type"] == kind and all(message.get(k) == v for k, v in matching.items()):
                return message


async def identity(client):
    response = await client.post("/sessions")
    assert response.status_code == 201
    return response.json()


async def create_room(client, owner):
    response = await client.post(
        "/rooms",
        json={"nickname": "黑方"},
        headers={"Authorization": f"Bearer {owner['sessionToken']}", "Idempotency-Key": "room-1"},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def join(ws, room, member, *, token=None):
    await ws.send(
        json.dumps(
            {
                "type": "room.join",
                "protocolVersion": 1,
                "roomId": room["roomId"],
                "sessionToken": member["sessionToken"],
                "inviteToken": token or room["inviteToken"],
                "nickname": "玩家",
            }
        )
    )
    return await receive(ws, "room.joined")


async def send_command(ws, kind, revision, payload=None, request_id=None):
    command = {
        "type": kind,
        "expectedRevision": revision,
        "requestId": request_id or secrets.token_hex(8),
        "payload": payload or {},
    }
    await ws.send(json.dumps(command))
    return command


async def ready(black, white):
    await black.send('{"type":"room.sync"}')
    # Drain any join broadcasts via a heartbeat barrier on the same ordered socket.
    await black.send('{"type":"heartbeat"}')
    await receive(black, "heartbeat.ack")
    await black.send('{"type":"room.sync"}')
    state = await receive(black, "room.state")
    await send_command(black, "game.ready", state["revision"], {"ready": True})
    ack = await receive(black, "command.ack")
    await send_command(white, "game.ready", ack["revision"], {"ready": True})
    await receive(white, "command.ack")
    return await receive(black, "room.state", phase="PLAYING")


async def test_three_real_clients_undo_replay_reconnect_and_win(server):
    client, url, _ = server
    owner, friend, viewer = [await identity(client) for _ in range(3)]
    room = await create_room(client, owner)
    async with AsyncExitStack() as stack:
        black, white, watch = [
            await stack.enter_async_context(connect(url, origin=ORIGIN)) for _ in range(3)
        ]
        assert (await join(black, room, owner))["self"]["color"] == "BLACK"
        assert (await join(white, room, friend))["self"]["color"] == "WHITE"
        assert (await join(watch, room, viewer))["self"]["role"] == "SPECTATOR"
        state = await ready(black, white)
        command = await send_command(
            black, "move.play", state["revision"], {"row": 7, "col": 7}, "first"
        )
        ack = await receive(black, "command.ack", requestId="first")
        state = await receive(watch, "room.state", revision=ack["revision"])
        assert state["moves"] == [{"row": 7, "col": 7, "color": "BLACK"}]
        await black.send(json.dumps(command))
        assert await receive(black, "command.ack", requestId="first") == ack
        await send_command(watch, "move.play", ack["revision"], {"row": 0, "col": 0})
        assert (await receive(watch, "error"))["code"] == "NOT_PLAYER"
        await send_command(white, "move.play", ack["revision"], {"row": 7, "col": 8})
        ack = await receive(white, "command.ack")
        await send_command(black, "undo.request", ack["revision"])
        ack = await receive(black, "command.ack", command="undo.request")
        state = await receive(white, "room.state", revision=ack["revision"])
        assert state["pendingUndo"]["removeCount"] == 2
        await send_command(
            white,
            "undo.respond",
            ack["revision"],
            {
                "undoId": state["pendingUndo"]["undoId"],
                "accept": True,
            },
        )
        ack = await receive(white, "command.ack", command="undo.respond")
        state = await receive(watch, "room.state", revision=ack["revision"])
        assert state["moves"] == [] and state["currentTurn"] == "BLACK"
        replacement = await stack.enter_async_context(connect(url, origin=ORIGIN))
        await join(replacement, room, owner)
        assert (await receive(black, "error", code="SESSION_REPLACED"))[
            "code"
        ] == "SESSION_REPLACED"
        with pytest.raises(ConnectionClosed):
            while True:
                await black.recv()
        state = await receive(replacement, "room.state")
        assert state["players"][0]["connected"]
        await send_command(replacement, "game.resign", state["revision"])
        state = await receive(watch, "room.state", phase="FINISHED")
        assert state["result"]["winner"] == "WHITE"
        assert state["result"]["reason"] == "RESIGNED"


async def test_http_auth_cors_idempotency_body_limits_and_drain(server):
    client, _, service = server
    assert (await client.get("/health")).json()["serverEpoch"] == service.epoch
    owner = await identity(client)
    headers = {"Authorization": f"Bearer {owner['sessionToken']}", "Idempotency-Key": "room-1"}
    room = await create_room(client, owner)
    retry = await client.post("/rooms", headers=headers, json={"nickname": "黑方"})
    assert retry.json() == room
    assert (
        await client.post("/rooms", headers=headers, json={"nickname": "different"})
    ).status_code == 409
    assert (
        await client.post("/rooms", headers={"Idempotency-Key": "one"}, json={"nickname": "人"})
    ).status_code == 401
    preflight = await client.options(
        "/rooms",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization,Idempotency-Key,Content-Type",
        },
    )
    assert preflight.headers["access-control-allow-origin"] == ORIGIN
    assert (
        await client.post("/sessions", headers={"Origin": "https://untrusted.example"})
    ).status_code == 403
    assert (await client.post("/rooms", content="x" * 4097)).status_code == 413
    assert (await client.post("/admin/drain", json={"enabled": True})).status_code == 401
    drained = await client.post(
        "/admin/drain",
        json={"enabled": True},
        headers={"Authorization": "Bearer test-admin-token"},
    )
    assert drained.json()["status"] == "draining"
    headers["Idempotency-Key"] = "room-2"
    assert (await client.post("/rooms", headers=headers, json={"nickname": "黑方"})).json()[
        "code"
    ] == "SERVER_DRAINING"


async def test_websocket_origin_auth_protocol_timeout_and_size(server):
    client, url, _ = server
    for origin in (None, "https://untrusted.example"):
        with pytest.raises(InvalidStatus):
            async with connect(url, origin=origin):
                pytest.fail("Untrusted Origin was accepted")
    async with connect(url, origin=ORIGIN) as ws:
        assert (await receive(ws, "error"))["code"] == "JOIN_TIMEOUT"
    async with connect(url, origin=ORIGIN) as ws:
        await ws.send("not-json")
        assert (await receive(ws, "error"))["code"] == "INVALID_MESSAGE"
    owner = await identity(client)
    room = await create_room(client, owner)
    async with connect(url, origin=ORIGIN) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "room.join",
                    "protocolVersion": 2,
                    "roomId": room["roomId"],
                    "sessionToken": owner["sessionToken"],
                    "nickname": "玩家",
                }
            )
        )
        assert (await receive(ws, "error"))["code"] == "PROTOCOL_UNSUPPORTED"
    async with connect(url, origin=ORIGIN) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "room.join",
                    "protocolVersion": 1,
                    "roomId": room["roomId"],
                    "sessionToken": "invalid-session-token",
                    "nickname": "玩家",
                }
            )
        )
        assert (await receive(ws, "error"))["code"] == "AUTH_REQUIRED"
    async with connect(url, origin=ORIGIN) as ws:
        await join(ws, room, owner)
        await receive(ws, "room.state")
        await ws.send("x" * 4097)
        with pytest.raises(ConnectionClosed):
            while True:
                await ws.recv()


async def test_malformed_commands_do_not_mutate_and_eventually_close(server):
    client, url, service = server
    owner = await identity(client)
    room = await create_room(client, owner)
    async with connect(url, origin=ORIGIN) as ws:
        await join(ws, room, owner)
        await receive(ws, "room.state")
        for _ in range(5):
            await ws.send('{"type":"move.play","payload":{"row":true,"col":7}}')
            assert (await receive(ws, "error"))["code"] == "INVALID_MESSAGE"
        await receive(ws, "error", code="TOO_MANY_ERRORS")
        assert service.rooms[room["roomId"]].moves == []


async def test_scheduler_closes_waiting_room_without_incoming_messages(server):
    client, url, service = server
    owner = await identity(client)
    room = await create_room(client, owner)
    async with connect(url, origin=ORIGIN) as ws:
        await join(ws, room, owner)
        await receive(ws, "room.state")
        # Advance the deadline instead of waiting ten minutes.
        service.rooms[room["roomId"]].created_at -= service.settings.waiting_seconds
        state = await receive(ws, "room.state", phase="CLOSED")
        assert state["closeReason"] == "WAITING_TIMEOUT"
        assert room["roomId"] not in service.rooms


async def test_ten_games_with_fifty_spectators_smoke(server):
    client, url, service = server
    async with AsyncExitStack() as stack:
        games = []
        for _ in range(10):
            members = [await identity(client) for _ in range(7)]
            room = await create_room(client, members[0])
            sockets = [
                await stack.enter_async_context(connect(url, origin=ORIGIN)) for _ in range(7)
            ]
            for ws, member in zip(sockets, members, strict=True):
                await join(ws, room, member)
            state = await ready(sockets[0], sockets[1])
            games.append((sockets, state))
        assert service.connection_count == 70

        async def play(sockets, state):
            for index in range(6):
                player = sockets[index % 2]
                command = await send_command(
                    player,
                    "move.play",
                    state["revision"],
                    {"row": index % 2 + 7, "col": index // 2},
                )
                ack = await receive(player, "command.ack", requestId=command["requestId"])
                states = [
                    await receive(watcher, "room.state", revision=ack["revision"])
                    for watcher in sockets[2:]
                ]
                assert all(s == states[0] for s in states)
                state = states[0]
            assert len(state["moves"]) == 6

        await asyncio.gather(*(play(*game) for game in games))


async def test_concurrent_unauthenticated_connections_obey_capacity(server):
    _, url, service = server
    service.settings.max_pending_connections = 2
    service.settings.join_timeout = 2
    results = await asyncio.gather(
        *(connect(url, origin=ORIGIN) for _ in range(10)), return_exceptions=True
    )
    sockets = [result for result in results if not isinstance(result, Exception)]
    try:
        assert len(sockets) == 2
        assert all(isinstance(r, InvalidStatus) for r in results if isinstance(r, Exception))
    finally:
        await asyncio.gather(*(ws.close() for ws in sockets))


async def test_normal_stale_revision_errors_do_not_disconnect_player(server):
    client, url, _ = server
    owner = await identity(client)
    room = await create_room(client, owner)
    async with connect(url, origin=ORIGIN) as ws:
        await join(ws, room, owner)
        await receive(ws, "room.state")
        for _ in range(6):
            await send_command(ws, "game.ready", 0, {"ready": True})
            assert (await receive(ws, "error"))["code"] == "STALE_REVISION"
        await ws.send('{"type":"heartbeat"}')
        assert (await receive(ws, "heartbeat.ack"))["serverEpoch"] == room["serverEpoch"]

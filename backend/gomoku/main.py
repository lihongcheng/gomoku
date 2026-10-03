import asyncio
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager, suppress
from typing import Annotated

from fastapi import FastAPI, Header, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import StrictBool, ValidationError
from starlette.websockets import WebSocketDisconnect

from .config import Clock, Settings
from .protocol import CreateRoom, GameError, Join, Model, RequestId, command_adapter
from .service import Service
from .transport import Peer

logger = logging.getLogger("gomoku")


class DrainRequest(Model):
    enabled: StrictBool


class BodyLimit:
    """Bound request bodies before FastAPI JSON parsing, including chunked uploads."""

    def __init__(self, app, limit: int):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.limit:
                response = JSONResponse(
                    GameError("MESSAGE_TOO_LARGE", "Request body exceeds the limit").wire(),
                    status_code=413,
                )
                return await response(scope, receive, send)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        return await self.app(scope, replay, send)


def create_app(settings: Settings | None = None, clock: Clock | None = None) -> FastAPI:
    settings = settings or Settings()
    service = Service(settings, clock)
    peers: set[Peer] = set()
    pending: set[Peer] = set()

    async def scheduler() -> None:
        while True:
            await asyncio.sleep(settings.tick_seconds)
            await service.tick()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(scheduler(), name="room-deadlines")
        yield
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        await service.shutdown()

    app = FastAPI(title="Gomoku", version="0.1.0", lifespan=lifespan)
    app.state.service = service
    app.add_middleware(BodyLimit, limit=settings.max_message_bytes)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
        allow_credentials=False,
    )

    @app.middleware("http")
    async def http_boundary(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin is not None and origin not in settings.allowed_origins:
            return JSONResponse(
                GameError("ORIGIN_FORBIDDEN", "Origin is not allowed").wire(), status_code=403
            )
        if request.method == "POST":
            try:
                source = request.client.host if request.client else "unknown"
                service.sources.take(f"http:{source}", service.clock.now())
            except GameError as error:
                return JSONResponse(error.wire(), status_code=error.status)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(GameError)
    async def game_error(request: Request, error: GameError):
        logger.info("http_error code=%s path=%s", error.code, request.url.path)
        return JSONResponse(error.wire(), status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError):
        # Pydantic errors may include user input. Never return/log tokens or raw bodies.
        return JSONResponse(
            GameError("INVALID_MESSAGE", "Invalid request schema").wire(), status_code=422
        )

    def bearer(value: str | None) -> str:
        if value is None or not value.startswith("Bearer ") or len(value) > 300:
            raise GameError("AUTH_REQUIRED", "A Bearer session token is required", 401)
        return value[7:]

    @app.get("/health")
    async def health():
        return service.health()

    @app.post("/sessions", status_code=201)
    async def sessions():
        return service.new_session()

    @app.post("/rooms", status_code=201)
    async def rooms(
        body: CreateRoom,
        idempotency_key: Annotated[RequestId, Header()],
        authorization: Annotated[str | None, Header()] = None,
    ):
        session = service.authenticate(bearer(authorization))
        service.commands.take(f"create:{session.member_id}", service.clock.now())
        return await service.create(session, idempotency_key, body)

    @app.post("/admin/drain")
    async def drain(body: DrainRequest, authorization: str | None = Header(default=None)):
        if not settings.admin_token:
            raise GameError("NOT_FOUND", "Administration is disabled", 404)
        if not secrets.compare_digest(bearer(authorization), settings.admin_token):
            raise GameError("AUTH_REQUIRED", "Invalid administrator token", 401)
        await service.set_draining(body.enabled)
        return {**service.health(), "openRooms": len(service.rooms)}

    async def receive_object(websocket: WebSocket) -> dict:
        packet = await websocket.receive()
        if packet["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(packet.get("code", 1000))
        text = packet.get("text")
        if text is None:
            raise GameError("INVALID_MESSAGE", "Only JSON text messages are accepted")
        if len(text.encode("utf-8")) > settings.max_message_bytes:
            raise GameError("MESSAGE_TOO_LARGE", "Message exceeds 4 KiB")
        try:
            value = json.loads(text)
        except (ValueError, RecursionError) as error:
            raise GameError("INVALID_MESSAGE", "Invalid JSON") from error
        if not isinstance(value, dict):
            raise GameError("INVALID_MESSAGE", "Message must be a JSON object")
        return value

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        origin = websocket.headers.get("origin")
        if (
            (origin is None and not settings.allow_missing_origin)
            or (origin is not None and origin not in settings.allowed_origins)
            or websocket.query_params
        ):
            await websocket.close(code=1008)
            return
        source = websocket.client.host if websocket.client else "unknown"
        try:
            service.sources.take(f"ws:{source}", service.clock.now())
        except GameError:
            await websocket.close(code=1008)
            return
        if (
            len(pending) >= settings.max_pending_connections
            or len(peers) >= settings.max_connections + settings.max_pending_connections
        ):
            await websocket.close(code=1013)
            return
        peer = Peer(websocket, settings)
        peers.add(peer)
        pending.add(peer)
        try:
            await websocket.accept()
        except BaseException:
            peers.discard(peer)
            pending.discard(peer)
            raise
        room = None

        async def reader() -> None:
            nonlocal room
            try:
                async with asyncio.timeout(settings.join_timeout):
                    join_message = Join.model_validate(await receive_object(websocket))
                    room = await service.join(join_message, peer)
            except TimeoutError:
                peer.stop(4000, "JOIN_TIMEOUT")
                return
            except ValidationError:
                peer.emit(GameError("INVALID_MESSAGE", "First message must be room.join").wire())
                peer.stop(1008, "INVALID_MESSAGE")
                return
            except GameError as error:
                peer.emit(error.wire())
                peer.stop(1008, error.code)
                return
            finally:
                pending.discard(peer)
            invalid = 0
            while not peer.closing:
                started = None
                request_id = None
                try:
                    data = await receive_object(websocket)
                    started = time.perf_counter()
                    service.commands.take(peer.member_id, service.clock.now())
                    command = command_adapter.validate_python(data)
                    request_id = getattr(command, "requestId", None)
                    code = await service.handle(room, peer, command)
                    if code in {
                        "NOT_PLAYER",
                        "NOT_OWNER",
                        "REQUEST_ID_CONFLICT",
                        "AUTH_REQUIRED",
                        "SESSION_REPLACED",
                    }:
                        invalid += 1
                except ValidationError:
                    code = "INVALID_MESSAGE"
                    invalid += 1
                    peer.emit(GameError(code, "Invalid command schema").wire())
                except GameError as error:
                    code = error.code
                    invalid += 1
                    peer.emit(error.wire())
                logger.info(
                    "command request_id=%s code=%s elapsed_ms=%.2f",
                    request_id,
                    code,
                    (time.perf_counter() - started) * 1000 if started is not None else 0,
                )
                if invalid >= settings.max_invalid_messages:
                    peer.stop(1008, "TOO_MANY_ERRORS")

        writer_task = asyncio.create_task(peer.writer(), name="socket-writer")
        reader_task = asyncio.create_task(reader(), name="socket-reader")
        try:
            done, _ = await asyncio.wait(
                {writer_task, reader_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                with suppress(WebSocketDisconnect):
                    task.result()
            if reader_task in done and not writer_task.done() and peer.closing:
                # Flush terminal state/errors through the same writer before cleanup.
                with suppress(TimeoutError):
                    async with asyncio.timeout(settings.send_timeout):
                        await asyncio.shield(writer_task)
        except WebSocketDisconnect:
            pass
        finally:
            pending.discard(peer)
            if room is not None:
                await service.disconnect(room, peer)
            for task in (reader_task, writer_task):
                task.cancel()
            await asyncio.gather(reader_task, writer_task, return_exceptions=True)
            peers.discard(peer)

    return app


app = create_app()

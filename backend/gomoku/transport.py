import asyncio
import json
from dataclasses import dataclass

from starlette.websockets import WebSocket, WebSocketDisconnect

from .config import Settings


@dataclass(frozen=True)
class Close:
    code: int
    reason: str


class Peer:
    """Only writer() touches socket output. Producers never await network I/O."""

    def __init__(self, websocket: WebSocket, settings: Settings):
        self.websocket = websocket
        self.settings = settings
        self.queue: asyncio.Queue[str | Close] = asyncio.Queue(settings.send_queue_size)
        self.closing = False
        self.member_id = ""
        self.generation = 0
        self.last_seen = 0.0

    def emit(self, message: dict) -> bool:
        if self.closing:
            return False
        try:
            self.queue.put_nowait(json.dumps(message, separators=(",", ":"), ensure_ascii=False))
            return True
        except asyncio.QueueFull:
            self.stop(4008, "SLOW_CONSUMER", discard=True)
            return False

    def stop(self, code: int, reason: str, *, discard: bool = False) -> None:
        if self.closing:
            return
        if discard or self.queue.full():
            while not self.queue.empty():
                self.queue.get_nowait()
        if code != 1000 and self.queue.qsize() < self.settings.send_queue_size - 1:
            self.queue.put_nowait(json.dumps({"type": "error", "code": reason, "message": reason}))
        self.closing = True
        self.queue.put_nowait(Close(code, reason))

    async def writer(self) -> None:
        try:
            while True:
                item = await self.queue.get()
                async with asyncio.timeout(self.settings.send_timeout):
                    if isinstance(item, Close):
                        await self.websocket.close(code=item.code, reason=item.reason)
                        return
                    await self.websocket.send_text(item)
        except WebSocketDisconnect:
            pass
        except (TimeoutError, OSError, RuntimeError):
            # Interrupt a blocked receive as well; one writer still owns all output.
            try:
                async with asyncio.timeout(self.settings.send_timeout):
                    await self.websocket.close(code=4008, reason="SEND_FAILED")
            except (TimeoutError, OSError, RuntimeError, WebSocketDisconnect):
                pass
        finally:
            self.closing = True

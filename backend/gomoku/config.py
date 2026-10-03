import time
from datetime import UTC, datetime

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GOMOKU_", env_file=".env", extra="ignore")

    allowed_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    frontend_url: str = "http://localhost:5173/"
    allow_missing_origin: bool = False
    admin_token: str = ""
    session_ttl: float = Field(default=86400, gt=0)
    reconnect_seconds: float = Field(default=60, gt=0)
    heartbeat_timeout: float = Field(default=60, gt=0)
    join_timeout: float = Field(default=10, gt=0)
    undo_seconds: float = Field(default=30, gt=0)
    undo_cooldown: float = Field(default=30, gt=0)
    waiting_seconds: float = Field(default=600, gt=0)
    idle_seconds: float = Field(default=900, gt=0)
    finished_seconds: float = Field(default=600, gt=0)
    empty_seconds: float = Field(default=300, gt=0)
    spectator_ttl: float = Field(default=300, gt=0)
    request_ttl: float = Field(default=900, gt=0)
    tick_seconds: float = Field(default=1, gt=0)
    send_timeout: float = Field(default=5, gt=0)
    max_sessions: int = Field(default=5000, gt=0)
    max_rooms: int = Field(default=50, gt=0)
    max_owned_rooms: int = Field(default=3, gt=0)
    max_create_keys: int = Field(default=32, gt=0)
    max_spectators: int = Field(default=20, gt=0)
    max_spectator_records: int = Field(default=100, gt=0)
    max_connections: int = Field(default=200, gt=0)
    reconnect_reserve: int = Field(default=20, ge=0)
    max_pending_connections: int = Field(default=40, gt=0)
    max_message_bytes: int = Field(default=4096, gt=0)
    send_queue_size: int = Field(default=32, ge=2)
    max_request_records: int = Field(default=256, gt=0)
    source_burst: int = Field(default=60, gt=0)
    source_per_second: float = Field(default=1, gt=0)
    max_rate_keys: int = Field(default=10000, gt=0)
    command_burst: int = Field(default=20, gt=0)
    command_per_second: float = Field(default=5, gt=0)
    max_invalid_messages: int = Field(default=5, gt=0)

    @field_validator("allowed_origins")
    @classmethod
    def explicit_origins(cls, value: list[str]) -> list[str]:
        from urllib.parse import urlsplit

        for origin in value:
            url = urlsplit(origin)
            if (
                url.scheme not in {"http", "https"}
                or not url.netloc
                or url.path
                or url.query
                or url.fragment
                or url.username
            ):
                raise ValueError("Origins must be explicit http(s) origins without paths")
        return value

    @field_validator("frontend_url")
    @classmethod
    def frontend_base(cls, value: str) -> str:
        from urllib.parse import urlsplit

        url = urlsplit(value)
        if (
            url.scheme not in {"http", "https"}
            or not url.netloc
            or url.query
            or url.fragment
            or url.username
        ):
            raise ValueError("frontend_url must be an http(s) base URL without query or fragment")
        return value.rstrip("/") + "/"


class Clock:
    """Monotonic deadlines, projected onto UTC only when serializing."""

    def now(self) -> float:
        return time.monotonic()

    def utc(self, deadline: float | None = None) -> str | None:
        if deadline is None:
            return None
        timestamp = time.time() + deadline - self.now()
        return datetime.fromtimestamp(timestamp, UTC).isoformat().replace("+00:00", "Z")

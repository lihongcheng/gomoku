from dataclasses import dataclass

from .protocol import GameError


@dataclass
class Bucket:
    tokens: float
    updated_at: float


class RateLimiter:
    """Bounded token buckets. Unknown sources cannot evict an exhausted bucket."""

    def __init__(self, capacity: int, rate: float, max_keys: int):
        self.capacity = capacity
        self.rate = rate
        self.max_keys = max_keys
        self.buckets: dict[str, Bucket] = {}

    def prune(self, now: float) -> None:
        for key, bucket in list(self.buckets.items()):
            if now - bucket.updated_at >= self.capacity / self.rate:
                del self.buckets[key]

    def take(self, key: str, now: float) -> None:
        bucket = self.buckets.get(key)
        if bucket is None:
            if len(self.buckets) >= self.max_keys:
                self.prune(now)
            if len(self.buckets) >= self.max_keys:
                raise GameError("RATE_LIMITED", "Too many active sources", 429)
            bucket = self.buckets[key] = Bucket(float(self.capacity), now)
        bucket.tokens = min(
            self.capacity, bucket.tokens + max(0, now - bucket.updated_at) * self.rate
        )
        bucket.updated_at = now
        if bucket.tokens < 1:
            raise GameError("RATE_LIMITED", "Please slow down", 429)
        bucket.tokens -= 1

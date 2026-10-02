"""Run events: kept per run for late subscribers, fanned out to live SSE streams.

The spine publishes from worker threads; subscribers read on the event loop.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import threading
from collections.abc import AsyncIterator
from typing import Any

MAX_EVENTS_PER_RUN = 5000


class EventHub:
    def __init__(self) -> None:
        self._events: dict[str, list[dict[str, Any]]] = {}
        self._subscribers: dict[str, list[tuple[asyncio.AbstractEventLoop, asyncio.Queue[dict[str, Any]]]]] = {}
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    def publish(self, run_id: str, kind: str, payload: dict[str, Any]) -> None:
        event = {"id": next(self._ids), "event": kind, "data": payload}
        with self._lock:
            history = self._events.setdefault(run_id, [])
            history.append(event)
            del history[:-MAX_EVENTS_PER_RUN]
            subscribers = list(self._subscribers.get(run_id, []))
        for loop, queue in subscribers:
            loop.call_soon_threadsafe(queue.put_nowait, event)

    def history(self, run_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._events.get(run_id, []))

    async def stream(self, run_id: str, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        with self._lock:
            backlog = [e for e in self._events.get(run_id, []) if e["id"] > after]
            self._subscribers.setdefault(run_id, []).append((loop, queue))
        try:
            seen = after
            for event in backlog:
                seen = event["id"]
                yield event
            while True:
                event = await queue.get()
                if event["id"] > seen:
                    seen = event["id"]
                    yield event
        finally:
            with self._lock:
                self._subscribers[run_id] = [s for s in self._subscribers.get(run_id, []) if s[1] is not queue]


def sse_message(event: dict[str, Any]) -> dict[str, str]:
    return {"id": str(event["id"]), "event": event["event"], "data": json.dumps(event["data"], default=str)}

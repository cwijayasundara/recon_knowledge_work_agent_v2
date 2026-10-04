"""In-memory, thread-safe session store. Unknown, expired and other-actor lookups are indistinguishable."""

from __future__ import annotations

import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


class TooManySessions(Exception):
    pass


class SessionNotFound(KeyError):
    """Unknown, expired, other-actor or deleted: one error for all, so callers cannot tell them apart."""


_READ_ONLY = frozenset({"id", "actor", "run_id", "created"})


@dataclass(eq=False)
class Session:
    id: str
    actor: str
    run_id: str | None
    created: float
    last_used: float
    messages: list[Any] = field(default_factory=list)
    cells_read: int = 0
    steps_in_turn: int = 0
    pending: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict)
    # Proposals not yet delivered in a final answer; cleared once a final answer carries them.
    proposed_changes: list[Any] = field(default_factory=list)
    proposed_writes: list[Any] = field(default_factory=list)
    proposal_notes: list[str] = field(default_factory=list)
    # Per-turn counters for server work the model can trigger (reset on each user message).
    dry_runs_in_turn: int = 0
    proposals_in_turn: int = 0
    # Set when the session is closed; a step that looked it up just before must not run on it.
    closed: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in _READ_ONLY and name in self.__dict__:
            raise AttributeError(f"{name} is read-only")
        super().__setattr__(name, value)


class SessionStore:
    def __init__(
        self,
        ttl_s: float,
        max_per_actor: int,
        clock: Callable[[], float] = time.monotonic,
        max_total: int = 10_000,
        max_lifetime_s: float = 43_200,
    ) -> None:
        self.max_lifetime_s = max_lifetime_s
        self._ttl = ttl_s
        self._max = max_per_actor
        self._max_total = max_total
        self._clock = clock
        self._lock = threading.Lock()
        self._sessions: dict[str, Session] = {}

    def _expired(self, s: Session, now: float) -> bool:
        return now - s.last_used >= self._ttl or now - s.created >= self.max_lifetime_s

    def _remove_locked(self, session_id: str) -> None:
        self._sessions.pop(session_id).closed = True

    def _sweep_locked(self, now: float) -> int:
        # A session whose step is running keeps its slot; it is swept on a later pass.
        dead = [k for k, s in self._sessions.items() if self._expired(s, now) and not s.lock.locked()]
        for k in dead:
            self._remove_locked(k)
        return len(dead)

    def sweep(self) -> int:
        with self._lock:
            return self._sweep_locked(self._clock())

    def create(self, actor: str, run_id: str | None) -> Session:
        with self._lock:
            now = self._clock()
            self._sweep_locked(now)
            if len(self._sessions) >= self._max_total:
                raise TooManySessions("too many sessions")
            if sum(1 for s in self._sessions.values() if s.actor == actor) >= self._max:
                raise TooManySessions("too many sessions for this actor")
            created = self._clock()
            sess = Session(secrets.token_urlsafe(24), actor, run_id, created=created, last_used=created)
            self._sessions[sess.id] = sess
            return sess

    def get(self, session_id: str, actor: str) -> Session:
        with self._lock:
            now = self._clock()
            sess = self._sessions.get(session_id)
            if sess is None or sess.actor != actor or self._expired(sess, now):
                if sess is not None and self._expired(sess, now) and not sess.lock.locked():
                    self._remove_locked(session_id)
                raise SessionNotFound("session not found")
            sess.last_used = now
            return sess

    def delete(self, session_id: str, actor: str) -> bool:
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is not None and sess.actor == actor:
                self._remove_locked(session_id)
                return True
            return False

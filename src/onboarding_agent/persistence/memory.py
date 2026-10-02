"""In-memory stores (tests, offline CLI) and the local-directory object store."""

from __future__ import annotations

import threading
from dataclasses import replace
from pathlib import Path
from typing import Any

from .interfaces import (
    ArtifactRecord,
    DecisionRecord,
    RecipeRecord,
    RunLocked,
    RunRecord,
    Stores,
    now,
)


class MemoryRunStore:
    def __init__(self) -> None:
        self._runs: dict[str, RunRecord] = {}

    def create(self, run: RunRecord) -> None:
        if run.id in self._runs:
            raise ValueError(f"run {run.id} exists")
        self._runs[run.id] = run

    def get(self, run_id: str) -> RunRecord | None:
        return self._runs.get(run_id)

    def set_status(self, run_id: str, status: str) -> None:
        run = self._runs[run_id]
        if run.status == "locked":
            raise RunLocked(run_id)
        self._runs[run_id] = replace(run, status=status, updated_at=now())

    def list(self, sponsor_id: str | None = None) -> list[RunRecord]:
        return [r for r in self._runs.values() if sponsor_id in (None, r.sponsor_id)]


class MemoryDecisionLog:
    def __init__(self) -> None:
        self._items: dict[str, list[DecisionRecord]] = {}
        self._lock = threading.Lock()

    def append(self, run_id: str, kind: str, payload: dict[str, Any], actor: str) -> DecisionRecord:
        with self._lock:
            items = self._items.setdefault(run_id, [])
            record = DecisionRecord(run_id, len(items) + 1, kind, payload, actor, now())
            items.append(record)
            return record

    def list(self, run_id: str) -> list[DecisionRecord]:
        return list(self._items.get(run_id, []))


class MemoryRecipeStore:
    def __init__(self) -> None:
        self._items: list[RecipeRecord] = []

    def find_active(self, sponsor_id: str, entity: str, fingerprint: str) -> RecipeRecord | None:
        for record in reversed(self._items):
            if (record.sponsor_id, record.entity, record.fingerprint, record.active) == (
                sponsor_id,
                entity,
                fingerprint,
                True,
            ):
                return record
        return None

    def save(self, record: RecipeRecord) -> RecipeRecord:
        key = (record.sponsor_id, record.entity, record.fingerprint)
        versions = [r.version for r in self._items if (r.sponsor_id, r.entity, r.fingerprint) == key]
        self._items = [
            replace(r, active=False) if (r.sponsor_id, r.entity, r.fingerprint) == key else r for r in self._items
        ]
        saved = replace(record, version=max(versions, default=0) + 1, active=True)
        self._items.append(saved)
        return saved

    def list(self, sponsor_id: str) -> list[RecipeRecord]:
        return [r for r in self._items if r.sponsor_id == sponsor_id]


class MemoryArtifactStore:
    def __init__(self) -> None:
        self._items: dict[str, dict[str, ArtifactRecord]] = {}

    def add(self, record: ArtifactRecord) -> None:
        self._items.setdefault(record.run_id, {})[record.name] = record

    def list(self, run_id: str) -> list[ArtifactRecord]:
        return list(self._items.get(run_id, {}).values())


class MemorySponsorStore:
    def __init__(self) -> None:
        self._items: dict[str, str] = {}

    def add(self, sponsor_id: str, name: str) -> None:
        if not sponsor_id.strip() or sponsor_id == "*":
            raise ValueError("invalid sponsor id")
        self._items[sponsor_id] = name

    def list(self) -> list[dict[str, str]]:
        return [{"id": k, "name": v} for k, v in sorted(self._items.items())]


class LocalObjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def local_path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root not in path.parents:
            raise ValueError(f"object key {key!r} escapes the store")
        return path

    def put(self, key: str, data: bytes) -> str:
        path = self.local_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return f"file://{path}"

    def get(self, key: str) -> bytes:
        return self.local_path(key).read_bytes()


def memory_stores(object_root: Path) -> Stores:
    return Stores(
        runs=MemoryRunStore(),
        decisions=MemoryDecisionLog(),
        recipes=MemoryRecipeStore(),
        artifacts=MemoryArtifactStore(),
        sponsors=MemorySponsorStore(),
        objects=LocalObjectStore(object_root),
    )

"""Persistence contracts. In-memory implementations back the tests; Postgres backs runs."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol


def now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@dataclass(frozen=True, slots=True)
class RunRecord:
    id: str
    sponsor_id: str
    entity: str
    status: str
    upload_uri: str
    upload_sha: str
    fingerprint: str
    created_by: str
    created_at: str
    updated_at: str
    upload_name: str = ""


@dataclass(frozen=True, slots=True)
class DecisionRecord:
    run_id: str
    seq: int
    kind: str
    payload: dict[str, Any]
    actor: str
    at: str


@dataclass(frozen=True, slots=True)
class RecipeRecord:
    id: str
    sponsor_id: str
    entity: str
    fingerprint: str
    version: int
    sha256: str
    source_uri: str
    origin: str
    approved_by: str
    approved_at: str
    active: bool = True
    bindings: dict[str, str | None] = field(default_factory=dict)
    layout: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    run_id: str
    name: str
    uri: str
    sha256: str
    kind: str


class RunStore(Protocol):
    def create(self, run: RunRecord) -> None: ...
    def get(self, run_id: str) -> RunRecord | None: ...
    def set_status(self, run_id: str, status: str) -> None: ...
    def list(self, sponsor_id: str | None = None) -> list[RunRecord]: ...


class DecisionLog(Protocol):
    def append(self, run_id: str, kind: str, payload: dict[str, Any], actor: str) -> DecisionRecord: ...
    def list(self, run_id: str) -> list[DecisionRecord]: ...


class RecipeStore(Protocol):
    def find_active(self, sponsor_id: str, entity: str, fingerprint: str) -> RecipeRecord | None: ...
    def save(self, record: RecipeRecord) -> RecipeRecord: ...
    def list(self, sponsor_id: str) -> list[RecipeRecord]: ...


class ArtifactStore(Protocol):
    def add(self, record: ArtifactRecord) -> None: ...
    def list(self, run_id: str) -> list[ArtifactRecord]: ...


class SponsorStore(Protocol):
    def add(self, sponsor_id: str, name: str) -> None: ...
    def list(self) -> list[dict[str, str]]: ...


class ObjectStore(Protocol):
    def put(self, key: str, data: bytes) -> str: ...
    def get(self, key: str) -> bytes: ...
    def local_path(self, key: str) -> Path: ...


@dataclass(frozen=True, slots=True)
class Stores:
    runs: RunStore
    decisions: DecisionLog
    recipes: RecipeStore
    artifacts: ArtifactStore
    sponsors: SponsorStore
    objects: ObjectStore


class RunLocked(RuntimeError):
    """A locked run is immutable."""

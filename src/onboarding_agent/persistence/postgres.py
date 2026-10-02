"""Postgres stores. One pool, plain SQL, JSON payloads as jsonb."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .interfaces import (
    ArtifactRecord,
    DecisionRecord,
    ObjectStore,
    RecipeRecord,
    RunLocked,
    RunRecord,
    Stores,
)

MIGRATIONS = Path(__file__).parent / "migrations"


def _iso(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value)


def migrate(pool: ConnectionPool) -> None:
    with pool.connection() as conn:
        for path in sorted(MIGRATIONS.glob("*.sql")):
            conn.execute(path.read_text())


class PostgresRunStore:
    def __init__(self, pool: ConnectionPool) -> None:
        self.pool = pool

    def create(self, run: RunRecord) -> None:
        with self.pool.connection() as conn:
            conn.execute(
                "INSERT INTO runs (id, sponsor_id, entity, status, upload_uri, upload_name, upload_sha,"
                " fingerprint, created_by) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    run.id,
                    run.sponsor_id,
                    run.entity,
                    run.status,
                    run.upload_uri,
                    run.upload_name,
                    run.upload_sha,
                    run.fingerprint,
                    run.created_by,
                ),
            )

    def _row(self, row: dict[str, Any]) -> RunRecord:
        return RunRecord(
            id=row["id"],
            sponsor_id=row["sponsor_id"],
            entity=row["entity"],
            status=row["status"],
            upload_uri=row["upload_uri"],
            upload_sha=row["upload_sha"],
            fingerprint=row["fingerprint"],
            created_by=row["created_by"],
            created_at=_iso(row["created_at"]),
            updated_at=_iso(row["updated_at"]),
            upload_name=row["upload_name"],
        )

    def get(self, run_id: str) -> RunRecord | None:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            row = cur.execute("SELECT * FROM runs WHERE id = %s", (run_id,)).fetchone()
        return self._row(row) if row else None

    def set_status(self, run_id: str, status: str) -> None:
        with self.pool.connection() as conn:
            updated = conn.execute(
                "UPDATE runs SET status = %s, updated_at = now() WHERE id = %s AND status <> 'locked'",
                (status, run_id),
            )
            if updated.rowcount == 0:
                raise RunLocked(run_id)

    def list(self, sponsor_id: str | None = None) -> list[RunRecord]:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            if sponsor_id is None:
                rows = cur.execute("SELECT * FROM runs ORDER BY created_at DESC").fetchall()
            else:
                rows = cur.execute(
                    "SELECT * FROM runs WHERE sponsor_id = %s ORDER BY created_at DESC",
                    (sponsor_id,),
                ).fetchall()
        return [self._row(r) for r in rows]


class PostgresDecisionLog:
    def __init__(self, pool: ConnectionPool) -> None:
        self.pool = pool

    def append(self, run_id: str, kind: str, payload: dict[str, Any], actor: str) -> DecisionRecord:
        with (
            self.pool.connection() as conn,
            conn.transaction(),
            conn.cursor(row_factory=dict_row) as cur,
        ):
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (run_id,))
            row = cur.execute(
                "INSERT INTO run_decisions (run_id, seq, kind, payload, actor) VALUES"
                " (%s, (SELECT coalesce(max(seq), 0) + 1 FROM run_decisions WHERE run_id = %s),"
                " %s, %s, %s) RETURNING *",
                (run_id, run_id, kind, Jsonb(payload), actor),
            ).fetchone()
        assert row is not None
        return DecisionRecord(row["run_id"], row["seq"], row["kind"], row["payload"], row["actor"], _iso(row["at"]))

    def list(self, run_id: str) -> list[DecisionRecord]:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            rows = cur.execute("SELECT * FROM run_decisions WHERE run_id = %s ORDER BY seq", (run_id,)).fetchall()
        return [DecisionRecord(r["run_id"], r["seq"], r["kind"], r["payload"], r["actor"], _iso(r["at"])) for r in rows]


class PostgresRecipeStore:
    def __init__(self, pool: ConnectionPool) -> None:
        self.pool = pool

    def _row(self, r: dict[str, Any]) -> RecipeRecord:
        return RecipeRecord(
            id=r["id"],
            sponsor_id=r["sponsor_id"],
            entity=r["entity"],
            fingerprint=r["fingerprint"],
            version=r["version"],
            sha256=r["sha256"],
            source_uri=r["source_uri"],
            origin=r["origin"],
            approved_by=r["approved_by"],
            approved_at=_iso(r["approved_at"]),
            active=r["active"],
            bindings=r["bindings"],
            layout=r["layout"],
        )

    def find_active(self, sponsor_id: str, entity: str, fingerprint: str) -> RecipeRecord | None:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            row = cur.execute(
                "SELECT * FROM recipes WHERE sponsor_id=%s AND entity=%s AND fingerprint=%s AND active",
                (sponsor_id, entity, fingerprint),
            ).fetchone()
        return self._row(row) if row else None

    def save(self, record: RecipeRecord) -> RecipeRecord:
        key = (record.sponsor_id, record.entity, record.fingerprint)
        with (
            self.pool.connection() as conn,
            conn.transaction(),
            conn.cursor(row_factory=dict_row) as cur,
        ):
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("|".join(key),))
            cur.execute(
                "UPDATE recipes SET active = false WHERE sponsor_id=%s AND entity=%s AND fingerprint=%s",
                key,
            )
            row = cur.execute(
                "INSERT INTO recipes (id, sponsor_id, entity, fingerprint, version, sha256, source_uri,"
                " origin, bindings, layout, approved_by, approved_at, active) VALUES (%s,%s,%s,%s,"
                " (SELECT coalesce(max(version),0)+1 FROM recipes WHERE sponsor_id=%s AND entity=%s"
                " AND fingerprint=%s), %s,%s,%s,%s,%s,%s,%s,true) RETURNING *",
                (
                    record.id,
                    *key,
                    *key,
                    record.sha256,
                    record.source_uri,
                    record.origin,
                    Jsonb(record.bindings),
                    Jsonb(record.layout),
                    record.approved_by,
                    record.approved_at,
                ),
            ).fetchone()
        assert row is not None
        return self._row(row)

    def list(self, sponsor_id: str) -> list[RecipeRecord]:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            rows = cur.execute(
                "SELECT * FROM recipes WHERE sponsor_id=%s ORDER BY fingerprint, version",
                (sponsor_id,),
            ).fetchall()
        return [self._row(r) for r in rows]


class PostgresArtifactStore:
    def __init__(self, pool: ConnectionPool) -> None:
        self.pool = pool

    def add(self, record: ArtifactRecord) -> None:
        with self.pool.connection() as conn:
            conn.execute(
                "INSERT INTO artifacts (run_id, name, uri, sha256, kind) VALUES (%s,%s,%s,%s,%s)"
                " ON CONFLICT (run_id, name) DO UPDATE SET uri=EXCLUDED.uri, sha256=EXCLUDED.sha256,"
                " kind=EXCLUDED.kind",
                (record.run_id, record.name, record.uri, record.sha256, record.kind),
            )

    def list(self, run_id: str) -> list[ArtifactRecord]:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            rows = cur.execute("SELECT * FROM artifacts WHERE run_id=%s ORDER BY name", (run_id,)).fetchall()
        return [ArtifactRecord(r["run_id"], r["name"], r["uri"], r["sha256"], r["kind"]) for r in rows]


class PostgresSponsorStore:
    def __init__(self, pool: ConnectionPool) -> None:
        self.pool = pool

    def add(self, sponsor_id: str, name: str) -> None:
        with self.pool.connection() as conn:
            conn.execute(
                "INSERT INTO sponsors (id, name) VALUES (%s, %s) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name",
                (sponsor_id, name),
            )

    def list(self) -> list[dict[str, str]]:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            rows = cur.execute("SELECT id, name FROM sponsors ORDER BY id").fetchall()
        return [{"id": r["id"], "name": r["name"]} for r in rows]


def postgres_stores(database_url: str, objects: ObjectStore) -> tuple[Stores, ConnectionPool]:
    pool = ConnectionPool(database_url, min_size=1, max_size=8, kwargs={"autocommit": True}, open=True)
    migrate(pool)
    stores = Stores(
        runs=PostgresRunStore(pool),
        decisions=PostgresDecisionLog(pool),
        recipes=PostgresRecipeStore(pool),
        artifacts=PostgresArtifactStore(pool),
        sponsors=PostgresSponsorStore(pool),
        objects=objects,
    )
    return stores, pool

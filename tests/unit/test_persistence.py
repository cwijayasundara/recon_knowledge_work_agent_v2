from __future__ import annotations

import os
from pathlib import Path

import pytest

from onboarding_agent.persistence.interfaces import (
    ArtifactRecord,
    RecipeRecord,
    RunLocked,
    RunRecord,
    Stores,
    now,
)
from onboarding_agent.persistence.memory import LocalObjectStore, memory_stores

# A separate database on the docker-compose Postgres; scripts/setup-docker.sh creates it.
TEST_DATABASE_URL = "postgresql://onboarding:onboarding@localhost:55433/onboarding_test"


def _stores(kind: str, tmp_path: Path) -> Stores:
    if kind == "memory":
        return memory_stores(tmp_path)
    url = os.environ.get("ONB_TEST_DATABASE_URL", TEST_DATABASE_URL)
    # These tests write run records; never let them land in the workbench's own database.
    if not url.rsplit("?", 1)[0].rstrip("/").rsplit("/", 1)[-1].endswith("_test"):
        pytest.fail(f"ONB_TEST_DATABASE_URL must name a *_test database, got {url!r}")
    from onboarding_agent.persistence.postgres import postgres_stores

    stores, _ = postgres_stores(url, LocalObjectStore(tmp_path))
    return stores


@pytest.fixture(params=["memory", pytest.param("postgres", marks=pytest.mark.db)])
def stores(request: pytest.FixtureRequest, tmp_path: Path) -> Stores:
    return _stores(request.param, tmp_path)


def _run(run_id: str) -> RunRecord:
    return RunRecord(
        run_id,
        "sponsor-a",
        "affiliate",
        "created",
        "file:///x",
        "0" * 64,
        "fp",
        "analyst",
        now(),
        now(),
        "x.csv",
    )


def test_runs_and_lock(stores: Stores) -> None:
    import uuid

    run_id = f"run-{uuid.uuid4()}"
    stores.runs.create(_run(run_id))
    stores.runs.set_status(run_id, "locked")
    got = stores.runs.get(run_id)
    assert got is not None and got.status == "locked"
    with pytest.raises(RunLocked):
        stores.runs.set_status(run_id, "created")


def test_decisions_are_sequenced(stores: Stores) -> None:
    import uuid

    run_id = f"run-{uuid.uuid4()}"
    stores.runs.create(_run(run_id))
    a = stores.decisions.append(run_id, "approve", {"gate": "brief"}, "analyst")
    b = stores.decisions.append(run_id, "change", {"n": 1}, "analyst")
    assert (a.seq, b.seq) == (1, 2)
    assert [d.kind for d in stores.decisions.list(run_id)] == ["approve", "change"]


def test_recipe_versions_and_single_active(stores: Stores) -> None:
    import uuid

    fp = f"fp-{uuid.uuid4()}"

    def rec(i: int) -> RecipeRecord:
        return RecipeRecord(
            f"rcp-{uuid.uuid4()}",
            "sponsor-a",
            "affiliate",
            fp,
            0,
            "a" * 64,
            "file:///r",
            "standard",
            "analyst",
            now(),
            bindings={"affiliate_id": None, "affiliate_name": "Name"},
            layout={"sheet": "S", "header_row": i},
        )

    first = stores.recipes.save(rec(1))
    second = stores.recipes.save(rec(2))
    assert (first.version, second.version) == (1, 2)
    active = stores.recipes.find_active("sponsor-a", "affiliate", fp)
    assert active is not None and active.id == second.id and active.layout["header_row"] == 2
    assert stores.recipes.find_active("sponsor-b", "affiliate", fp) is None


def test_artifacts_and_objects(stores: Stores, tmp_path: Path) -> None:
    import uuid

    run_id = f"run-{uuid.uuid4()}"
    stores.runs.create(_run(run_id))
    uri = stores.objects.put(f"runs/{run_id}/Affiliates.csv", b"x")
    stores.artifacts.add(ArtifactRecord(run_id, "Affiliates.csv", uri, "b" * 64, "csv"))
    assert [a.name for a in stores.artifacts.list(run_id)] == ["Affiliates.csv"]
    assert stores.objects.get(f"runs/{run_id}/Affiliates.csv") == b"x"
    with pytest.raises(ValueError):
        stores.objects.put("../escape", b"x")


def test_sponsor_guard(stores: Stores) -> None:
    stores.sponsors.add("sponsor-a", "Sponsor A")
    assert {"id": "sponsor-a", "name": "Sponsor A"} in stores.sponsors.list()

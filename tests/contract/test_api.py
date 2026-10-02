"""API contract with inline jobs and the scripted model."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from onboarding_agent.surfaces.api import create_app
from tests.conftest import FIXTURE_DIR
from tests.support.scripts import report_simple, scope_standard
from tests.support.services import Models, offline_services

H = {"X-Actor": "analyst@sponsor-a"}


@pytest.fixture
def setup(tmp_path: Path):  # type: ignore[no-untyped-def]
    models = Models()
    services = offline_services(tmp_path, models)
    app = create_app(services=services, inline_jobs=True)
    return TestClient(app), models


def _upload(client: TestClient, name: str, sponsor: str = "sponsor-a") -> str:
    with (FIXTURE_DIR / name).open("rb") as handle:
        r = client.post(
            "/runs", data={"sponsor_id": sponsor, "entity": "affiliate"}, files={"file": (name, handle)}, headers=H
        )
    assert r.status_code == 202, r.text
    return str(r.json()["run_id"])


def test_full_run_over_http(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    models.supervisor.script = scope_standard("clean.csv")
    run_id = _upload(client, "clean.csv")
    snap = client.get(f"/runs/{run_id}", headers=H).json()
    assert snap["pending"]["gate"] == "brief"
    assert snap["working"] is False

    grid = client.get(f"/runs/{run_id}/grid", params={"view": "source"}, headers=H).json()
    assert grid["rows"][0]["cells"][:2] == ["Affiliate ID", "Affiliate Name"]

    for gate in ("brief", "findings", "signoff"):
        assert client.get(f"/runs/{run_id}", headers=H).json()["pending"]["gate"] == gate
        assert client.post(f"/runs/{run_id}/gate", json={"action": "approve"}, headers=H).status_code == 202
    snap = client.get(f"/runs/{run_id}", headers=H).json()
    assert snap["status"] == "locked"
    assert [d["actor"] for d in snap["decisions"]][:3] == ["analyst@sponsor-a"] * 3

    csv = client.get(f"/runs/{run_id}/artifacts/Affiliates.csv", headers=H)
    assert csv.status_code == 200 and csv.content.startswith(b"ITEM_ID,NAME,ITEM_TYPE")
    assert client.get(f"/runs/{run_id}/artifacts/secrets.txt", headers=H).status_code == 404

    preview = client.get(f"/runs/{run_id}/grid", params={"view": "preview"}, headers=H).json()
    assert preview["total"] == 8
    assert preview["rows"][0]["lineage"]["ITEM_ID"]["source_column"] == "Affiliate ID"

    history = client.get("/sponsors/sponsor-a/history", headers=H).json()
    assert history["bindings"][0]["bindings"]["affiliate_name"] == "Affiliate Name"
    assert client.post(f"/runs/{run_id}/gate", json={"action": "approve"}, headers=H).status_code == 409


def test_dry_run_endpoint(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    models.supervisor.script = [*scope_standard("edge.csv"), *report_simple()]
    run_id = _upload(client, "edge.csv")
    client.post(f"/runs/{run_id}/gate", json={"action": "approve"}, headers=H)
    ok = client.post(
        f"/runs/{run_id}/dry-run",
        json={"changes": [{"kind": "override_item_id", "row": 4, "value": "AFF_9011"}]},
        headers=H,
    ).json()
    assert ok["violations"] == [] and ok["rows_changed"] == [4]
    bad = client.post(
        f"/runs/{run_id}/dry-run",
        json={"changes": [{"kind": "override_item_id", "row": 4, "value": "bad id"}]},
        headers=H,
    ).json()
    assert bad["violations"][0]["rule"] == "item_id.charset"


def test_upload_rejections_and_flow(setup) -> None:  # type: ignore[no-untyped-def]
    client, _ = setup
    r = client.post("/runs", data={"sponsor_id": "*"}, files={"file": ("a.csv", b"x")}, headers=H)
    assert r.status_code == 422
    flow = client.get("/flows/affiliate").json()
    assert [p["id"] for p in flow["phases"]] == ["p1", "p2", "p3", "p4"]
    assert client.get("/flows/investor").status_code == 404
    assert client.get("/sponsors/*/history", headers=H).status_code == 400


def test_bearer_token_required_when_configured(tmp_path: Path) -> None:
    models = Models()
    services = offline_services(tmp_path, models)
    services.settings.api_token = "dev-token-123"
    client = TestClient(create_app(services=services, inline_jobs=True))
    assert client.get("/runs").status_code == 401
    assert client.get("/runs", headers={"Authorization": "Bearer dev-token-123"}).status_code == 200


def test_events_history_is_recorded(setup) -> None:  # type: ignore[no-untyped-def]
    client, models = setup
    models.supervisor.script = scope_standard("clean.csv")
    run_id = _upload(client, "clean.csv")
    kinds = [e["event"] for e in client.app.state.hub.history(run_id)]  # type: ignore[attr-defined]
    assert {"step", "phase", "brief", "gate", "idle"} <= set(kinds)
    steps = {e["data"]["step_id"] for e in client.app.state.hub.history(run_id) if e["event"] == "step"}  # type: ignore[attr-defined]
    assert {"p1.upload", "p1.read"} <= steps


def test_easy_auth_principal_is_the_actor(tmp_path: Path) -> None:
    services = offline_services(tmp_path, Models())
    services.settings.trust_easy_auth = True
    client = TestClient(create_app(services=services, inline_jobs=True))
    assert client.get("/runs", headers={"X-Actor": "spoofed"}).status_code == 401
    assert client.get("/runs", headers={"X-MS-CLIENT-PRINCIPAL-NAME": "analyst@firm.example"}).status_code == 200


def test_seed_sponsors(tmp_path: Path) -> None:
    services = offline_services(tmp_path, Models())
    services.settings.seed_sponsors = "sponsor-a:Sponsor A, sponsor-b"
    client = TestClient(create_app(services=services, inline_jobs=True))
    assert client.get("/sponsors", headers=H).json() == [
        {"id": "sponsor-a", "name": "Sponsor A"},
        {"id": "sponsor-b", "name": "sponsor-b"},
    ]


def test_snapshot_without_checkpoint_falls_back_to_the_run_record(tmp_path: Path) -> None:
    models = Models()
    services = offline_services(tmp_path, models)
    models.supervisor.script = scope_standard("clean.csv")
    run_id = _upload(TestClient(create_app(services=services, inline_jobs=True)), "clean.csv")

    # A fresh app has a fresh in-memory checkpointer: the run record exists, its checkpoint does not.
    snap = TestClient(create_app(services=services, inline_jobs=True)).get(f"/runs/{run_id}", headers=H).json()
    assert snap["status"] == "starting"
    assert snap["sponsor_id"] == "sponsor-a"
    assert snap["upload"]["name"] == "clean.csv"
    assert snap["approvers"] == [] and snap["artifacts"] == [] and snap["options"]["item_type"] is None

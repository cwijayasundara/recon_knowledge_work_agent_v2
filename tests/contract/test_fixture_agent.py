"""The fixture agent drives the whole API flow for the browser tests' fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from onboarding_agent.surfaces.api import create_app
from tests.conftest import FIXTURE_DIR
from tests.support.fixture_agent import FixtureAgentModel
from tests.support.services import Models, offline_services

H = {"X-Actor": "analyst@sponsor-a"}


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    models = Models()
    models.supervisor = FixtureAgentModel()
    return TestClient(create_app(services=offline_services(tmp_path, models), inline_jobs=True))


def _run(client: TestClient, name: str) -> str:
    with (FIXTURE_DIR / name).open("rb") as f:
        return str(
            client.post("/runs", data={"sponsor_id": "sponsor-a"}, files={"file": (name, f)}, headers=H).json()[
                "run_id"
            ]
        )


def _gate(client: TestClient, run_id: str, **body) -> dict:  # type: ignore[no-untyped-def,type-arg]
    assert client.post(f"/runs/{run_id}/gate", json=body, headers=H).status_code == 202
    return client.get(f"/runs/{run_id}", headers=H).json()


def test_edge_file_fixed_through_the_api(client: TestClient) -> None:
    run_id = _run(client, "edge.csv")
    snap = _gate(client, run_id, action="approve")
    assert snap["pending"]["gate"] == "findings"
    assert snap["report"]["explanations"]["AFF_ERR_ITEM_ID_DUPLICATE"].startswith("Two different")
    snap = _gate(
        client,
        run_id,
        action="change",
        changes=[
            {"kind": "exclude_row", "row": 1, "reason": "blank"},
            {"kind": "override_item_id", "row": 2, "value": "AFF_9999"},
            {"kind": "override_item_id", "row": 4, "value": "AFF_9011"},
            {"kind": "override_item_id", "row": 6, "value": "CASCADE_EMP_COINV_BETA"},
        ],
    )
    acks = [
        {"kind": "acknowledge_finding", "code": f["code"], "row": f["row"]}
        for f in snap["result"]["findings"]
        if f["requires_ack"]
    ]
    snap = _gate(client, run_id, action="change", changes=acks)
    assert snap["pending"]["blocked_reasons"] == []
    snap = _gate(client, run_id, action="approve")
    snap = _gate(client, run_id, action="approve")
    assert snap["status"] == "locked"


def test_two_sheets_question_then_instruction(client: TestClient) -> None:
    run_id = _run(client, "two_sheets.xlsx")
    snap = client.get(f"/runs/{run_id}", headers=H).json()
    assert len(snap["brief"]["questions"]) == 1
    snap = _gate(client, run_id, action="answer", question_id="q1", option="Affiliates")
    assert snap["brief"]["questions"] == []
    snap = _gate(client, run_id, action="approve")
    snap = _gate(client, run_id, action="instruct", text="exclude row 2")
    assert snap["proposal"]["changes"][0]["kind"] == "exclude_row"
    snap = _gate(client, run_id, action="change", changes=snap["proposal"]["changes"])
    assert snap["options"]["excluded_rows"] == {"2": "exclude row 2"}

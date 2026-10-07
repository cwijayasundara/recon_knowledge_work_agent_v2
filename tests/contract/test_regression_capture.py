"""R2: finalize captures correction cases into the object store, reading only.

An ``edge.csv`` run whose analyst overrides IDs (the fixture's fixes) locks and
leaves a case whose ``outcome.csv_sha256`` is the run's Affiliates.csv artifact
sha; the decision log, artifact list and manifest are untouched. With
``ONB_REGRESSION_CAPTURE=false`` nothing is written, and a rejected run —
which never locks — captures nothing either way.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from onboarding_agent.graph.build import Workbench
from onboarding_agent.regression import RegressionCase, case_key
from tests.conftest import FIXTURE_DIR
from tests.support.pipeline import expected
from tests.support.services import Models, offline_services

ANALYST = "analyst@sponsor-a"


def _bench(tmp_path: Path, **settings: Any) -> Workbench:
    return Workbench(offline_services(tmp_path, Models(), **settings))


def _start(bench: Workbench, name: str) -> str:
    return bench.start(
        sponsor_id="sponsor-a",
        entity="affiliate",
        file_name=name,
        data=(FIXTURE_DIR / name).read_bytes(),
        actor=ANALYST,
    )


def _gate(snap: dict[str, Any]) -> str | None:
    return (snap.get("pending") or {}).get("gate")


def _correct_and_lock(bench: Workbench, run_id: str, name: str) -> dict[str, Any]:
    """Approve the fast-path brief, apply the fixture's fixes (an ID override
    among them), acknowledge the warnings, then approve through sign-off."""
    snap = bench.respond(run_id, {"action": "approve", "actor": ANALYST})
    for _ in range(12):
        if _gate(snap) is None:
            return snap
        if _gate(snap) == "findings" and any(f["severity"] == "error" for f in snap["result"]["findings"]):
            snap = bench.respond(run_id, {"action": "change", "actor": ANALYST, "changes": expected(name)["fixes"]})
            continue
        if _gate(snap) == "findings":
            acks = [
                {"kind": "acknowledge_finding", "code": f["code"], "row": f["row"]}
                for f in snap["result"]["findings"]
                if f["requires_ack"] and not f["acknowledged"]
            ]
            if acks:
                snap = bench.respond(run_id, {"action": "change", "actor": ANALYST, "changes": acks})
                continue
        snap = bench.respond(run_id, {"action": "approve", "actor": ANALYST})
    raise AssertionError("the run did not finish within 12 gate steps")


def test_edge_run_with_id_override_locks_and_leaves_a_case(tmp_path: Path) -> None:
    bench = _bench(tmp_path)
    run_id = _start(bench, "edge.csv")
    snap = _correct_and_lock(bench, run_id, "edge.csv")
    assert snap["status"] == "locked" and snap["model_calls"] == 0  # capture added no agent

    stored = bench.services.stores.objects.get(case_key("sponsor-a", run_id))
    case = RegressionCase.model_validate(json.loads(stored))  # the stored case validates
    raw = json.loads(stored)

    assert case.run_id == run_id
    assert case.sponsor_id == "sponsor-a" and case.entity == "affiliate"
    assert case.fixture == "edge.csv"
    assert case.upload.sha256 == hashlib.sha256((FIXTURE_DIR / "edge.csv").read_bytes()).hexdigest()
    assert case.outcome.status == "locked"
    assert case.outcome.bindings == expected("edge.csv")["bindings"]
    # Distinct codes of the final result's findings, sorted.
    assert case.outcome.finding_codes == sorted({f["code"] for f in snap["result"]["findings"]})
    # outcome.csv_sha256 is the run's Affiliates.csv artifact sha.
    artifacts = {a["name"]: a for a in snap["artifacts"]}
    assert case.outcome.csv_sha256 == artifacts["Affiliates.csv"]["sha256"]
    # The corrections are the steps: the fixes, then the acknowledgements.
    assert [s.kind for s in case.steps] == ["findings.change", "findings.change"]
    assert raw["steps"][0]["payload"]["changes"] == expected("edge.csv")["fixes"]

    # Capture reads only: the decision log, artifacts and manifest are untouched.
    log = bench.services.stores.decisions.list(run_id)
    assert [d.kind for d in log] == [
        "brief.approve",
        "findings.change",
        "findings.change",
        "findings.approve",
        "signoff.approve",
        "run.locked",
    ]
    assert [r.name for r in bench.services.stores.artifacts.list(run_id)] == [
        "Affiliates.csv",
        "review.xlsx",
        "manifest.json",
    ]
    manifest = json.loads(bench.services.stores.objects.get(f"runs/{run_id}/outputs/manifest.json"))
    assert "regression" not in json.dumps(manifest)


def test_capture_off_writes_nothing(tmp_path: Path) -> None:
    bench = _bench(tmp_path, regression_capture=False)
    run_id = _start(bench, "edge.csv")
    snap = _correct_and_lock(bench, run_id, "edge.csv")
    assert snap["status"] == "locked"
    with pytest.raises(FileNotFoundError):
        bench.services.stores.objects.get(case_key("sponsor-a", run_id))


def test_rejected_run_captures_nothing(tmp_path: Path) -> None:
    bench = _bench(tmp_path)
    run_id = _start(bench, "clean.csv")
    snap = bench.respond(run_id, {"action": "reject", "actor": ANALYST})
    assert snap["status"] == "rejected"
    with pytest.raises(FileNotFoundError):
        bench.services.stores.objects.get(case_key("sponsor-a", run_id))

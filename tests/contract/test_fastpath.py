"""F3: an unambiguous upload goes resolve → gate_brief on a code-drafted brief.

The six clean fixtures complete with the scripted model never invoked and byte-identical
outputs; two_sheets.xlsx and renamed.xlsx still scope with the supervisor; an instruct at
the brief gate hands the run to the supervisor with the analyst's words.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from onboarding_agent.graph.build import Workbench
from onboarding_agent.graph.fastpath import SUMMARY
from tests.conftest import FIXTURE_DIR
from tests.golden.test_affiliate_golden import _csv_bytes
from tests.support.pipeline import expected
from tests.support.scripts import scope_standard
from tests.support.services import Models, offline_services

ANALYST = "analyst@sponsor-a"
# The plan's six zero-model-call fixtures. two_sheets.xlsx and renamed.xlsx are
# deliberately absent: they must still reach scope with the supervisor.
SIX = ["clean.csv", "extra_columns.csv", "titled.xlsx", "edge.csv", "ids_missing.csv", "empty.csv"]
AMBIGUOUS = ["two_sheets.xlsx", "renamed.xlsx"]


def _start(bench: Workbench, name: str) -> str:
    return bench.start(
        sponsor_id="sponsor-a",
        entity="affiliate",
        file_name=name,
        data=(FIXTURE_DIR / name).read_bytes(),
        actor=ANALYST,
    )


def _gate(snap: dict) -> str | None:  # type: ignore[type-arg]
    return (snap.get("pending") or {}).get("gate")


def _approve(bench: Workbench, run_id: str) -> dict:  # type: ignore[type-arg]
    return bench.respond(run_id, {"action": "approve", "actor": ANALYST})


def _scripted_analyst(bench: Workbench, run_id: str, name: str) -> tuple[dict, list[dict]]:  # type: ignore[type-arg]
    """Approve the brief, apply the expected fixes, acknowledge warnings — the live
    eval's analyst loop, offline. Returns the final snapshot and the findings-gate
    snapshots in visit order (the first visit is the uncorrected result)."""
    spec = expected(name)
    snap = bench.snapshot(run_id)
    visits: list[dict] = []  # type: ignore[type-arg]
    for _ in range(12):
        pending = snap.get("pending")
        if pending is None:
            return snap, visits
        if pending["gate"] == "findings":
            visits.append(snap)
            findings = snap["result"]["findings"]
            if spec.get("fixes") and any(f["severity"] == "error" for f in findings):
                snap = bench.respond(run_id, {"action": "change", "actor": ANALYST, "changes": spec["fixes"]})
                continue
            acks = [
                {"kind": "acknowledge_finding", "code": f["code"], "row": f["row"]}
                for f in findings
                if f["requires_ack"] and not f["acknowledged"]
            ]
            if acks:
                snap = bench.respond(run_id, {"action": "change", "actor": ANALYST, "changes": acks})
                continue
        snap = _approve(bench, run_id)
    raise AssertionError("the run did not finish within 12 gate steps")


def _assert_model_never_ran(models: Models, caplog: pytest.LogCaptureFixture) -> None:
    # No scripted step was consumed, and no message was ever handed to a model.
    assert models.calls == 0
    assert models.supervisor.seen == [] and models.supervisor.offered == []
    # An out-of-script invocation raises into a swallowed fallback; the log must be clean.
    assert [r for r in caplog.records if r.levelno >= logging.ERROR] == []


@pytest.mark.parametrize("name", SIX)
def test_six_fixtures_complete_without_the_model(tmp_path: Path, name: str, caplog: pytest.LogCaptureFixture) -> None:
    models = Models()
    bench = Workbench(offline_services(tmp_path, models))
    with caplog.at_level(logging.ERROR):
        run_id = _start(bench, name)
        snap = bench.snapshot(run_id)
        # The run went straight to the brief gate on the code-drafted brief.
        assert _gate(snap) == "brief"
        assert snap["fastpath"] is True and snap["status"] == "awaiting_brief"
        assert snap["model_calls"] == 0
        assert snap["pending"]["blocked_reasons"] == []
        brief = snap["brief"]
        assert brief["summary"] == SUMMARY
        assert brief["recipe"] == {"kind": "standard", "id": None}
        assert brief["questions"] == []
        snap, visits = _scripted_analyst(bench, run_id, name)
    assert snap["status"] == "locked" and snap["model_calls"] == 0
    _assert_model_never_ran(models, caplog)
    # Approval still confirmed mapping history: the recipe is the sponsor's.
    recipe = bench.services.stores.recipes.find_active("sponsor-a", "affiliate", snap["fingerprint"])
    assert recipe is not None and recipe.origin == "standard"
    # Output parity with the golden expectations: same findings, byte-identical CSV.
    spec = expected(name)
    got = sorted((f["row"] or 0, f["code"], f["severity"]) for f in visits[0]["result"]["findings"])
    want = sorted((f["row"] or 0, f["code"], f["severity"]) for f in spec["findings"])
    assert got == want
    if spec["rows"] is not None:
        csv = bench.services.stores.objects.get(f"runs/{run_id}/outputs/Affiliates.csv")
        assert csv == _csv_bytes(spec["rows"])


@pytest.mark.parametrize("name", AMBIGUOUS)
def test_ambiguous_fixtures_still_scope_with_the_supervisor(tmp_path: Path, name: str) -> None:
    models = Models()
    bench = Workbench(offline_services(tmp_path, models))
    models.supervisor.script = scope_standard(name)
    run_id = _start(bench, name)
    snap = bench.snapshot(run_id)
    # No fast path: the supervisor authored this brief.
    assert _gate(snap) == "brief"
    assert snap["fastpath"] is False
    assert snap["brief"]["summary"] == f"{name}: standard table."
    assert models.calls == 5
    while snap["pending"] is not None:
        snap = _approve(bench, run_id)
    assert snap["status"] == "locked"
    csv = bench.services.stores.objects.get(f"runs/{run_id}/outputs/Affiliates.csv")
    assert csv == _csv_bytes(expected(name)["rows"])
    assert models.calls == 5  # no findings, so the report stayed code-drafted


def test_instruct_at_the_brief_gate_invokes_the_supervisor(tmp_path: Path) -> None:
    models = Models()
    bench = Workbench(offline_services(tmp_path, models))
    models.supervisor.script = scope_standard("clean.csv")
    run_id = _start(bench, "clean.csv")
    assert models.calls == 0  # the fast path reached the gate without the model
    snap = bench.respond(run_id, {"action": "instruct", "actor": ANALYST, "text": "double-check the id column"})
    # The supervisor re-scoped with the analyst's words and proposed its own brief.
    assert _gate(snap) == "brief"
    assert snap["brief"]["summary"] == "clean.csv: standard table."
    assert models.calls == 5
    first_prompt = str(models.supervisor.seen[0][-1].content)
    assert "double-check the id column" in first_prompt
    # The run continues correctly on the supervisor's brief.
    while snap["pending"] is not None:
        snap = _approve(bench, run_id)
    assert snap["status"] == "locked"
    csv = bench.services.stores.objects.get(f"runs/{run_id}/outputs/Affiliates.csv")
    assert csv == _csv_bytes(expected("clean.csv")["rows"])
    assert models.calls == 5

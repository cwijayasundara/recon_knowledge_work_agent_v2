"""The run spine end to end with the scripted model (G2 acceptance)."""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest
from langgraph.checkpoint.memory import InMemorySaver
from onboarding_sdk import manifest

from onboarding_agent.graph.build import UploadRejected, Workbench
from tests.conftest import FIXTURE_DIR
from tests.golden.test_affiliate_golden import _csv_bytes
from tests.support.pipeline import expected
from tests.support.scripted_model import call, say, tools
from tests.support.scripts import report_simple, scope_standard
from tests.support.services import Models, offline_services

ANALYST = "analyst@sponsor-a"


def _start(bench: Workbench, name: str, sponsor: str = "sponsor-a") -> str:
    return bench.start(
        sponsor_id=sponsor, entity="affiliate", file_name=name, data=(FIXTURE_DIR / name).read_bytes(), actor=ANALYST
    )


def _approve(bench: Workbench, run_id: str) -> dict:  # type: ignore[type-arg]
    return bench.respond(run_id, {"action": "approve", "actor": ANALYST})


def _gate(snap: dict) -> str | None:  # type: ignore[type-arg]
    return (snap.get("pending") or {}).get("gate")


def _csv(bench: Workbench, run_id: str) -> bytes:
    return bench.services.stores.objects.get(f"runs/{run_id}/outputs/Affiliates.csv")


@pytest.fixture
def models() -> Models:
    return Models()


@pytest.fixture
def bench(tmp_path: Path, models: Models) -> Workbench:
    return Workbench(offline_services(tmp_path, models))


def test_happy_path_clean_ends_locked(bench: Workbench, models: Models) -> None:
    models.supervisor.script = scope_standard("clean.csv")
    run_id = _start(bench, "clean.csv")
    snap = bench.snapshot(run_id)
    assert _gate(snap) == "brief"
    assert snap["pending"]["blocked_reasons"] == []

    snap = _approve(bench, run_id)
    assert _gate(snap) == "findings"
    assert snap["result"]["findings"] == []
    snap = _approve(bench, run_id)
    assert _gate(snap) == "signoff"
    snap = _approve(bench, run_id)
    assert snap["status"] == "locked" and snap["pending"] is None

    assert _csv(bench, run_id) == _csv_bytes(expected("clean.csv")["rows"])
    doc = json.loads(bench.services.stores.objects.get(f"runs/{run_id}/outputs/manifest.json"))
    jsonschema.validate(doc, json.loads(Path(manifest.SCHEMA_PATH).read_text()))
    assert [a["gate"] for a in doc["approvers"]] == ["brief", "findings", "signoff"]
    assert bench.services.stores.runs.get(run_id).status == "locked"  # type: ignore[union-attr]
    kinds = [d.kind for d in bench.services.stores.decisions.list(run_id)]
    assert kinds == ["brief.approve", "findings.approve", "signoff.approve", "run.locked"]
    # No model after scoping: a clean file needs no report from the agent.
    assert models.calls == 5
    recipe = bench.services.stores.recipes.find_active("sponsor-a", "affiliate", snap["fingerprint"])
    assert recipe is not None and recipe.origin == "standard"


def test_findings_approve_refused_with_open_error(bench: Workbench, models: Models) -> None:
    models.supervisor.script = [*scope_standard("edge.csv"), *report_simple()]
    run_id = _start(bench, "edge.csv")
    snap = _approve(bench, run_id)
    assert _gate(snap) == "findings"
    snap = _approve(bench, run_id)
    assert _gate(snap) == "findings"
    assert "Cannot pass the gate" in snap["gate_message"]
    assert "AFF_ERR_ITEM_ID_DUPLICATE on row 4" in snap["gate_message"]


def test_id_override_resolves_collision(bench: Workbench, models: Models) -> None:
    models.supervisor.script = [*scope_standard("edge.csv"), *report_simple(), *report_simple()]
    run_id = _start(bench, "edge.csv")
    _approve(bench, run_id)
    snap = bench.respond(
        run_id,
        {
            "action": "change",
            "actor": ANALYST,
            "changes": [{"kind": "override_item_id", "row": 4, "value": "AFF_9011"}],
        },
    )
    assert _gate(snap) == "findings"
    codes = {(f["code"], f["row"]) for f in snap["result"]["findings"]}
    assert ("AFF_ERR_ITEM_ID_DUPLICATE", 4) not in codes
    assert snap["options"]["id_overrides"] == {"4": "AFF_9011"}


def test_refused_change_is_not_applied(bench: Workbench, models: Models) -> None:
    models.supervisor.script = [*scope_standard("edge.csv"), *report_simple()]
    run_id = _start(bench, "edge.csv")
    _approve(bench, run_id)
    snap = bench.respond(
        run_id,
        {
            "action": "change",
            "actor": ANALYST,
            "changes": [{"kind": "acknowledge_finding", "code": "AFF_ERR_ITEM_ID_BLANK", "row": 1}],
        },
    )
    assert "ack.error_not_allowed" in snap["gate_message"]
    assert snap["options"]["acknowledged"] == []


def test_instruction_with_no_applicable_change(bench: Workbench, models: Models) -> None:
    models.supervisor.script = [
        *scope_standard("edge.csv"),
        *report_simple(),
        tools(
            call(
                "submit_proposal",
                proposal={
                    "restated": "An Affiliate file has no amounts, so 'amounts are signed' changes nothing.",
                    "applicable": False,
                },
            )
        ),
        say("No applicable change."),
    ]
    run_id = _start(bench, "edge.csv")
    before = _approve(bench, run_id)
    snap = bench.respond(run_id, {"action": "instruct", "actor": ANALYST, "text": "amounts are signed"})
    assert _gate(snap) == "findings"
    assert snap["proposal"]["applicable"] is False
    assert snap["proposal"]["changes"] == []
    assert snap["options"] == before["options"]


def test_restart_between_gates_resumes(tmp_path: Path, models: Models) -> None:
    services = offline_services(tmp_path, models)
    saver = InMemorySaver()
    models.supervisor.script = scope_standard("clean.csv")
    first = Workbench(services, checkpointer=saver)
    run_id = _start(first, "clean.csv")
    _approve(first, run_id)

    # A new process: fresh spine and contexts, the same checkpoint store.
    second = Workbench(services, checkpointer=saver)
    snap = second.snapshot(run_id)
    assert _gate(snap) == "findings"
    _approve(second, run_id)
    snap = _approve(second, run_id)
    assert snap["status"] == "locked"
    assert _csv(second, run_id) == _csv_bytes(expected("clean.csv")["rows"])


def _complete(bench: Workbench, run_id: str) -> dict:  # type: ignore[type-arg]
    snap = bench.snapshot(run_id)
    while snap["pending"] is not None:
        snap = _approve(bench, run_id)
    return snap


def test_returning_sponsor_replays_with_zero_model_calls(bench: Workbench, models: Models) -> None:
    models.supervisor.script = scope_standard("renamed.xlsx")
    first = _start(bench, "renamed.xlsx")
    assert _complete(bench, first)["status"] == "locked"
    calls_after_first = models.calls

    returning = _start(bench, "returning_sponsor.xlsx")
    snap = bench.snapshot(returning)
    assert snap["replay"] is True
    assert _gate(snap) == "findings"
    assert _complete(bench, returning)["status"] == "locked"
    assert models.calls == calls_after_first
    assert _csv(bench, returning) == _csv_bytes(expected("returning_sponsor.xlsx")["rows"])

    again = _start(bench, "renamed.xlsx")
    assert _complete(bench, again)["status"] == "locked"
    assert models.calls == calls_after_first
    assert _csv(bench, again) == _csv(bench, first)


def test_history_is_not_shared_across_sponsors(bench: Workbench, models: Models) -> None:
    models.supervisor.script = [*scope_standard("renamed.xlsx"), *scope_standard("returning_sponsor.xlsx")]
    first = _start(bench, "renamed.xlsx")
    _complete(bench, first)
    other = _start(bench, "returning_sponsor.xlsx", sponsor="sponsor-b")
    snap = bench.snapshot(other)
    assert snap["replay"] is False
    assert _gate(snap) == "brief"


def test_answering_a_question_rescopes(bench: Workbench, models: Models) -> None:
    from tests.support.scripts import brief_for

    question = {
        "id": "q1",
        "text": "Which sheet is current?",
        "options": ["Affiliates", "Affiliates (old)"],
        "evidence": "two list-like sheets",
        "target": "sheet",
    }
    models.supervisor.script = [
        tools(call("profile_upload")),
        tools(call("submit_brief", brief=brief_for("two_sheets.xlsx", questions=[question]))),
        say("One question."),
        *scope_standard("two_sheets.xlsx"),
    ]
    run_id = _start(bench, "two_sheets.xlsx")
    snap = bench.snapshot(run_id)
    assert len(snap["brief"]["questions"]) == 1
    snap = _approve(bench, run_id)
    assert "open question" in snap["gate_message"]
    snap = bench.respond(run_id, {"action": "answer", "actor": ANALYST, "question_id": "q1", "option": "Affiliates"})
    assert snap["brief"]["questions"] == []
    assert snap["analyst_inputs"][0]["option"] == "Affiliates"
    # The answer reached the agent in its next scope message.
    rescope_prompt = str(models.supervisor.seen[3][-1].content)
    assert "Affiliates" in rescope_prompt and "q1" in rescope_prompt


def test_upload_guards(bench: Workbench) -> None:
    with pytest.raises(UploadRejected, match="sponsor"):
        bench.create(sponsor_id="*", entity="affiliate", file_name="a.csv", data=b"x", actor=ANALYST)
    with pytest.raises(UploadRejected, match="file type"):
        bench.create(sponsor_id="sponsor-a", entity="affiliate", file_name="a.pdf", data=b"x", actor=ANALYST)
    with pytest.raises(UploadRejected, match="entity"):
        bench.create(sponsor_id="sponsor-a", entity="investor", file_name="a.csv", data=b"x", actor=ANALYST)


def test_replayed_csv_reports_its_own_sheet_name(bench: Workbench, models: Models) -> None:
    models.supervisor.script = [*scope_standard("clean.csv"), *report_simple()]
    _complete(bench, _start(bench, "clean.csv"))
    replay = _start(bench, "edge.csv")
    snap = bench.snapshot(replay)
    assert snap["replay"] is True
    assert snap["layout"]["sheet"] == "edge"
    assert snap["brief"]["source"]["sheet"] == "edge"


def test_snapshot_before_first_checkpoint_has_full_shape(bench: Workbench) -> None:
    run_id = bench.create(
        sponsor_id="sponsor-a",
        entity="affiliate",
        file_name="clean.csv",
        data=(FIXTURE_DIR / "clean.csv").read_bytes(),
        actor=ANALYST,
    )
    snap = bench.snapshot(run_id)
    assert snap["status"] == "starting"
    assert snap["sponsor_id"] == "sponsor-a"
    assert snap["upload"]["name"] == "clean.csv"
    assert snap["approvers"] == [] and snap["artifacts"] == [] and snap["pending"] is None
    assert snap["resolution_summary"] is None


def test_fastpath_resolves_the_candidate_sheet_in_spine(bench: Workbench, models: Models) -> None:
    models.supervisor.script = scope_standard("clean.csv")
    run_id = _start(bench, "clean.csv")
    snap = bench.snapshot(run_id)
    fields = snap["resolution_summary"]["fields"]
    assert snap["resolution_summary"]["sheet"] == "clean"
    assert fields["affiliate_id"]["column"] == "Affiliate ID"
    assert fields["affiliate_name"]["decision"] == "matched"
    # The gate is unchanged: the analyst still approves the supervisor's brief.
    assert _gate(snap) == "brief"
    snap = _approve(bench, run_id)
    snap = _approve(bench, run_id)
    snap = _approve(bench, run_id)
    assert snap["status"] == "locked"
    assert _csv(bench, run_id) == _csv_bytes(expected("clean.csv")["rows"])
    # The spine's code resolution changes no model behaviour: the same scope
    # script runs, the same number of calls.
    assert models.calls == 5


def test_fastpath_off_restores_supervisor_path(tmp_path: Path, models: Models) -> None:
    services = offline_services(tmp_path, models, fastpath=False)
    bench = Workbench(services)
    models.supervisor.script = scope_standard("clean.csv")
    run_id = _start(bench, "clean.csv")
    snap = bench.snapshot(run_id)
    # The spine resolved nothing in code; scoping ran on the supervisor as before.
    assert snap["resolution_summary"] is None
    assert _gate(snap) == "brief"
    snap = _approve(bench, run_id)
    snap = _approve(bench, run_id)
    snap = _approve(bench, run_id)
    assert snap["status"] == "locked"
    assert _csv(bench, run_id) == _csv_bytes(expected("clean.csv")["rows"])
    assert models.calls == 5

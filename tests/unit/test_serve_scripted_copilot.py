"""The scripted copilot of tests/e2e/serve_scripted.py, driven through the real CopilotEngine."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.messages import BaseMessage
from langchain_core.outputs import ChatResult
from pydantic import Field

from onboarding_agent.config import Settings
from onboarding_agent.copilot.engine import CopilotEngine
from onboarding_agent.copilot.schemas import StepIn, StepOut, ToolResultIn
from onboarding_agent.copilot.sessions import SessionStore
from tests.e2e.serve_scripted import (
    FORMULA_RANGE,
    FORMULAS,
    INJECT_TEXT,
    ITEM_TYPE,
    OVERCAP_RANGE,
    WRITE_RANGE,
    WRITE_VALUES,
    ReactiveCopilotModel,
    build,
)
from tests.unit.copilot.test_engine import _pairing_problem

ACTOR = "analyst@sponsor-a"
GRID = {"values": [["Affiliate ID", "Affiliate Name"], ["AFF_1", "One"], ["AFF_2", "Two"]]}


class PairingModel(ReactiveCopilotModel):
    """Refuses a transcript with unanswered or unpaired tool calls, as OpenAI does."""

    problems: list[str] = Field(default_factory=list)
    calls_seen: int = 0

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        self.calls_seen += 1
        problem = _pairing_problem(messages)
        if problem:
            self.problems.append(problem)
            raise AssertionError(problem)
        return super()._generate(messages, stop, run_manager, **kwargs)


class FakeRuns:
    def __init__(self) -> None:
        self.dry_calls: list[list[Any]] = []

    def snapshot(self, run_id: str) -> dict[str, Any]:
        return {"status": "waiting", "pending": {"gate": "findings"}}

    def dry_run(self, run_id: str, changes: list[Any]) -> dict[str, Any]:
        self.dry_calls.append(changes)
        return {"violations": [], "rows_changed": [], "publishable_before": True, "publishable_after": True}


class Rig:
    def __init__(self, run_id: str | None = None) -> None:
        self.model = PairingModel()
        self.runs = FakeRuns()
        self.engine = CopilotEngine(
            Settings(_env_file=None, copilot_enabled=True),  # type: ignore[call-arg]
            lambda role: self.model,
            self.runs,
            SessionStore(60, 5),
            prompt="SYSTEM",
        )
        self.sid = self.engine.start(ACTOR, run_id).id

    def user(self, text: str) -> StepOut:
        return self._step(StepIn(user_message=text))

    def answer(self, out: StepOut, content: dict[str, Any], ok: bool = True) -> StepOut:
        assert out.status == "tool_calls" and len(out.tool_calls) == 1
        return self._step(StepIn(tool_results=[ToolResultIn(call_id=out.tool_calls[0].id, ok=ok, content=content)]))

    def _step(self, body: StepIn) -> StepOut:
        out = self.engine.step(self.sid, ACTOR, body)
        assert self.model.problems == []
        return out


def _sheets_turn(rig: Rig) -> StepOut:
    out = rig.user("Which sheets are there?")
    assert [(c.name, c.args) for c in out.tool_calls] == [("list_sheets", {})]
    out = rig.answer(out, {"sheets": ["Affiliates", "Other"]})
    assert [(c.name, c.args) for c in out.tool_calls] == [("describe_sheet", {"sheet": "Affiliates"})]
    out = rig.answer(out, {"used_range": "A1:E9", "headers": ["Affiliate ID", "Affiliate Name"]})
    assert [(c.name, c.args) for c in out.tool_calls] == [("read_range", {"sheet": "Affiliates", "range": "A1:B3"})]
    return rig.answer(out, GRID)


def test_sheets_conversation_reads_and_cites_addresses_only() -> None:
    rig = Rig()
    final = _sheets_turn(rig)
    assert final.status == "final"
    assert final.text == (
        "Listed 2 sheets. Described Affiliates (used range A1:E9, 2 headers). Read Affiliates!A1:B3 (3x2 cells)."
    )
    assert "AFF_1" not in final.text


def test_any_number_of_conversations_in_one_session() -> None:
    rig = Rig()
    for _ in range(3):
        assert _sheets_turn(rig).status == "final"
        write = rig.user("please propose write")
        assert write.status == "final" and len(write.proposed_writes) == 1
        assert rig.user("hello").text == "OK"
    ids = [c.get("id") for m in rig.engine.store.get(rig.sid, ACTOR).messages for c in getattr(m, "tool_calls", [])]
    assert len(ids) == len(set(ids)) == 12


def test_overcap_is_refused_by_the_server_and_the_turn_still_ends() -> None:
    rig = Rig()
    out = rig.user("OVERCAP please")
    assert out.status == "final" and out.tool_calls == []
    assert out.text.startswith(f"The read of Affiliates!{OVERCAP_RANGE} was refused: range too large: 2002 cells")
    assert rig.model.calls_seen == 2


def test_write_proposals_carry_canonical_range_and_shape() -> None:
    rig = Rig()
    values = rig.user("propose write")
    assert [(w.sheet, w.range, w.values, w.formulas) for w in values.proposed_writes] == [
        ("Affiliates", WRITE_RANGE, WRITE_VALUES, None)
    ]
    formulas = rig.user("propose formulas")
    assert [(w.sheet, w.range, w.values, w.formulas) for w in formulas.proposed_writes] == [
        ("Affiliates", FORMULA_RANGE, None, FORMULAS)
    ]
    assert FORMULA_RANGE in formulas.text


def test_propose_changes_needs_a_run_and_uses_the_rows_in_the_text() -> None:
    unbound = Rig()
    out = unbound.user("propose changes 4 5")
    assert out.proposed_changes == [] and "no active run" in out.text

    bound = Rig(run_id="run-1")
    out = bound.user("Propose changes 4 7")
    assert [c.model_dump() for c in out.proposed_changes] == [
        {"kind": "exclude_row", "row": 4, "reason": "duplicate of another row"},
        {"kind": "set_item_type", "value": ITEM_TYPE, "rows": [7]},
    ]
    assert out.notes == ["Proposal: Exclude row 4; set ITEM_TYPE Non-Inventory on row 7."]
    assert len(bound.runs.dry_calls) == 1


def test_inject_text_is_returned_verbatim() -> None:
    out = Rig().user("inject")
    assert out.text == INJECT_TEXT and "</tool_result>" in out.text


def test_a_failed_or_unexpected_tool_result_ends_the_turn() -> None:
    rig = Rig()
    out = rig.user("sheets")
    final = rig.answer(out, {"message": "sheet is hidden; unhide it first"}, ok=False)
    assert final.status == "final"
    assert final.text.startswith("The list_sheets call failed: the workbook tool failed")
    out = rig.user("sheets")
    final = rig.answer(out, {"unexpected": True})  # wrong shape: the server refuses it, the model reports it
    assert final.status == "final" and final.text.startswith("The list_sheets call failed: unexpected result shape")


def test_build_without_copilot_is_unchanged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ONB_COPILOT_ENABLED", raising=False)  # the settings read the environment
    off = TestClient(build(tmp_path / "off"))
    r = off.post("/copilot/sessions", json={}, headers={"X-Actor": ACTOR})
    assert r.status_code == 403
    on = TestClient(build(tmp_path / "on", copilot=True))
    r = on.post("/copilot/sessions", json={}, headers={"X-Actor": ACTOR})
    assert r.status_code == 200
    sid = r.json()["session_id"]
    step = on.post(f"/copilot/sessions/{sid}/step", json={"user_message": "hi"}, headers={"X-Actor": ACTOR})
    assert step.json()["text"] == "OK"

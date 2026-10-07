"""R1: ``derive_case`` turns a correcting decision log into a versioned case.

Each trigger kind captures; an approve-only log captures nothing; the case
round-trips through the pydantic schema; a run that did not lock (or has no
output sha) has no case.
"""

from __future__ import annotations

from typing import Any

import pytest

from onboarding_agent.persistence.interfaces import DecisionRecord
from onboarding_agent.regression import CASE_VERSION, TRIGGER_KINDS, RegressionCase, case_key, derive_case

RUN = "run-1"
SPONSOR = "sponsor-a"
UPLOAD_SHA = "a" * 64
CSV_SHA = "b" * 64
AT = "2026-01-01T00:00:00.000000Z"


def _record(seq: int, kind: str, actor: str = "analyst@sponsor-a") -> DecisionRecord:
    return DecisionRecord(RUN, seq, kind, {"action": kind.split(".")[-1]}, actor, AT)


def _derive(decisions: list[DecisionRecord], **overrides: Any) -> dict[str, Any] | None:
    kwargs: dict[str, Any] = {
        "run_id": RUN,
        "sponsor_id": SPONSOR,
        "entity": "affiliate",
        "fingerprint": "fp-1",
        "fixture": "edge.csv",
        "upload_sha256": UPLOAD_SHA,
        "decisions": decisions,
        "status": "locked",
        "bindings": {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"},
        "csv_sha256": CSV_SHA,
        "finding_codes": ["AFF_WARN_ITEM_ID_DERIVED", "AFF_ERR_ITEM_ID_BLANK"],
    }
    kwargs.update(overrides)
    return derive_case(**kwargs)


@pytest.mark.parametrize("kind", sorted(TRIGGER_KINDS))
def test_each_trigger_kind_captures(kind: str) -> None:
    decisions = [
        _record(1, "brief.approve"),
        _record(2, kind),
        _record(3, "signoff.approve"),
        _record(4, "run.locked", actor="system"),
    ]
    case = _derive(decisions)
    assert case is not None
    assert [s["kind"] for s in case["steps"]] == [kind]
    step = case["steps"][0]
    assert (step["seq"], step["actor"], step["at"]) == (2, "analyst@sponsor-a", AT)
    assert step["payload"] == decisions[1].payload  # verbatim


def test_clean_approve_only_run_captures_nothing() -> None:
    decisions = [
        _record(1, "brief.approve"),
        _record(2, "findings.approve"),
        _record(3, "signoff.approve"),
        _record(4, "run.locked", actor="system"),
    ]
    assert _derive(decisions) is None


def test_case_schema_round_trips() -> None:
    case = _derive([_record(1, "brief.change"), _record(2, "findings.instruct")])
    assert case is not None
    parsed = RegressionCase.model_validate(case)
    assert parsed.model_dump() == case
    assert parsed.version == CASE_VERSION
    assert parsed.run_id == RUN and parsed.sponsor_id == SPONSOR
    assert parsed.entity == "affiliate" and parsed.fixture == "edge.csv"
    assert parsed.upload.sha256 == UPLOAD_SHA
    assert parsed.outcome.status == "locked"
    assert parsed.outcome.csv_sha256 == CSV_SHA
    assert parsed.outcome.bindings == {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"}


def test_finding_codes_are_sorted_and_distinct() -> None:
    case = _derive(
        [_record(1, "findings.change")],
        finding_codes=["AFF_WARN_NAME_TRUNCATED", "AFF_ERR_ITEM_ID_BLANK", "AFF_WARN_NAME_TRUNCATED"],
    )
    assert case is not None
    assert case["outcome"]["finding_codes"] == ["AFF_ERR_ITEM_ID_BLANK", "AFF_WARN_NAME_TRUNCATED"]


def test_step_payload_is_the_verbatim_decision_payload() -> None:
    payload: dict[str, Any] = {
        "action": "change",
        "changes": [{"kind": "override_item_id", "row": 4, "value": "AFF_9011"}],
    }
    record = DecisionRecord(RUN, 1, "findings.change", payload, "analyst@sponsor-a", AT)
    case = _derive([record])
    assert case is not None
    assert case["steps"][0]["payload"] == payload


@pytest.mark.parametrize("status", ["rejected", "error", "reviewing", ""])
def test_run_that_did_not_lock_captures_nothing(status: str) -> None:
    assert _derive([_record(1, "findings.change")], status=status) is None


def test_run_without_output_sha_captures_nothing() -> None:
    assert _derive([_record(1, "findings.change")], csv_sha256=None) is None


def test_object_key() -> None:
    assert case_key("sponsor-a", "run-1") == "regression/sponsor-a/run-1.json"

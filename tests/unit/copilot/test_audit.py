import json
import logging

import pytest

from onboarding_agent.copilot.audit import audit
from onboarding_agent.copilot.rules import is_hidden_char, parse_range

LOGGER = "onboarding_agent.copilot.audit"
S = "SENTINEL-7f3a"


def test_audit_logs_json(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger=LOGGER):
        audit("tool_call", actor="a", tool="read_range", sheet="S", range="A1:B2", cells=4, outcome="ok")
    recs = [r for r in caplog.records if r.name == LOGGER]
    assert len(recs) == 1
    assert json.loads(recs[0].getMessage()) == {
        "event": "tool_call", "actor": "a", "tool": "read_range", "sheet": "S",
        "range": "A1:B2", "cells": 4, "outcome": "ok",
    }  # fmt: skip


def test_unknown_key_rejected() -> None:
    with pytest.raises(ValueError):
        audit("tool_call", value="secret-123")


@pytest.mark.parametrize(
    "field,value",
    [
        ("sheet", "x" * 81),
        ("range", "A1\n"),
        ("range", "a1"),
        ("range", "A:A"),
        ("sheet", "a/b"),
        ("actor", "has space"),
        ("sheet", "History"),
        ("sheet", "a​b"),
        ("actor", "a\x00"),
        ("actor", ""),
        ("cells", "4"),
        ("cells", 1.5),
        ("cells", True),
        ("cells", None),
        ("cells", -1),
        ("bytes", 10**12 + 1),
        ("step", -3),
        ("tool", "nope"),
        ("tool", S),
        ("outcome", S),
        ("outcome", "success"),
        ("outcome", ["ok"]),
    ],
)
def test_bad_values_rejected(field: str, value: object) -> None:
    with pytest.raises(ValueError) as e:
        audit("step", **{field: value})
    assert S not in str(e.value)


def test_closed_sets_and_bounds_accepted() -> None:
    for ev in ("session_start", "session_end", "step", "tool_call", "tool_result", "proposal", "cap_hit", "error"):
        audit(ev)
    for oc in ("ok", "error", "rejected", "cap", "timeout", "aborted"):
        audit("step", outcome=oc)
    audit("step", tool="unknown", cells=0, bytes=10**12)


def test_bad_event_rejected() -> None:
    for ev in ("", "x" * 81, "a\nb", S, "tool", "unknown_event"):
        with pytest.raises(ValueError) as e:
            audit(ev)
        assert S not in str(e.value)


def test_exception_text_cannot_be_logged(caplog: pytest.LogCaptureFixture) -> None:
    from pydantic import ValidationError

    from onboarding_agent.copilot.schemas import ReadRange

    with pytest.raises(ValueError) as rule_err:
        parse_range(S)
    with pytest.raises(ValidationError) as schema_err:
        ReadRange(sheet=S + "/", range=S)
    assert S in str(rule_err.value) and S in str(schema_err.value)  # the raw input is echoed upstream
    with caplog.at_level(logging.DEBUG):
        for exc in (rule_err.value, schema_err.value):
            for field in ("outcome", "tool", "sheet", "range"):
                with pytest.raises(ValueError):
                    audit("error", **{field: str(exc)})
                with pytest.raises(ValueError):
                    audit("error", **{field: exc})
        audit("error", outcome="rejected", tool="read_range")
    assert S not in caplog.text


def test_sentinel_through_schemas_never_logged(caplog: pytest.LogCaptureFixture) -> None:
    from onboarding_agent.copilot.schemas import Find, ProposeChanges, ProposeWrite

    with caplog.at_level(logging.DEBUG):
        w = ProposeWrite(sheet="Out", range="A1:B1", values=[[S, 1]], note=S)
        f = ProposeWrite(sheet="Out", range="A1", formulas=[[f'="{S}"']])
        q = Find(text=S)
        p = ProposeChanges(restated=S, changes=[{"kind": "exclude_row", "row": 2, "reason": S}])  # type: ignore[list-item]
        audit("proposal", actor="a", sheet=w.sheet, range=w.range, cells=2, tool="propose_write")
        audit("proposal", actor="a", sheet=f.sheet, range=f.range, cells=1, tool="find", outcome="ok")
        assert q.text == S and p.restated == S
        # the sentinel in any field (allowed or not) is refused, so it can never reach the log
        for field in ("actor", "session", "tool", "sheet", "range", "outcome", "run_id", "cells", "x"):
            with pytest.raises(ValueError):
                audit("proposal", **{field: S * 10})
        for field in ("actor", "session", "sheet", "run_id"):
            audit("proposal", **{field: "short"})
        audit("proposal", range="A1:B2")
    assert S not in caplog.text
    assert S not in "".join(r.getMessage() for r in caplog.records)


def test_is_hidden_char_public() -> None:
    assert is_hidden_char("​") and is_hidden_char("\x00") and not is_hidden_char("a")
    assert not is_hidden_char("\n", keep_ws=True) and is_hidden_char("\n")

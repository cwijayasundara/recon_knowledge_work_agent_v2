"""Audit log: addresses and counts only. Contents cannot be smuggled through the allowed fields."""

from __future__ import annotations

import json
import logging
import re

from onboarding_agent.copilot.rules import is_hidden_char, parse_range, valid_sheet_name
from onboarding_agent.copilot.schemas import ALL_TOOLS

_log = logging.getLogger("onboarding_agent.copilot.audit")
_ALLOWED = frozenset({"actor", "session", "tool", "sheet", "range", "cells", "bytes", "step", "outcome", "run_id"})
_COUNTS = frozenset({"cells", "bytes", "step"})
_MAX_COUNT = 10**12
_MAX_STR = 80
_EVENTS = frozenset(
    {"session_start", "session_end", "step", "tool_call", "tool_result", "proposal", "cap_hit", "error"}
)
_OUTCOMES = frozenset({"ok", "error", "rejected", "cap", "timeout", "aborted"})
_TOOLS = ALL_TOOLS | {"unknown"}
# Closed vocabularies keep model- or user-controlled text out of the log; error messages never echo input.
_CLOSED = {"event": _EVENTS, "outcome": _OUTCOMES, "tool": _TOOLS}


_ID = re.compile(r"[A-Za-z0-9_.@-]{1,80}", re.ASCII)


def _clean(name: str, v: object) -> None:
    """Free-form fields must be shaped like what they claim, so exception text cannot pass for one."""
    ok = isinstance(v, str) and 0 < len(v) <= _MAX_STR and not any(is_hidden_char(ch) for ch in v)
    if ok:
        assert isinstance(v, str)
        try:
            if name == "sheet":
                valid_sheet_name(v)
            elif name == "range":
                ok = parse_range(v).a1() == v
            else:
                ok = _ID.fullmatch(v) is not None
        except ValueError:
            ok = False
    if not ok:
        raise ValueError(f"audit field {name!r} has an invalid value")


def _closed(name: str, v: object) -> None:
    if not isinstance(v, str) or v not in _CLOSED[name]:
        raise ValueError(f"audit field {name!r} is not an allowed value")


def audit(event: str, **fields: str | int) -> None:
    _closed("event", event)
    for k, v in fields.items():
        if k not in _ALLOWED:
            raise ValueError("audit field not allowed")
        if k in _COUNTS:
            if isinstance(v, bool) or not isinstance(v, int):
                raise ValueError(f"audit field {k!r} must be an int")
            if not 0 <= v <= _MAX_COUNT:
                raise ValueError(f"audit field {k!r} is out of range")
        elif k in _CLOSED:
            _closed(k, v)
        else:
            _clean(k, v)
    _log.info(json.dumps({"event": event, **fields}, ensure_ascii=True, sort_keys=True))

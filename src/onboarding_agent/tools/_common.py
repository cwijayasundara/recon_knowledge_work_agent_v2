"""Helpers shared by host tools: compact JSON results, never raw file rows."""

from __future__ import annotations

import json
from typing import Any


def ok(**payload: Any) -> str:
    return json.dumps({"ok": True, **payload}, default=str, separators=(",", ":"))


def fail(error: str, **payload: Any) -> str:
    return json.dumps({"ok": False, "error": error, **payload}, default=str, separators=(",", ":"))

"""Canned supervisor scripts for the fixtures, built from tests/fixtures/affiliate/expected."""

from __future__ import annotations

from typing import Any

from tests.support.pipeline import expected
from tests.support.scripted_model import call, say, tools


def brief_for(name: str, *, recipe: str = "standard", questions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    spec = expected(name)
    b = spec["bindings"]
    return {
        "source": {"file": name, "sheet": spec["sheet"], "header_row": spec["header_row"]},
        "bindings": [
            {"field": "affiliate_id", "column": b["affiliate_id"], "evidence": "id-like values"},
            {"field": "affiliate_name", "column": b["affiliate_name"], "evidence": "legal names"},
        ],
        "id_strategy": "source_id" if b["affiliate_id"] else "derive_from_name",
        "recipe": {"kind": recipe},
        "confidence": 0.9,
        "questions": questions or [],
        "summary": f"{name}: standard table.",
    }


def scope_standard(name: str) -> list[Any]:
    spec = expected(name)
    b = spec["bindings"]
    return [
        tools(call("profile_upload"), call("recall_recipe")),
        tools(call("resolve_columns", sheet=spec["sheet"], header_row=spec["header_row"])),
        tools(
            call(
                "write_standard_recipe",
                sheet=spec["sheet"],
                header_row=spec["header_row"],
                affiliate_id=b["affiliate_id"],
                affiliate_name=b["affiliate_name"],
            )
        ),
        tools(call("submit_brief", brief=brief_for(name))),
        say("Brief submitted."),
    ]


def report_simple(summary: str = "Findings explained.") -> list[Any]:
    return [
        tools(call("get_findings")),
        tools(call("submit_report", report={"summary": summary})),
        say("Report submitted."),
    ]

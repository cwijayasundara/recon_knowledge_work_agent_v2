"""F1: the spine resolves the candidate sheet in code, and the resolve_columns
tool reuses that resolution instead of resolving the same layout twice."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from onboarding_sdk.resolve import ResolutionSet

from onboarding_agent.assembly import Services
from onboarding_agent.graph.nodes import Spine
from onboarding_agent.run_context import RunContext
from tests.support.services import Models, context_for, offline_services

# The routes below are the resolver's own output for these fixtures; the spine
# only picks the sheet and forwards whatever the resolver decided.


def _state(fixture: str) -> dict[str, Any]:
    return {
        "run_id": "run-1",
        "sponsor_id": "sponsor-a",
        "entity": "affiliate",
        "actor": "analyst@sponsor-a",
        "upload": {"key": f"runs/run-1/in/{fixture}", "name": fixture},
        "recall": None,
    }


@pytest.fixture
def services(tmp_path: Path) -> Services:
    return offline_services(tmp_path, Models())


def _ctx(spine: Spine, fixture: str) -> RunContext:
    return spine.ctx(_state(fixture))


def test_single_sheet_csv_resolves_in_spine(services: Services) -> None:
    context_for(services, "clean.csv")
    spine = Spine(services)
    patch = spine.resolve(_state("clean.csv"))
    assert patch["replay"] is False
    assert patch["resolution_summary"] == {
        "sheet": "clean",
        "header_row": 1,
        "fields": {
            "affiliate_id": {
                "column": "Affiliate ID",
                "route": "ontology_exact",
                "score": 1.0,
                "decision": "matched",
            },
            "affiliate_name": {
                "column": "Affiliate Name",
                "route": "ontology_exact",
                "score": 1.0,
                "decision": "matched",
            },
        },
    }
    ctx = _ctx(spine, "clean.csv")
    assert ctx.resolved_layout == ("clean", 1)
    assert ctx.resolution is not None
    assert ctx.resolution.bindings() == {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"}


def test_two_qualifying_sheets_yield_no_candidate(services: Services, monkeypatch: pytest.MonkeyPatch) -> None:
    context_for(services, "two_sheets.xlsx")
    spine = Spine(services)
    calls = _count_resolves(services, monkeypatch)
    patch = spine.resolve(_state("two_sheets.xlsx"))
    # Both sheets are list-like and both qualify: no candidate, exactly the
    # supervisor-path patch, and nothing left cached for the draft to mistake
    # for a candidate.
    assert patch == {"replay": False}
    assert len(calls) == 2
    ctx = _ctx(spine, "two_sheets.xlsx")
    assert ctx.resolution is None
    assert ctx.resolved_layout is None


def test_titled_workbook_qualifies_on_its_affiliates_sheet(services: Services, monkeypatch: pytest.MonkeyPatch) -> None:
    context_for(services, "titled.xlsx")
    spine = Spine(services)
    calls = _count_resolves(services, monkeypatch)
    patch = spine.resolve(_state("titled.xlsx"))
    # Every list-like sheet is resolved; only the Affiliates sheet qualifies —
    # the Notes sheet's columns do not match the name field.
    assert len(calls) == 2
    assert patch["replay"] is False
    summary = patch["resolution_summary"]
    assert (summary["sheet"], summary["header_row"]) == ("Affiliates", 4)
    assert summary["fields"]["affiliate_name"]["decision"] == "matched"
    assert _ctx(spine, "titled.xlsx").resolved_layout == ("Affiliates", 4)


def test_header_only_csv_qualifies(services: Services) -> None:
    # A lone profiled sheet is resolved whatever its list score (a header-only
    # CSV scores 0 for want of data rows); the resolver still matches its headers.
    context_for(services, "empty.csv")
    spine = Spine(services)
    patch = spine.resolve(_state("empty.csv"))
    assert patch["replay"] is False
    summary = patch["resolution_summary"]
    assert (summary["sheet"], summary["header_row"]) == ("empty", 1)
    assert summary["fields"]["affiliate_id"]["decision"] == "matched"
    assert summary["fields"]["affiliate_name"]["decision"] == "matched"
    assert _ctx(spine, "empty.csv").resolved_layout == ("empty", 1)


def test_unfamiliar_headers_resolve_but_do_not_qualify(services: Services, monkeypatch: pytest.MonkeyPatch) -> None:
    context_for(services, "renamed.xlsx")
    spine = Spine(services)
    seen: list[ResolutionSet] = []
    real = services.resolver.resolve

    def recording(sponsor_id: str, headers: list[str], *, run_id: str) -> Any:
        resolution = real(sponsor_id, headers, run_id=run_id)
        seen.append(resolution)
        return resolution

    monkeypatch.setattr(services.resolver, "resolve", recording)
    patch = spine.resolve(_state("renamed.xlsx"))
    # The Export sheet is resolved (its routes are the resolver's own work),
    # but its fuzzy name score is below the threshold: no candidate.
    assert patch == {"replay": False}
    assert len(seen) == 1
    ident, name = seen[0].fields["affiliate_id"], seen[0].fields["affiliate_name"]
    assert (ident.column, ident.route, ident.decision) == ("Affiliate Id", "ontology_exact", "matched")
    assert (name.column, name.decision) == (None, "needs_review")
    # The candidates are the resolver's own fuzzy work, forwarded unchanged.
    assert "Affi Name" in [c.column for c in name.candidates]
    assert _ctx(spine, "renamed.xlsx").resolution is None


def test_fastpath_off_resolves_nothing(tmp_path: Path) -> None:
    services = offline_services(tmp_path, Models(), fastpath=False)
    context_for(services, "clean.csv")
    spine = Spine(services)
    patch = spine.resolve(_state("clean.csv"))
    assert patch == {"replay": False}
    ctx = _ctx(spine, "clean.csv")
    assert ctx.resolution is None
    assert ctx.resolved_layout is None


def _count_resolves(services: Services, monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    calls: list[list[str]] = []
    real = services.resolver.resolve

    def counting(sponsor_id: str, headers: list[str], *, run_id: str) -> Any:
        calls.append(list(headers))
        return real(sponsor_id, headers, run_id=run_id)

    monkeypatch.setattr(services.resolver, "resolve", counting)
    return calls


def test_resolve_columns_reuses_the_spines_resolution(services: Services, monkeypatch: pytest.MonkeyPatch) -> None:
    from onboarding_agent.tools.resolve import make_resolve_tools

    context_for(services, "clean.csv")
    spine = Spine(services)
    summary = spine.resolve(_state("clean.csv"))["resolution_summary"]
    calls = _count_resolves(services, monkeypatch)

    ctx = _ctx(spine, "clean.csv")
    tool = make_resolve_tools(ctx)[0]
    out = json.loads(tool.invoke({"sheet": "clean", "header_row": 1}))
    assert calls == []  # reused the spine's ResolutionSet, no second resolve
    assert out["ok"] is True
    # The tool adds candidates; column/route/score/decision match the summary.
    assert {
        k: {f: v[f] for f in ("column", "route", "score", "decision")} for k, v in out["fields"].items()
    } == summary["fields"]


def test_resolve_columns_with_other_arguments_resolves(services: Services, monkeypatch: pytest.MonkeyPatch) -> None:
    from onboarding_agent.tools.resolve import make_resolve_tools

    context_for(services, "clean.csv")
    spine = Spine(services)
    spine.resolve(_state("clean.csv"))
    calls = _count_resolves(services, monkeypatch)

    ctx = _ctx(spine, "clean.csv")
    tool = make_resolve_tools(ctx)[0]
    out = json.loads(tool.invoke({"sheet": "clean", "header_row": 2}))
    assert len(calls) == 1  # different header row: resolved normally
    assert out["ok"] is True
    assert out["header_row"] == 2
    assert ctx.resolved_layout == ("clean", 2)

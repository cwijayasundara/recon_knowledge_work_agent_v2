"""F2: the fast path drafts a standard brief in code, or returns None.

The draft/None table pins, per fixture, whether ``draft`` proposes a brief
after the spine's resolve ran: the six clean fixtures draft, two_sheets.xlsx
(two qualifying sheets) and renamed.xlsx / returning_sponsor.xlsx (name field
needs_review, fuzzy scores below the threshold) do not.
"""

from __future__ import annotations

import io
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from openpyxl import Workbook

from onboarding_agent.assembly import Services
from onboarding_agent.graph import fastpath, gates
from onboarding_agent.graph.fastpath import SUMMARY, draft
from onboarding_agent.graph.nodes import Spine
from onboarding_agent.run_context import RunContext
from tests.support.services import Models, context_for, offline_services


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


def _resolved_ctx(services: Services, fixture: str) -> RunContext:
    context_for(services, fixture)
    spine = Spine(services)
    spine.resolve(_state(fixture))
    return spine.ctx(_state(fixture))


# fixture -> (sheet, header_row) of the drafted brief; None: the supervisor scopes.
DRAFT_TABLE: dict[str, tuple[str, int] | None] = {
    "clean.csv": ("clean", 1),
    "extra_columns.csv": ("extra_columns", 1),
    "titled.xlsx": ("Affiliates", 4),
    "edge.csv": ("edge", 1),
    "ids_missing.csv": ("ids_missing", 1),
    "empty.csv": ("empty", 1),
    "two_sheets.xlsx": None,  # two sheets qualify
    "renamed.xlsx": None,  # name field needs_review
    "returning_sponsor.xlsx": None,  # name field needs_review
}


@pytest.mark.parametrize("fixture", list(DRAFT_TABLE), ids=list(DRAFT_TABLE))
def test_draft_table(services: Services, fixture: str) -> None:
    ctx = _resolved_ctx(services, fixture)
    brief = draft(ctx, services.settings)
    expected = DRAFT_TABLE[fixture]
    if expected is None:
        assert brief is None
    else:
        assert brief is not None
        assert (brief.source.sheet, brief.source.header_row) == expected
        assert brief.source.file == fixture


@pytest.mark.parametrize("fixture", [f for f, sheet in DRAFT_TABLE.items() if sheet])
def test_drafted_brief_passes_its_own_gate(services: Services, fixture: str) -> None:
    ctx = _resolved_ctx(services, fixture)
    brief = draft(ctx, services.settings)
    assert brief is not None
    # Same bindings and layout as the recipe the draft just checked.
    assert ctx.candidate_recipe is not None
    assert gates.brief_blockers(brief, ctx.candidate_recipe, ctx.bindings, ctx.layout) == []


def test_drafted_brief_content(services: Services) -> None:
    ctx = _resolved_ctx(services, "clean.csv")
    brief = draft(ctx, services.settings)
    assert brief is not None
    assert brief.summary == SUMMARY
    assert brief.recipe.kind == "standard" and brief.recipe.id is None
    assert brief.questions == [] and brief.expected_findings == []
    assert brief.id_strategy == "source_id" and brief.confidence == 1.0
    assert brief.binding_map() == {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"}
    by_field = {b.field: b for b in brief.bindings}
    assert by_field["affiliate_id"].route == "ontology_exact"
    assert by_field["affiliate_name"].route == "ontology_exact"
    # One evidence line per field, with the column's samples, pattern and fill.
    assert "'Affiliate Name'" in by_field["affiliate_name"].evidence
    assert "100% filled" in by_field["affiliate_name"].evidence
    assert "Meridian Capital GP IV, LLC" in by_field["affiliate_name"].evidence
    assert "'Affiliate ID'" in by_field["affiliate_id"].evidence
    assert "AFF_\\d{4}" in by_field["affiliate_id"].evidence
    assert "AFF_9001" in by_field["affiliate_id"].evidence


def test_id_strategy_mixed_when_the_id_column_only_partly_covers(services: Services) -> None:
    ctx = _resolved_ctx(services, "extra_columns.csv")
    brief = draft(ctx, services.settings)
    assert brief is not None
    assert brief.id_strategy == "mixed"
    assert brief.binding_map() == {"affiliate_id": "Affiliate Id", "affiliate_name": "Affiliate Name"}


def test_id_strategy_derive_when_there_is_no_id_column(services: Services) -> None:
    ctx = _resolved_ctx(services, "ids_missing.csv")
    brief = draft(ctx, services.settings)
    assert brief is not None
    assert brief.id_strategy == "derive_from_name"
    assert brief.binding_map() == {"affiliate_id": None, "affiliate_name": "Affiliate Name"}
    by_field = {b.field: b for b in brief.bindings}
    assert by_field["affiliate_id"].evidence == (
        "no Affiliate ID column resolved; ids are derived from the affiliate name"
    )
    assert by_field["affiliate_id"].confidence is None


def test_draft_without_a_resolution_is_none(services: Services) -> None:
    context_for(services, "clean.csv")
    spine = Spine(services)
    ctx = spine.ctx(_state("clean.csv"))  # resolve never ran
    assert draft(ctx, services.settings) is None


def test_draft_returns_none_below_the_score_threshold(services: Services) -> None:
    ctx = _resolved_ctx(services, "clean.csv")
    assert ctx.resolution is not None
    name = replace(ctx.resolution.fields["affiliate_name"], score=0.5)
    ctx.resolution = replace(ctx.resolution, fields={**ctx.resolution.fields, "affiliate_name": name})
    assert draft(ctx, services.settings) is None


def test_draft_returns_none_on_a_needs_review_id(services: Services) -> None:
    ctx = _resolved_ctx(services, "clean.csv")
    assert ctx.resolution is not None
    ident = replace(ctx.resolution.fields["affiliate_id"], decision="needs_review")
    ctx.resolution = replace(ctx.resolution, fields={**ctx.resolution.fields, "affiliate_id": ident})
    assert draft(ctx, services.settings) is None


def test_draft_returns_none_when_the_check_fails(services: Services, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx = _resolved_ctx(services, "clean.csv")

    def failing(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise fastpath.RecipeCheckFailed(["boom"])

    monkeypatch.setattr(fastpath, "build_standard_recipe", failing)
    assert draft(ctx, services.settings) is None


def test_synthetic_two_qualifying_sheets_yield_no_draft(services: Services) -> None:
    wb = Workbook()
    wb.remove(wb.active)
    for name in ("Affiliates", "Affiliates Backup"):
        sheet = wb.create_sheet(name)
        sheet.append(["Affiliate ID", "Affiliate Name"])
        sheet.append(["AFF_9001", "Meridian Capital GP IV, LLC"])
        sheet.append(["AFF_9002", "Summit Growth Management, L.P."])
    raw = io.BytesIO()
    wb.save(raw)
    target = services.stores.objects.local_path("runs/run-1/in/twin.xlsx")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw.getvalue())
    spine = Spine(services)
    patch = spine.resolve(_state("twin.xlsx"))
    assert patch == {"replay": False}
    assert draft(spine.ctx(_state("twin.xlsx")), services.settings) is None

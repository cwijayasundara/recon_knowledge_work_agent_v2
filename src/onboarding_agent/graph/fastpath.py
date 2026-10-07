"""The code fast path: draft a standard brief from the spine's resolution, without a model.

``draft`` proposes what the supervisor would: bindings from the column
resolution and a standard recipe checked in code. It never confirms mapping
history and never passes the brief gate — the analyst still approves.
"""

from __future__ import annotations

from typing import Literal

from onboarding_sdk.resolve import ColumnEvidence, ResolutionSet, evidence_for

from ..config import Settings
from ..run_context import RunContext
from ..tools.recipes import RecipeCheckFailed, build_standard_recipe
from ..tools.resolve import LayoutError
from . import gates
from .state import BindingView, OnboardingBrief, RecipeRef, SourceInfo

SUMMARY = "Proposed by code from the profile and column resolution. Approve, or instruct to change it."
IdStrategy = Literal["source_id", "derive_from_name", "mixed"]


def _evidence(ctx: RunContext, resolution: ResolutionSet, sheet: str) -> dict[str, str]:
    """One evidence line per field, from the resolver's column evidence."""
    columns = [res.column for res in resolution.fields.values() if res.column is not None]
    by_column: dict[str, ColumnEvidence] = {e.column: e for e in evidence_for(ctx.profile(), sheet, columns)}
    lines: dict[str, str] = {}
    for field, res in resolution.fields.items():
        evidence = by_column.get(res.column) if res.column is not None else None
        if evidence is not None:
            samples = "; ".join(evidence.samples[:3])
            pattern = evidence.pattern or "no shared pattern"
            lines[field] = f"column {evidence.column!r}: {evidence.fill_rate:.0%} filled, {pattern}, samples: {samples}"
        elif field == "affiliate_id":
            lines[field] = "no Affiliate ID column resolved; ids are derived from the affiliate name"
        else:
            lines[field] = f"no column resolved for {field.replace('_', ' ')}"
    return lines


def _id_strategy(ctx: RunContext, resolution: ResolutionSet, sheet: str) -> IdStrategy:
    """``source_id`` / ``derive_from_name`` / ``mixed``, from the ID column's coverage."""
    ident = resolution.fields["affiliate_id"]
    if ident.column is None:
        return "derive_from_name"
    fill = next((c.fill_rate for c in ctx.profile().sheet(sheet).columns if c.name == ident.column), 1.0)
    return "source_id" if fill >= 1.0 else "mixed"


def draft(ctx: RunContext, settings: Settings) -> OnboardingBrief | None:
    """Draft a standard brief in code from the spine's candidate resolution.

    The caller must have resolved the candidate sheet (exactly one qualifying
    sheet, per the spine's resolve node) into ``ctx.resolution``. Returns None
    on any unmet trigger condition: no candidate resolution, a needs_review
    field, a name score below the threshold, or a standard recipe that fails
    its check. The drafted brief passes the brief gate against its own recipe
    by construction; the analyst still approves it there.
    """
    resolution = ctx.resolution
    layout = ctx.resolved_layout
    if resolution is None or layout is None:
        return None
    name, ident = resolution.fields["affiliate_name"], resolution.fields["affiliate_id"]
    if name.decision != "matched" or name.score is None or name.score < settings.fastpath_min_score:
        return None
    if ident.decision not in ("matched", "unmapped"):
        return None
    bindings = resolution.bindings()
    name_column = bindings["affiliate_name"]
    if name_column is None:
        return None
    sheet, header_row = layout
    try:
        build_standard_recipe(ctx, sheet, header_row, name_column, bindings["affiliate_id"])
    except (LayoutError, RecipeCheckFailed):
        return None
    assert ctx.candidate_recipe is not None and ctx.bindings is not None and ctx.layout is not None
    evidence = _evidence(ctx, resolution, sheet)
    scores = [res.score for res in resolution.fields.values() if res.score is not None]
    brief = OnboardingBrief(
        source=SourceInfo(file=ctx.upload_path.name, sheet=sheet, header_row=header_row),
        bindings=[
            BindingView(
                field="affiliate_id",
                column=bindings["affiliate_id"],
                route=ident.route,
                confidence=ident.score,
                evidence=evidence["affiliate_id"],
            ),
            BindingView(
                field="affiliate_name",
                column=name_column,
                route=name.route,
                confidence=name.score,
                evidence=evidence["affiliate_name"],
            ),
        ],
        id_strategy=_id_strategy(ctx, resolution, sheet),
        recipe=RecipeRef(kind="standard"),
        expected_findings=[],
        questions=[],
        confidence=min(scores) if scores else 0.0,
        summary=SUMMARY,
    )
    blockers = gates.brief_blockers(brief, ctx.candidate_recipe, ctx.bindings, ctx.layout)
    assert not blockers, f"the fast-path brief must pass its own gate: {blockers}"
    return brief

"""dry_run_changes and submit_proposal. Nothing here applies a change; the spine does, after the analyst confirms."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from langchain_core.tools import BaseTool, tool
from onboarding_sdk import changes as sdk

from ..graph.state import ChangeProposal, TypedChange, to_sdk
from ..run_context import RunContext
from ._common import fail, ok

MAX_PREVIEW = 20


def impact_for(ctx: RunContext, typed: list[Any]) -> sdk.ChangeImpact:
    if ctx.canonical is None:
        raise ValueError("no pipeline result yet")
    columns: tuple[str, ...] = ()
    sheets = tuple(s.name for s in ctx.workbook().sheets)
    if ctx.layout is not None:
        from .resolve import headers_for

        columns = tuple(headers_for(ctx, ctx.layout["sheet"], ctx.layout["header_row"]))
    return sdk.dry_run([to_sdk(c) for c in typed], ctx.canonical, ctx.options, sheets=sheets, columns=columns)


def impact_dict(impact: sdk.ChangeImpact) -> dict[str, Any]:
    return {
        "violations": [asdict(v) for v in impact.violations],
        "requires_rebuild": impact.requires_rebuild,
        "rows_changed": impact.rows_changed,
        "findings_added": impact.findings_added,
        "findings_removed": impact.findings_removed,
        "preview": impact.preview[:MAX_PREVIEW],
        "publishable_before": impact.publishable_before,
        "publishable_after": impact.publishable_after,
    }


def dry_run(ctx: RunContext, typed: list[Any]) -> dict[str, Any]:
    return impact_dict(impact_for(ctx, typed))


def make_change_tools(ctx: RunContext) -> list[BaseTool]:
    @tool
    def dry_run_changes(changes: list[TypedChange]) -> str:
        """Validate typed changes and show their effect without applying them. Refusals name the rule broken."""
        try:
            impact = dry_run(ctx, changes)
        except ValueError as exc:
            return fail(str(exc))
        ctx.last_dry_run = {"changes": [c.model_dump() for c in changes], "impact": impact}
        if impact["violations"]:
            return fail("changes refused", violations=impact["violations"])
        return ok(**impact)

    @tool
    def submit_proposal(proposal: ChangeProposal) -> str:
        """Submit your reading of the analyst's instruction: a restatement plus typed changes, or applicable=false."""
        if proposal.applicable and proposal.changes:
            try:
                impact = dry_run(ctx, list(proposal.changes))
            except ValueError as exc:
                return fail(str(exc))
            if impact["violations"]:
                return fail("changes refused", violations=impact["violations"])
            ctx.last_dry_run = {
                "changes": [c.model_dump() for c in proposal.changes],
                "impact": impact,
            }
        elif proposal.applicable:
            return fail("an applicable proposal needs at least one change; otherwise set applicable=false")
        else:
            proposal = proposal.model_copy(update={"changes": []})
            ctx.last_dry_run = None
        ctx.proposal = proposal
        return ok(stored=True)

    return [dry_run_changes, submit_proposal]

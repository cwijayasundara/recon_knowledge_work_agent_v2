"""submit_brief and submit_report. Code, not the model, fills in routes and counts."""

from __future__ import annotations

from typing import Any

from langchain_core.tools import BaseTool, tool

from ..graph.state import OnboardingBrief, RunReport
from ..run_context import RunContext
from ._common import fail, ok
from .changes import dry_run


def make_brief_tools(ctx: RunContext) -> list[BaseTool]:
    @tool
    def submit_brief(brief: OnboardingBrief) -> str:
        """Submit the onboarding brief for the analyst. At most two questions. Call once, at the end of scoping."""
        if not brief.questions:
            if ctx.candidate_recipe is None:
                return fail("no checked recipe: write or register one, or ask a question")
            if ctx.bindings is None or brief.binding_map() != ctx.bindings:
                return fail("brief bindings differ from the proposed bindings", proposed=ctx.bindings)
            layout = ctx.layout or {}
            if (brief.source.sheet, brief.source.header_row) != (
                layout.get("sheet"),
                layout.get("header_row"),
            ):
                return fail("brief sheet/header row differ from the proposed layout", proposed=layout)
            if brief.recipe.kind != ctx.candidate_recipe["origin"]:
                return fail(f"recipe kind must be {ctx.candidate_recipe['origin']!r}")
        routes = ctx.binding_routes
        bindings = [
            b.model_copy(update={"route": routes.get(b.field, b.route) if routes else "agent"}) for b in brief.bindings
        ]
        source = brief.source
        if ctx.candidate_recipe is not None:
            coverage = ctx.candidate_recipe.get("coverage", {})
            source = source.model_copy(
                update={
                    "rows_read": coverage.get("rows_read", 0),
                    "rows_emitted": coverage.get("rows_emitted", 0),
                    "rows_dropped": coverage.get("rows_dropped", 0),
                    "drop_reasons": sorted({d["reason"] for d in coverage.get("dropped", [])}),
                }
            )
        ctx.brief = brief.model_copy(update={"bindings": bindings, "source": source})
        return ok(stored=True, questions=len(brief.questions))

    @tool
    def submit_report(report: RunReport) -> str:
        """Submit the findings report: a business-language summary, per-code explanations and proposed typed changes."""
        if ctx.result is None:
            return fail("no pipeline result yet")
        kept: list[Any] = []
        refused: list[Any] = []
        for change in report.proposed_changes:
            impact = dry_run(ctx, [change])
            (refused if impact["violations"] else kept).append(change)
        ctx.report = report.model_copy(
            update={
                "findings_by_code": ctx.result.counts_by_code(),
                "blocking_count": len(ctx.result.open_errors()),
                "ack_required": len(ctx.result.unacknowledged(ctx.options.acknowledged)),
                "proposed_changes": kept,
            }
        )
        return ok(stored=True, refused=[c.model_dump() for c in refused])

    return [submit_brief, submit_report]

"""resolve_columns and propose_bindings."""

from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import BaseTool, tool
from onboarding_sdk.resolve import evidence_for

from ..run_context import RunContext
from ._common import fail, ok


class LayoutError(ValueError):
    pass


def headers_for(ctx: RunContext, sheet: str, header_row: int) -> list[str]:
    wb = ctx.workbook()
    try:
        selected = wb.select(sheet)
    except KeyError as exc:
        raise LayoutError(f"no sheet {sheet!r}; sheets are {[s.name for s in wb.sheets]}") from exc
    if not 1 <= header_row <= max(selected.max_row, 1):
        raise LayoutError(f"header row {header_row} is outside sheet {sheet!r}")
    return selected.table(header_row).columns


def set_layout(ctx: RunContext, sheet: str, header_row: int, bindings: dict[str, str | None]) -> dict[str, Any]:
    """Record the proposed sheet, header row and bindings, and share them with the sandbox."""
    columns = headers_for(ctx, sheet, header_row)
    if not bindings.get("affiliate_name"):
        raise LayoutError("affiliate_name must be bound to a column")
    for field, column in bindings.items():
        if field not in ("affiliate_id", "affiliate_name"):
            raise LayoutError(f"unknown field {field!r}")
        if column is not None and column not in columns:
            raise LayoutError(f"{column!r} is not a column of sheet {sheet!r} at row {header_row}")
    routes: dict[str, str | None] = {}
    for field, column in bindings.items():
        res = ctx.resolution.fields.get(field) if ctx.resolution else None
        if column is None:
            routes[field] = None
        elif res is not None and res.column == column and res.decision == "matched":
            routes[field] = res.route
        else:
            routes[field] = "agent"
    # A recipe written for another layout or binding must be written again.
    ctx.candidate_recipe = None
    ctx.layout = {"sheet": sheet, "header_row": header_row}
    ctx.bindings = {
        "affiliate_id": bindings.get("affiliate_id"),
        "affiliate_name": bindings["affiliate_name"],
    }
    ctx.binding_routes = routes
    ref = ctx.mounts.ref_dir
    ref.mkdir(parents=True, exist_ok=True)
    (ref / "bindings.json").write_text(
        json.dumps({"sheet": sheet, "header_row": header_row, "bindings": ctx.bindings}, indent=2)
    )
    return {"layout": ctx.layout, "bindings": ctx.bindings, "routes": routes}


def make_resolve_tools(ctx: RunContext) -> list[BaseTool]:
    @tool
    def resolve_columns(sheet: str, header_row: int) -> str:
        """Resolve the Affiliate ID and Name columns for a sheet and header row.

        Uses this sponsor's confirmed history first, then aliases and fuzzy
        matching. Returns each field's column, route, score, decision and
        candidates, plus value evidence for the candidate columns.
        """
        try:
            headers = headers_for(ctx, sheet, header_row)
        except LayoutError as exc:
            return fail(str(exc))
        resolved_sheet = ctx.workbook().select(sheet).name
        if ctx.resolved_layout == (resolved_sheet, header_row) and ctx.resolution is not None:
            resolution = ctx.resolution  # the spine already resolved this exact layout
        else:
            resolution = ctx.resolver.resolve(ctx.sponsor_id, headers, run_id=ctx.run_id)
            ctx.resolution = resolution
            ctx.resolved_layout = (resolved_sheet, header_row)
        prof = ctx.profile()
        profiled = next((s for s in prof.sheets if s.name == resolved_sheet), None)
        evidence = []
        if profiled is not None and profiled.header_row == header_row:
            evidence = [e.to_dict() for e in evidence_for(prof, profiled.name, headers)]
        fields = {
            name: {
                "column": res.column,
                "route": res.route,
                "score": res.score,
                "decision": res.decision,
                "candidates": [{"column": c.column, "score": c.score, "route": c.route} for c in res.candidates[:5]],
            }
            for name, res in ctx.resolution.fields.items()
        }
        return ok(sheet=sheet, header_row=header_row, headers=headers, fields=fields, evidence=evidence)

    @tool
    def propose_bindings(sheet: str, header_row: int, affiliate_name: str, affiliate_id: str | None = None) -> str:
        """Record the columns you propose for Affiliate ID and Name (affiliate_id=None: the file has no ID column).

        Required before delegating to the recipe engineer; it reads these from /ref/bindings.json.
        Never propose a column that is not in the sheet's header.
        """
        try:
            recorded = set_layout(
                ctx,
                sheet,
                header_row,
                {"affiliate_id": affiliate_id, "affiliate_name": affiliate_name},
            )
        except LayoutError as exc:
            return fail(str(exc))
        return ok(**recorded)

    return [resolve_columns, propose_bindings]

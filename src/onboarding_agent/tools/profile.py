"""profile_upload and recall_recipe."""

from __future__ import annotations

from langchain_core.tools import BaseTool, tool

from ..run_context import RunContext
from ._common import ok


def profile_summary(ctx: RunContext) -> dict[str, object]:
    prof = ctx.profile()
    return {
        "file": prof.file,
        "kind": prof.kind,
        "fingerprint": ctx.fingerprint(),
        "sheets": [
            {
                "name": s.name,
                "header_row": s.header_row,
                "header_candidates": [
                    {"row": c.row, "score": c.score, "cells": [x for x in c.cells if x][:20]}
                    for c in s.header_candidates
                ],
                "row_count": s.row_count,
                "dropped": s.dropped,
                "looks_like_list": s.looks_like_list,
                "columns": [
                    {
                        "name": c.name,
                        "type": c.inferred_type,
                        "fill_rate": c.fill_rate,
                        "distinct": c.distinct,
                        "samples": c.samples,
                        "pattern": c.pattern,
                    }
                    for c in s.columns
                ],
            }
            for s in prof.sheets
        ],
    }


def make_profile_tools(ctx: RunContext) -> list[BaseTool]:
    @tool
    def profile_upload() -> str:
        """Profile the run's upload: sheets, header candidates, columns with samples, and fingerprint."""
        return ok(**profile_summary(ctx))

    @tool
    def recall_recipe() -> str:
        """Look up this sponsor's approved recipe for the upload's layout fingerprint."""
        record = ctx.stores.recipes.find_active(ctx.sponsor_id, ctx.entity, ctx.fingerprint())
        if record is None:
            return ok(found=False)
        return ok(
            found=True,
            recipe_id=record.id,
            version=record.version,
            origin=record.origin,
            bindings=record.bindings,
            layout=record.layout,
        )

    return [profile_upload, recall_recipe]

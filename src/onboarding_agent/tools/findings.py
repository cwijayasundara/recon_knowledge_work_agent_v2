"""get_findings."""

from __future__ import annotations

from langchain_core.tools import BaseTool, tool

from ..run_context import RunContext
from ._common import fail, ok

MAX_FINDINGS = 50


def make_findings_tools(ctx: RunContext) -> list[BaseTool]:
    @tool
    def get_findings(code: str | None = None) -> str:
        """List the current findings (optionally one code) with their row, source row, ITEM_ID and name."""
        if ctx.result is None:
            return fail("no pipeline result yet")
        records = {r.row: r for r in ctx.result.records}
        items = []
        for f in ctx.result.findings:
            if code and f.code != code:
                continue
            record = records.get(f.row) if f.row else None
            items.append(
                {
                    "code": f.code,
                    "severity": f.severity,
                    "row": f.row,
                    "source_row": record.source_row if record else None,
                    "item_id": record.item_id if record else None,
                    "name": record.name[:60] if record else None,
                    "requires_ack": f.requires_ack,
                    "acknowledged": f.key in ctx.options.acknowledged,
                    "message": f.message,
                }
            )
        return ok(count=len(items), findings=items[:MAX_FINDINGS], truncated=len(items) > MAX_FINDINGS)

    return [get_findings]

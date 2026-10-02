"""save_run_note: a hint for the next run with this sponsor. Never a rule, never a binding."""

from __future__ import annotations

from langchain_core.tools import BaseTool, tool

from ..persistence.interfaces import now
from ..run_context import RunContext
from ._common import fail, ok

MAX_NOTE = 500


def sponsor_notes_key(sponsor_id: str) -> str:
    return f"sponsors/{sponsor_id}/AGENTS.md"


def make_note_tools(ctx: RunContext) -> list[BaseTool]:
    @tool
    def save_run_note(text: str) -> str:
        """Append a short note (<=500 chars) for future runs with this sponsor, e.g. how their files are laid out."""
        note = " ".join(text.split())
        if not note:
            return fail("empty note")
        path = ctx.stores.objects.local_path(sponsor_notes_key(ctx.sponsor_id))
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"- {now()[:10]} run {ctx.run_id}: {note[:MAX_NOTE]}\n")
        return ok(saved=True)

    return [save_run_note]

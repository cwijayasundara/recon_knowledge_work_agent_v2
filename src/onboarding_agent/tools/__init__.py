"""Host tools. Each returns compact JSON; none returns raw file rows."""

from __future__ import annotations

from langchain_core.tools import BaseTool

from ..run_context import RunContext
from .brief import make_brief_tools
from .changes import make_change_tools
from .findings import make_findings_tools
from .notes import make_note_tools
from .pipeline import make_pipeline_tools
from .profile import make_profile_tools
from .recipes import make_recipe_tools
from .resolve import make_resolve_tools


def supervisor_tools(ctx: RunContext) -> list[BaseTool]:
    return [
        *make_profile_tools(ctx),
        *make_resolve_tools(ctx),
        *make_recipe_tools(ctx),
        *make_pipeline_tools(ctx),
        *make_findings_tools(ctx),
        *make_change_tools(ctx),
        *make_brief_tools(ctx),
        *make_note_tools(ctx),
    ]

"""The supervisor: scopes the upload, explains findings, and reads analyst instructions."""

from __future__ import annotations

import json
from typing import Any, Literal

from deepagents import CompiledSubAgent, FilesystemPermission, create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models import BaseChatModel

from ..middleware.guard import InvocationGuardMiddleware, ToolSurfacePolicy
from ..run_context import RunContext
from ..tools import supervisor_tools
from ..tools.notes import sponsor_notes_key
from . import recipe_engineer

Mode = Literal["scope", "report", "instruct"]
READ_TOOLS = frozenset({"ls", "read_file", "glob", "grep"})
# After the brief is approved the agent explains and proposes; it cannot touch
# the layout, the bindings or the recipe.
POLICIES: dict[str, ToolSurfacePolicy] = {
    "scope": ToolSurfacePolicy(
        hidden=frozenset(
            {"execute", "delete", "run_pipeline", "get_findings", "dry_run_changes", "submit_report", "submit_proposal"}
        ),
        subagents=frozenset({recipe_engineer.NAME}),
    ),
    "report": ToolSurfacePolicy(
        allowed=READ_TOOLS | {"get_findings", "dry_run_changes", "submit_report", "save_run_note"}
    ),
    "instruct": ToolSurfacePolicy(allowed=READ_TOOLS | {"get_findings", "dry_run_changes", "submit_proposal"}),
}


def build_supervisor(
    model: BaseChatModel,
    ctx: RunContext,
    *,
    prompt: str,
    engineer: Any,
    extra_middleware: list[AgentMiddleware[Any, Any]],
    mode: Mode = "scope",
) -> Any:
    notes = ctx.stores.objects.local_path(sponsor_notes_key(ctx.sponsor_id))
    notes.parent.mkdir(parents=True, exist_ok=True)
    notes.touch(exist_ok=True)
    scratch = ctx.run_dir / "scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    backend = CompositeBackend(
        default=FilesystemBackend(root_dir=scratch, virtual_mode=True),
        routes={
            "/skills/": FilesystemBackend(root_dir=ctx.workspace / "skills", virtual_mode=True),
            # Only this sponsor's notes; other sponsors' directories are not reachable.
            "/notes/": FilesystemBackend(root_dir=notes.parent, virtual_mode=True),
        },
    )
    return create_deep_agent(
        model,
        tools=supervisor_tools(ctx),
        system_prompt=prompt,
        subagents=[
            CompiledSubAgent(
                name=recipe_engineer.NAME,
                description=recipe_engineer.DESCRIPTION,
                runnable=engineer,
            )
        ],
        skills=["/skills/"],
        memory=["/notes/AGENTS.md"],
        backend=backend,
        permissions=[
            FilesystemPermission(operations=["write"], paths=["/skills/**", "/notes/**"], mode="deny"),
        ],
        middleware=[InvocationGuardMiddleware(POLICIES[mode]), *extra_middleware],
        name="supervisor",
    )


def mode_message(mode: Mode, ctx: RunContext, **extra: Any) -> str:
    """The first message of a supervisor invocation. Facts only; the skills say how to act."""
    header = f"Mode: {mode}. Sponsor: {ctx.sponsor_id}. Entity: {ctx.entity}. File: {ctx.upload_path.name}."
    if mode == "scope":
        answers = extra.get("analyst_inputs") or []
        lines = [header, "Scope this upload and finish with submit_brief."]
        if answers:
            lines.append("The analyst has answered or instructed (apply these, ask nothing already answered):")
            lines.append(json.dumps(answers, indent=2))
        return "\n".join(lines)
    if mode == "report":
        return (
            f"{header}\nThe pipeline has run: {json.dumps(extra.get('summary', {}))}.\n"
            "Explain the findings for the analyst (use get_findings), propose typed changes "
            "that would resolve them, and finish with submit_report."
        )
    return (
        f"{header}\nThe analyst said: {extra.get('text', '')!r}\n"
        "Turn this into typed changes, check them with dry_run_changes, and finish with "
        "submit_proposal. If nothing applies, submit applicable=false with a restatement."
    )

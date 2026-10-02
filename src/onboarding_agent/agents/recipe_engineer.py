"""The recipe engineer: a Deep Agent whose only backend is the run's sandbox."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from deepagents import FilesystemPermission, create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models import BaseChatModel

from ..graph.state import RecipeResult
from ..middleware.guard import FS_TOOLS, InvocationGuardMiddleware, ToolSurfacePolicy
from ..run_context import RunContext
from ..sandbox.base import LazySandbox

NAME = "recipe-engineer"
DESCRIPTION = (
    "Writes and verifies a recipe for a non-standard layout (several tables, data across "
    "sheets, pivoted layouts). Call propose_bindings first; say which sheets hold the data."
)
POLICY = ToolSurfacePolicy(allowed=FS_TOOLS | {"execute"}, hidden=frozenset({"task", "delete"}))


def build_recipe_engineer(
    model: BaseChatModel,
    ctx: RunContext,
    *,
    prompt: str,
    extra_middleware: list[AgentMiddleware[Any, Any]],
) -> Any:
    backend = CompositeBackend(
        default=LazySandbox(ctx.sandbox, ctx.run_id),
        routes={"/skills/": FilesystemBackend(root_dir=Path(ctx.workspace) / "skills", virtual_mode=True)},
    )
    return create_deep_agent(
        model,
        tools=[],
        system_prompt=prompt,
        skills=["/skills/"],
        backend=backend,
        # Deep Agents cannot apply path permissions to an executing backend except
        # on routed paths. "Write only /work" is enforced by the container itself:
        # read-only root, /work the only tmpfs, uploads outside /work refused.
        permissions=[FilesystemPermission(operations=["write"], paths=["/skills/**"], mode="deny")],
        middleware=[InvocationGuardMiddleware(POLICY), *extra_middleware],
        response_format=RecipeResult,
        name=NAME,
    )

"""Tool surface policy: what a model is offered, and what it may call.

Filtering the request keeps a hidden tool out of the model's view; the call
guard is the backstop when a model names a tool it was never shown.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

FS_TOOLS = frozenset({"ls", "read_file", "write_file", "edit_file", "glob", "grep"})


@dataclass(frozen=True, slots=True)
class ToolSurfacePolicy:
    allowed: frozenset[str] | None = None
    hidden: frozenset[str] = frozenset()
    # Subagents the ``task`` tool may start; None means any.
    subagents: frozenset[str] | None = None

    def permits(self, name: str) -> bool:
        return name not in self.hidden and (self.allowed is None or name in self.allowed)

    def permits_call(self, name: str, args: dict[str, Any]) -> bool:
        if not self.permits(name):
            return False
        if name == "task" and self.subagents is not None:
            return args.get("subagent_type") in self.subagents
        return True


def _tool_name(tool: Any) -> str:
    if isinstance(tool, dict):
        return str(tool.get("name") or tool.get("function", {}).get("name", ""))
    return str(getattr(tool, "name", ""))


class InvocationGuardMiddleware(AgentMiddleware):
    def __init__(self, policy: ToolSurfacePolicy) -> None:
        super().__init__()
        self.policy = policy

    def _filter(self, request: ModelRequest) -> ModelRequest:
        return request.override(tools=[t for t in request.tools if self.policy.permits(_tool_name(t))])

    def _denial(self, request: ToolCallRequest) -> ToolMessage | None:
        name = request.tool_call["name"]
        if self.policy.permits_call(name, request.tool_call.get("args") or {}):
            return None
        return ToolMessage(
            content=f"Tool {name!r} is not allowed for this agent.",
            tool_call_id=request.tool_call["id"] or "",
            name=name,
            status="error",
        )

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        return handler(self._filter(request))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        return await handler(self._filter(request))

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        return self._denial(request) or handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        return self._denial(request) or await handler(request)

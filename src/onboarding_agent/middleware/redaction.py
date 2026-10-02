"""Scrub secret values from what a model reads and what tools return."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import BaseMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

MASK = "[REDACTED]"
PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{16,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"(?i)(api[_-]?key|secret|password|token)(\s*[:=]\s*)[^\s,;]+"),
)


class Redactor:
    def __init__(self, secrets: Iterable[str] = ()) -> None:
        self.secrets = sorted({s for s in secrets if s and len(s) >= 6}, key=len, reverse=True)

    def text(self, value: str) -> str:
        for secret in self.secrets:
            value = value.replace(secret, MASK)
        for pattern in PATTERNS:
            value = pattern.sub(lambda m: f"{m.group(1)}{m.group(2)}{MASK}" if m.re.groups == 2 else MASK, value)
        return value

    def content(self, content: Any) -> Any:
        if isinstance(content, str):
            return self.text(content)
        if isinstance(content, list):
            return [
                {**block, "text": self.text(block["text"])}
                if isinstance(block, dict) and isinstance(block.get("text"), str)
                else self.text(block)
                if isinstance(block, str)
                else block
                for block in content
            ]
        return content

    def message(self, message: BaseMessage) -> BaseMessage:
        cleaned = self.content(message.content)
        return message if cleaned == message.content else message.model_copy(update={"content": cleaned})


class RedactionMiddleware(AgentMiddleware):
    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self.redactor = Redactor(secrets)

    def _request(self, request: ModelRequest) -> ModelRequest:
        return request.override(messages=[self.redactor.message(m) for m in request.messages])  # type: ignore[misc]

    def _response(self, response: ModelResponse) -> ModelResponse:
        response.result = [self.redactor.message(m) for m in response.result]
        return response

    def _tool(self, result: ToolMessage | Command[Any]) -> ToolMessage | Command[Any]:
        if isinstance(result, ToolMessage):
            cleaned = self.redactor.message(result)
            assert isinstance(cleaned, ToolMessage)
            return cleaned
        return result

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        return self._response(handler(self._request(request)))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        return self._response(await handler(self._request(request)))

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        return self._tool(handler(request))

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        return self._tool(await handler(request))

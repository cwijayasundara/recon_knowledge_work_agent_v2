"""A chat model that replays a script of tool calls. Graph behaviour is tested with this, never a live model."""

from __future__ import annotations

import itertools
from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import ConfigDict, Field

Step = AIMessage | Callable[[list[BaseMessage]], AIMessage]
_ids = itertools.count(1)


def call(name: str, **args: Any) -> dict[str, Any]:
    return {"name": name, "args": args, "id": f"call_{next(_ids)}", "type": "tool_call"}


def tools(*calls: dict[str, Any], text: str = "") -> AIMessage:
    return AIMessage(content=text, tool_calls=list(calls))


def say(text: str) -> AIMessage:
    return AIMessage(content=text)


class ScriptedChatModel(BaseChatModel):
    """Returns the scripted steps in order and records what it was offered."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    script: list[Any] = Field(default_factory=list)
    position: int = 0
    offered: list[list[str]] = Field(default_factory=list)
    seen: list[list[BaseMessage]] = Field(default_factory=list)
    bound_tools: list[str] = Field(default_factory=list)
    name_: str = "scripted"

    @property
    def _llm_type(self) -> str:
        return "scripted"

    @property
    def calls(self) -> int:
        return self.position

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> ScriptedChatModel:  # type: ignore[override]
        names = []
        for tool in tools:
            if isinstance(tool, dict):
                names.append(tool.get("name") or tool.get("function", {}).get("name", "?"))
            else:
                names.append(getattr(tool, "name", "?"))
        self.bound_tools = names
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        if self.position >= len(self.script):
            raise AssertionError(f"scripted model ran out of steps after {self.position} calls")
        step = self.script[self.position]
        self.position += 1
        self.offered.append(list(self.bound_tools))
        self.seen.append(list(messages))
        message = step(messages) if callable(step) else step
        # A fresh copy each time: LangGraph mutates ids on messages it stores.
        message = message.model_copy(deep=True)
        return ChatResult(generations=[ChatGeneration(message=message)])

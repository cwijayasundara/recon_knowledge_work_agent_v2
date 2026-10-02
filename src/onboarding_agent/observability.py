"""OpenTelemetry spans for spine nodes, model calls, tools and sandbox commands.

Console export locally when ONB_OTEL_CONSOLE=1; any OTLP exporter can be added
by the host process. Without a configured provider the spans are no-ops.
"""

from __future__ import annotations

import functools
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from opentelemetry import trace

tracer = trace.get_tracer("onboarding_agent")
_configured = False


def configure() -> None:
    global _configured
    if _configured or os.environ.get("ONB_OTEL_CONSOLE") != "1":
        return
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor

    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
    trace.set_tracer_provider(provider)
    _configured = True


@contextmanager
def span(name: str, **attributes: Any) -> Iterator[trace.Span]:
    with tracer.start_as_current_span(name) as current:
        for key, value in attributes.items():
            if value is not None:
                current.set_attribute(key, value if isinstance(value, str | int | float | bool) else str(value))
        yield current


def traced_node[F: Callable[..., Any]](name: str, fn: F) -> F:
    @functools.wraps(fn)
    def wrapper(state: dict[str, Any]) -> Any:
        with span(f"spine.{name}", run_id=state.get("run_id"), sponsor_id=state.get("sponsor_id")):
            return fn(state)

    return wrapper  # type: ignore[return-value]


class TracingCallback(BaseCallbackHandler):
    """One span per model call and per tool call."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._spans: dict[UUID, Any] = {}

    def _start(self, key: UUID, name: str, **attrs: Any) -> None:
        current = tracer.start_span(name)
        current.set_attribute("run_id", self.run_id)
        for k, v in attrs.items():
            if v is not None:
                current.set_attribute(k, str(v))
        self._spans[key] = current

    def _end(self, key: UUID, error: BaseException | None = None) -> None:
        current = self._spans.pop(key, None)
        if current is not None:
            if error is not None:
                current.record_exception(error)
                current.set_status(trace.Status(trace.StatusCode.ERROR, str(error)))
            current.end()

    def on_chat_model_start(self, serialized: dict[str, Any], messages: Any, *, run_id: UUID, **kw: Any) -> None:
        self._start(run_id, "model.call", model=(kw.get("metadata") or {}).get("ls_model_name"))

    def on_llm_end(self, response: Any, *, run_id: UUID, **kw: Any) -> None:
        self._end(run_id)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kw: Any) -> None:
        self._end(run_id, error)

    def on_tool_start(self, serialized: dict[str, Any], input_str: str, *, run_id: UUID, **kw: Any) -> None:
        self._start(run_id, "tool.call", tool=serialized.get("name"))

    def on_tool_end(self, output: Any, *, run_id: UUID, **kw: Any) -> None:
        self._end(run_id)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kw: Any) -> None:
        self._end(run_id, error)

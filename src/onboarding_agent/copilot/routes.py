"""HTTP routes for the Copilot: start a session, run one step, close it.

No `from __future__ import annotations` here: FastAPI must see the real `Annotated[..., Depends(actor_dep)]`.

Bodies are read and validated by hand so that every bad body is a 422 and never a 500: the cap is enforced while
reading (413), deep nesting and undecodable bytes are refused before parsing finishes, and error details never echo
the input (a lone surrogate in an echoed input cannot be encoded to UTF-8). The routes reach the run only through
the read-only ``run_snapshot`` and ``run_dry_run`` callables; they never touch the graph or its gates.
"""

import json
import logging
from collections.abc import Callable
from typing import Annotated, Any, cast

import anyio
import anyio.to_thread
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ValidationError

from ..assembly import Services
from ..config import Settings
from .engine import CopilotEngine, StepConflict
from .schemas import ALL_TOOLS, StartIn, StepIn, _inline
from .sessions import SessionNotFound, SessionStore, TooManySessions

_log = logging.getLogger("onboarding_agent.copilot.routes")

MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_BODY_DEPTH = 32
_NOT_FOUND = "session not found"
_LOC_CHARS = 100


class _RunAccess:
    """Adapts the API's run helpers to the engine: a missing run is a KeyError, any other refusal a ValueError."""

    def __init__(
        self,
        snapshot: Callable[[str], dict[str, Any]],
        dry_run: Callable[[str, list[Any]], dict[str, Any]],
    ) -> None:
        self._snapshot = snapshot
        self._dry_run = dry_run

    def snapshot(self, run_id: str) -> dict[str, Any]:
        return _mapped(self._snapshot, run_id)

    def dry_run(self, run_id: str, changes: list[Any]) -> dict[str, Any]:
        return _mapped(self._dry_run, run_id, changes)


def _mapped(fn: Callable[..., dict[str, Any]], *args: Any) -> dict[str, Any]:
    try:
        return fn(*args)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise KeyError("run not found") from None
        raise ValueError("run unavailable") from None


def _safe(text: object) -> str:
    return str(text).encode("utf-8", "replace").decode("utf-8")[:_LOC_CHARS]


def _too_deep(value: object) -> bool:
    stack: list[tuple[object, int]] = [(value, 0)]
    while stack:
        node, depth = stack.pop()
        if isinstance(node, dict | list):
            if depth >= MAX_BODY_DEPTH:
                return True
            stack.extend((v, depth + 1) for v in (node.values() if isinstance(node, dict) else node))
    return False


async def _json_body(request: Request) -> Any:
    media = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media != "application/json":
        raise HTTPException(415, "content type must be application/json")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(413, "request too large")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BODY_BYTES:
            raise HTTPException(413, "request too large")
    if not data.strip():
        return {}
    try:
        value = json.loads(bytes(data))
    except RecursionError:
        raise HTTPException(422, "request body is nested too deeply") from None
    except ValueError:  # JSONDecodeError and UnicodeDecodeError
        raise HTTPException(422, "request body is not valid JSON") from None
    if _too_deep(value):
        raise HTTPException(422, "request body is nested too deeply")
    return value


def _validated[M: BaseModel](model: type[M], value: Any) -> M:
    try:
        return model.model_validate(value)
    except ValidationError as exc:
        errors = exc.errors(include_url=False, include_input=False, include_context=False)
        detail = [
            {
                "loc": [p if isinstance(p, int) else _safe(p) for p in err.get("loc", ())],
                "msg": _safe(err.get("msg", "invalid")),
                "type": _safe(err.get("type", "value_error")),
            }
            for err in errors[:10]
        ]
        raise HTTPException(422, detail) from None


def _body_doc(model: type[BaseModel]) -> dict[str, Any]:
    """The request body for the API docs; bodies are parsed by hand, so FastAPI cannot infer it."""
    schema = model.model_json_schema()
    inlined = _inline(schema, schema.get("$defs", {}))
    return {"requestBody": {"required": True, "content": {"application/json": {"schema": inlined}}}}


def register_copilot(
    app: FastAPI,
    *,
    settings: Settings,
    services: Services,
    actor_dep: Callable[..., str],
    run_snapshot: Callable[[str], dict[str, Any]],
    run_dry_run: Callable[[str, list[Any]], dict[str, Any]],
) -> None:
    store = SessionStore(
        settings.copilot_session_ttl_s,
        settings.copilot_max_sessions_per_actor,
        max_lifetime_s=settings.copilot_session_max_lifetime_s,
    )
    # The engine only ever asks for the "copilot" role, a valid ModelFactory role.
    factory = cast(Callable[[str], Any], services.model_factory)
    engine = CopilotEngine(settings, factory, _RunAccess(run_snapshot, run_dry_run), store)
    app.state.copilot = engine
    Actor = Annotated[str, Depends(actor_dep)]
    # Steps hold a worker thread for whole model calls. They get their own threads, and at most
    # copilot_max_concurrent_steps run at once, so they can never take the threads the other routes use.
    slots = settings.copilot_max_concurrent_steps
    admission = anyio.CapacityLimiter(slots)
    threads = anyio.CapacityLimiter(slots)

    def enabled() -> None:
        if not settings.copilot_enabled:
            raise HTTPException(403, "copilot is disabled")

    @app.post("/copilot/sessions", openapi_extra=_body_doc(StartIn))
    async def start_session(request: Request, who: Actor) -> dict[str, Any]:
        enabled()
        body = _validated(StartIn, await _json_body(request))
        if body.run_id is not None:
            # The same existence check `GET /runs/{run_id}` applies; it raises 404 for an unknown run.
            await run_in_threadpool(run_snapshot, body.run_id)
        try:
            sess = engine.start(who, body.run_id)
        except TooManySessions:
            raise HTTPException(429, "too many copilot sessions") from None
        return {
            "session_id": sess.id,
            "limits": {
                "max_cells_per_call": settings.copilot_max_cells_per_call,
                "max_cells_per_session": settings.copilot_max_cells_per_session,
                "max_steps_per_turn": settings.copilot_max_steps_per_turn,
                "max_write_cells": settings.copilot_max_write_cells,
                "cell_char_limit": settings.copilot_cell_char_limit,
            },
            "tools": sorted(ALL_TOOLS),
            "run_bound": body.run_id is not None,
        }

    @app.post("/copilot/sessions/{session_id}/step", openapi_extra=_body_doc(StepIn))
    async def step(session_id: str, request: Request, who: Actor) -> dict[str, Any]:
        enabled()
        body = _validated(StepIn, await _json_body(request))
        borrower = object()
        try:
            # Atomic check-and-take: two requests can never both pass a "tokens left" check for the last slot.
            admission.acquire_on_behalf_of_nowait(borrower)
        except anyio.WouldBlock:
            raise HTTPException(503, "copilot is busy", headers={"Retry-After": "5"}) from None
        # Model calls block: run the step on a worker thread. If the client goes away the step still finishes
        # there, releases the session lock and only then frees its slot.
        try:
            out = await anyio.to_thread.run_sync(engine.step, session_id, who, body, limiter=threads)
        except SessionNotFound:
            raise HTTPException(404, _NOT_FOUND) from None
        except StepConflict as exc:
            raise HTTPException(409, str(exc)) from None
        except Exception as exc:  # no exception text: it may carry workbook or user content
            _log.error("copilot step failed: %s", type(exc).__name__)
            raise HTTPException(500, "internal error") from None
        finally:
            admission.release_on_behalf_of(borrower)
        return out.model_dump(mode="json")

    @app.delete("/copilot/sessions/{session_id}", status_code=204)
    def close_session(session_id: str, who: Actor) -> Response:
        enabled()
        try:
            engine.close_if_idle(session_id, who)
        except SessionNotFound:
            raise HTTPException(404, _NOT_FOUND) from None
        except StepConflict as exc:  # the session keeps its slot until its step ends
            raise HTTPException(409, str(exc)) from None
        return Response(status_code=204)

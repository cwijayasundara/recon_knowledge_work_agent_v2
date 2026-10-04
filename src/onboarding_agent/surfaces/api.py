"""HTTP API for the workbench: runs, gates, grid data, artifacts and the SSE event stream.

No `from __future__ import annotations` here: FastAPI must see the real
`Actor` dependency type defined inside `create_app`.

Graph work (agent calls, builds) runs on a worker thread per run; requests
return at once and progress arrives as events.
"""

import hmac
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Any

import yaml
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from onboarding_sdk.entities.affiliate import explain_derivation
from pydantic import BaseModel, Field, ValidationError
from sse_starlette.sse import EventSourceResponse

from ..assembly import Services, build_checkpointer, build_services
from ..config import Settings
from ..copilot.routes import register_copilot
from ..graph.build import UploadRejected, Workbench, snapshot_defaults
from ..graph.state import GateResponse, TypedChange
from ..tools.changes import dry_run
from .sse import EventHub, sse_message

MEDIA_TYPES = {
    "csv": "text/csv; charset=utf-8",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "json": "application/json",
}
PAGE_MAX = 500


class SponsorIn(BaseModel):
    id: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9\-]{0,62}$")
    name: str = Field(min_length=1)


class DryRunIn(BaseModel):
    changes: list[TypedChange]


class Jobs:
    """One worker job per run at a time; errors are kept for the snapshot."""

    def __init__(self, hub: EventHub, *, inline: bool = False) -> None:
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="run")
        self._busy: set[str] = set()
        self._errors: dict[str, str] = {}
        self._lock = threading.Lock()
        self._hub = hub
        self._inline = inline

    def busy(self, run_id: str) -> bool:
        with self._lock:
            return run_id in self._busy

    def error(self, run_id: str) -> str | None:
        return self._errors.get(run_id)

    def submit(self, run_id: str, fn: Any, *args: Any) -> None:
        with self._lock:
            if run_id in self._busy:
                raise HTTPException(409, "the run is already working")
            self._busy.add(run_id)
            self._errors.pop(run_id, None)

        def job() -> None:
            try:
                fn(*args)
            except Exception as exc:
                self._errors[run_id] = f"{type(exc).__name__}: {exc}"
                self._hub.publish(run_id, "error", {"message": self._errors[run_id]})
            finally:
                with self._lock:
                    self._busy.discard(run_id)
                self._hub.publish(run_id, "idle", {})

        if self._inline:
            job()
        else:
            self._pool.submit(job)


def create_app(
    settings: Settings | None = None,
    *,
    services: Services | None = None,
    inline_jobs: bool = False,
) -> FastAPI:
    settings = settings or (services.settings if services else Settings())
    services = services or build_services(settings)
    hub = EventHub()
    bench = Workbench(services, checkpointer=build_checkpointer(services), sink=hub.publish)
    jobs = Jobs(hub, inline=inline_jobs)
    app = FastAPI(title="Onboarding workbench")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Retry-After"],  # the pane backs off on a busy copilot (503)
    )
    app.state.workbench, app.state.hub, app.state.jobs = bench, hub, jobs
    for entry in filter(None, (e.strip() for e in settings.seed_sponsors.split(","))):
        sponsor_id, _, name = entry.partition(":")
        services.stores.sponsors.add(sponsor_id.strip(), name.strip() or sponsor_id.strip())

    def actor(
        authorization: Annotated[str | None, Header()] = None,
        x_actor: Annotated[str | None, Header()] = None,
        access_token: Annotated[str | None, Query()] = None,
        actor: Annotated[str | None, Query()] = None,
        x_ms_client_principal_name: Annotated[str | None, Header()] = None,
    ) -> str:
        if settings.trust_easy_auth:
            if not x_ms_client_principal_name:
                raise HTTPException(401, "sign-in required")
            return x_ms_client_principal_name
        # EventSource cannot set headers, so the SSE stream may pass both as query parameters.
        token = settings.api_token
        x_actor = x_actor or actor
        if token:
            supplied = (authorization or "").removeprefix("Bearer ").strip() or (access_token or "")
            if not hmac.compare_digest(supplied, token):
                raise HTTPException(401, "invalid or missing bearer token")
        return (x_actor or "analyst").strip() or "analyst"

    Actor = Annotated[str, Depends(actor)]

    def snapshot(run_id: str) -> dict[str, Any]:
        record = services.stores.runs.get(run_id)
        try:
            snap = bench.snapshot(run_id)
        except KeyError as exc:
            if record is None:
                raise HTTPException(404, "run not found") from exc
            snap = {
                **snapshot_defaults(),
                "run_id": run_id,
                "sponsor_id": record.sponsor_id,
                "entity": record.entity,
                "upload": {"key": record.upload_uri, "name": record.upload_name, "sha256": record.upload_sha},
                "pending": None,
            }
        return {
            **snap,
            "working": jobs.busy(run_id),
            "job_error": jobs.error(run_id),
            "decisions": [asdict(d) for d in services.stores.decisions.list(run_id)],
            "record": asdict(record) if record else None,
        }

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/sponsors", status_code=201)
    def add_sponsor(body: SponsorIn, _: Actor) -> dict[str, str]:
        services.stores.sponsors.add(body.id, body.name)
        return {"id": body.id, "name": body.name}

    @app.get("/sponsors")
    def list_sponsors(_: Actor) -> list[dict[str, str]]:
        return services.stores.sponsors.list()

    @app.get("/sponsors/{sponsor_id}/history")
    def sponsor_history(sponsor_id: str, _: Actor) -> dict[str, Any]:
        if sponsor_id == "*":
            raise HTTPException(400, "history is per sponsor")
        recipes = services.stores.recipes.list(sponsor_id)
        return {
            "sponsor_id": sponsor_id,
            "bindings": [
                {
                    "fingerprint": r.fingerprint,
                    "version": r.version,
                    "active": r.active,
                    "bindings": r.bindings,
                    "layout": r.layout,
                    "origin": r.origin,
                    "approved_by": r.approved_by,
                    "approved_at": r.approved_at,
                }
                for r in recipes
            ],
        }

    @app.get("/flows/{entity}")
    def flow(entity: str) -> dict[str, Any]:
        path = services.workspace / "flows" / f"{entity}.flow.yaml"
        if not path.is_file():
            raise HTTPException(404, f"no flow for {entity!r}")
        return yaml.safe_load(path.read_text(encoding="utf-8"))  # type: ignore[no-any-return]

    @app.post("/runs", status_code=202)
    async def create_run(
        who: Actor,
        sponsor_id: Annotated[str, Form()],
        file: Annotated[UploadFile, File()],
        entity: Annotated[str, Form()] = "affiliate",
    ) -> dict[str, str]:
        data = await file.read()
        try:
            run_id = bench.create(
                sponsor_id=sponsor_id, entity=entity, file_name=file.filename or "upload", data=data, actor=who
            )
        except UploadRejected as exc:
            raise HTTPException(422, str(exc)) from exc
        jobs.submit(run_id, bench.advance, run_id)
        return {"run_id": run_id}

    @app.get("/runs")
    def list_runs(_: Actor, sponsor_id: str | None = None) -> list[dict[str, Any]]:
        return [asdict(r) for r in services.stores.runs.list(sponsor_id)]

    @app.get("/runs/{run_id}")
    def get_run(run_id: str, _: Actor) -> dict[str, Any]:
        return snapshot(run_id)

    @app.post("/runs/{run_id}/gate", status_code=202)
    def gate(run_id: str, body: dict[str, Any], who: Actor) -> dict[str, Any]:
        try:
            response = GateResponse.model_validate({**body, "actor": who})
        except ValidationError as exc:
            raise HTTPException(422, exc.errors()[0]["msg"]) from exc
        if jobs.busy(run_id):
            raise HTTPException(409, "the run is already working")
        if bench.pending(run_id) is None:
            raise HTTPException(409, "the run is not waiting at a gate")
        jobs.submit(run_id, bench.respond, run_id, response.model_dump())
        return {"accepted": True}

    @app.post("/runs/{run_id}/dry-run")
    def dry_run_changes(run_id: str, body: DryRunIn, _: Actor) -> dict[str, Any]:
        ctx = _context(run_id)
        try:
            return dry_run(ctx, list(body.changes))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    def _context(run_id: str) -> Any:
        try:
            state = bench.snapshot(run_id)
        except KeyError as exc:
            raise HTTPException(404, "run not found") from exc
        ctx = bench.spine.ctx(state)  # type: ignore[arg-type]
        terminal = state.get("status") in ("locked", "rejected")
        authored = (ctx.candidate_recipe or {}).get("origin") == "authored"
        # Never start a sandbox for a read on a finished run.
        if terminal and authored:
            return ctx
        if ctx.result is None and ctx.candidate_recipe is not None and not jobs.busy(run_id):
            from ..tools.pipeline import RecipeFailed, build

            try:
                build(ctx, ctx.candidate_recipe)
            except RecipeFailed as exc:
                raise HTTPException(409, f"recipe failed: {exc}") from exc
        return ctx

    @app.get("/runs/{run_id}/grid")
    def grid(
        run_id: str,
        _: Actor,
        view: Annotated[str, Query(pattern="^(source|preview|ids)$")] = "preview",
        offset: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=PAGE_MAX)] = 100,
    ) -> dict[str, Any]:
        ctx = _context(run_id)
        if view == "source":
            layout = ctx.layout or {}
            sheet = ctx.workbook().select(layout["sheet"]) if layout else ctx.workbook().sheets[0]
            rows = [
                {"row": i, "cells": ["" if v is None else str(v) for v in r]} for i, r in enumerate(sheet.grid, start=1)
            ]
            return {
                "view": view,
                "sheet": sheet.name,
                "header_row": layout.get("header_row"),
                "total": len(rows),
                "rows": rows[offset : offset + limit],
            }
        if ctx.result is None:
            return {"view": view, "total": 0, "rows": []}
        by_row: dict[int, list[str]] = {}
        for f in ctx.result.findings:
            if f.row:
                by_row.setdefault(f.row, []).append(f.code)
        trace: dict[int, dict[str, Any]] = {}
        for t in ctx.result.trace:
            trace.setdefault(t.output_row, {})[t.target_column] = {
                "rule_id": t.rule_id,
                "operation": t.operation,
                "source_sheet": t.source_sheet,
                "source_row": t.source_row,
                "source_field": t.source_field,
                "source_column": (ctx.bindings or {}).get(t.source_field) if t.source_field else None,
            }
        canonical = {i: r for i, r in enumerate(ctx.canonical.rows, start=1)} if ctx.canonical else {}
        rows = [
            {
                "row": r.row,
                **r.as_template_row(),
                "id_method": r.id_method,
                "source_sheet": r.source_sheet,
                "source_row": r.source_row,
                "source_id": canonical[r.row].affiliate_id if r.row in canonical else None,
                "source_name": canonical[r.row].affiliate_name if r.row in canonical else None,
                "flags": by_row.get(r.row, []),
                "derivation": explain_derivation(canonical[r.row].affiliate_name or "", ctx.result.policy.item_id_limit)
                if r.id_method == "derived" and r.row in canonical
                else None,
                "lineage": trace.get(r.row, {}),
            }
            for r in ctx.result.records
        ]
        return {
            "view": view,
            "total": len(rows),
            "rows": rows[offset : offset + limit],
            "item_id_limit": ctx.result.policy.item_id_limit,
        }

    @app.get("/runs/{run_id}/artifacts/{name}")
    def artifact(run_id: str, name: str, _: Actor) -> Response:
        state = snapshot(run_id)
        entry = next((a for a in state.get("artifacts", []) if a["name"] == name), None)
        if entry is None:
            raise HTTPException(404, "no such artifact")
        data = services.stores.objects.get(entry["key"])
        return Response(
            data,
            media_type=MEDIA_TYPES.get(entry["kind"], "application/octet-stream"),
            headers={"Content-Disposition": f'attachment; filename="{Path(name).name}"'},
        )

    @app.get("/runs/{run_id}/events")
    async def events(run_id: str, request: Request, _: Actor) -> EventSourceResponse:
        raw = request.headers.get("last-event-id") or "0"
        after = int(raw) if raw.isdigit() else 0

        async def stream() -> Any:
            async for event in hub.stream(run_id, after):
                if await request.is_disconnected():
                    break
                yield sse_message(event)

        return EventSourceResponse(stream(), ping=15)

    register_copilot(
        app,
        settings=settings,
        services=services,
        actor_dep=actor,
        run_snapshot=snapshot,
        run_dry_run=lambda run_id, changes: dry_run(_context(run_id), changes),
    )
    return app


def app_factory() -> FastAPI:
    """Entry point for ``uvicorn --factory onboarding_agent.surfaces.api:app_factory``."""
    return create_app()

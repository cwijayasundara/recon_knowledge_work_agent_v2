"""Spine nodes. The spine owns phases, gates and every write that matters.

Agents run inside ``scope``, ``report`` and gate ``instruct`` handling; their
outputs land in the run context and are copied into state here. Only these
nodes confirm mapping history, freeze recipes, apply changes and render files.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any

from langgraph.types import interrupt
from onboarding_sdk import changes as sdk_changes
from onboarding_sdk import manifest, render, review
from onboarding_sdk import profile as sdk_profile
from onboarding_sdk.entities.affiliate import AffiliateOptions
from onboarding_sdk.resolve import FieldDecision, ResolutionSet
from pydantic import ValidationError

from ..assembly import Services, invoke_supervisor, run_context
from ..persistence.interfaces import ArtifactRecord, RecipeRecord, RunRecord, now
from ..run_context import RunContext
from ..tools.changes import impact_dict, impact_for
from ..tools.notes import sponsor_notes_key
from ..tools.pipeline import RecipeFailed, build, result_key, summarize
from ..tools.resolve import LayoutError, headers_for, set_layout
from . import gates
from .state import (
    BindingView,
    ChangeProposal,
    GateResponse,
    OnboardingBrief,
    RecipeRef,
    RunReport,
    SourceInfo,
    SpineState,
    to_sdk,
)

log = logging.getLogger(__name__)
EventSink = Callable[[str, str, dict[str, Any]], None]
State = dict[str, Any]


def _no_sink(run_id: str, kind: str, payload: dict[str, Any]) -> None:
    del run_id, kind, payload


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _candidate_sheets(prof: sdk_profile.WorkbookProfile, min_list: float) -> list[tuple[str, int]]:
    """Sheets worth resolving for the fast path, in profile order.

    Several profiled sheets: the list-like ones — list-ness bounds the
    resolver's work and qualification decides. A lone profiled sheet is
    resolved whatever its list score: there is nothing to choose between,
    and a header-only CSV scores 0 for want of data rows.
    """
    profiled = [s for s in prof.sheets if s.header_row is not None]
    chosen = [s for s in profiled if s.looks_like_list >= min_list] or (profiled if len(profiled) == 1 else [])
    out = []
    for sheet in chosen:
        assert sheet.header_row is not None  # filtered above
        out.append((sheet.name, sheet.header_row))
    return out


def _qualifies(resolution: ResolutionSet, min_score: float) -> bool:
    """A sheet qualifies when its name resolves confidently and its ID is matched or absent."""
    name, ident = resolution.fields["affiliate_name"], resolution.fields["affiliate_id"]
    return (
        name.decision == "matched"
        and name.score is not None
        and name.score >= min_score
        and ident.decision in ("matched", "unmapped")
    )


def _resolution_summary(sheet: str, header_row: int, resolution: ResolutionSet) -> dict[str, Any]:
    """Per-field column/route/score/decision view of a spine resolution, for state."""
    return {
        "sheet": sheet,
        "header_row": header_row,
        "fields": {
            name: {"column": res.column, "route": res.route, "score": res.score, "decision": res.decision}
            for name, res in resolution.fields.items()
        },
    }


class Spine:
    def __init__(self, services: Services, sink: EventSink | None = None) -> None:
        self.services = services
        self.sink = sink or _no_sink
        self._contexts: dict[str, RunContext] = {}

    # ---- plumbing ---------------------------------------------------------

    def emit(self, run_id: str, kind: str, payload: dict[str, Any]) -> None:
        try:
            self.sink(run_id, kind, payload)
        except Exception:  # an observer must never break a run
            log.exception("event sink failed for %s", kind)

    def step(self, run_id: str, step_id: str, state: str, content: dict[str, Any] | None = None) -> None:
        self.emit(
            run_id,
            "step",
            {"phase": step_id.split(".")[0], "step_id": step_id, "state": state, "content": content or {}},
        )

    def ctx(self, state: SpineState) -> RunContext:
        run_id = state["run_id"]
        ctx = self._contexts.get(run_id)
        if ctx is not None:
            return ctx
        # A fresh process (or a restart between gates) rebuilds the context from state.
        ctx = run_context(
            self.services,
            run_id=run_id,
            sponsor_id=state["sponsor_id"],
            entity=state.get("entity", "affiliate"),
            actor=state.get("actor", "analyst"),
            upload_path=self.services.stores.objects.local_path(state["upload"]["key"]),
            emit=lambda kind, payload: self.emit(run_id, kind, payload),
        )
        ctx.options = AffiliateOptions.from_dict(state.get("options") or {})
        ctx.layout = state.get("layout")
        ctx.bindings = state.get("bindings")
        ctx.binding_routes = state.get("binding_routes") or {}
        ctx.candidate_recipe = state.get("recipe")
        ctx.model_calls = state.get("model_calls", 0)
        if state.get("brief"):
            ctx.brief = OnboardingBrief.model_validate(state["brief"])
        if resolution := state.get("resolution"):
            ctx.resolution = ResolutionSet.from_dict(resolution)
        self._contexts[run_id] = ctx
        self._pin(state, ctx)
        return ctx

    def _pin(self, state: SpineState, ctx: RunContext) -> None:
        """After approval, only the approved snapshot counts: whatever an agent left in the
        shared context is replaced, and a result built from anything else is discarded."""
        approved = state.get("approved")
        if not approved:
            return
        ctx.candidate_recipe = dict(approved["recipe"])
        ctx.bindings = dict(approved["bindings"])
        ctx.layout = dict(approved["layout"])
        ctx.binding_routes = dict(approved.get("routes") or {})
        ctx.options = AffiliateOptions.from_dict(state.get("options") or {})
        if ctx.result_key != result_key(ctx, ctx.candidate_recipe):
            ctx.result = None
            ctx.canonical = None

    @staticmethod
    def _snapshot(ctx: RunContext) -> dict[str, Any]:
        assert ctx.candidate_recipe is not None
        return {
            "recipe": dict(ctx.candidate_recipe),
            "bindings": dict(ctx.bindings or {}),
            "layout": dict(ctx.layout or {}),
            "routes": dict(ctx.binding_routes or {}),
        }

    def forget(self, run_id: str) -> None:
        ctx = self._contexts.pop(run_id, None)
        if ctx is not None:
            ctx.close()

    def _ensure_result(self, ctx: RunContext) -> str | None:
        """Rebuild the result after a restart. Returns the failure, if any, instead of raising."""
        if ctx.result is None and ctx.candidate_recipe is not None:
            try:
                build(ctx, ctx.candidate_recipe)
            except RecipeFailed as exc:
                self.emit(ctx.run_id, "error", {"message": f"recipe failed: {exc}"})
                return f"recipe failed: {exc}"
        return None

    def _record(self, state: SpineState, kind: str, payload: dict[str, Any], actor: str) -> None:
        entry = self.services.stores.decisions.append(state["run_id"], kind, payload, actor)
        self.emit(state["run_id"], "decision", {"entry": asdict(entry)})

    def _context_patch(self, ctx: RunContext) -> State:
        return {
            "layout": ctx.layout,
            "bindings": ctx.bindings,
            "binding_routes": ctx.binding_routes,
            "recipe": ctx.candidate_recipe,
            "brief": ctx.brief.model_dump() if ctx.brief else None,
            "resolution": ctx.resolution.to_dict() if ctx.resolution else None,
            "model_calls": ctx.model_calls,
        }

    def _gate(self, state: SpineState, payload: dict[str, Any]) -> GateResponse | str:
        """Pause for the analyst. Returns the parsed response, or an error message."""
        self.emit(state["run_id"], "gate", payload)
        raw = interrupt(payload)
        try:
            return GateResponse.model_validate(raw)
        except ValidationError as exc:
            return f"invalid gate response: {exc.errors()[0]['msg']}"

    # ---- nodes ------------------------------------------------------------

    def intake(self, state: SpineState) -> State:
        ctx = self.ctx(state)
        data = ctx.upload_path.read_bytes()
        fingerprint = ctx.fingerprint()
        stores = self.services.stores
        if stores.runs.get(ctx.run_id) is None:
            stores.runs.create(
                RunRecord(
                    ctx.run_id,
                    ctx.sponsor_id,
                    ctx.entity,
                    "scoping",
                    state["upload"]["key"],
                    _sha(data),
                    fingerprint,
                    ctx.actor,
                    now(),
                    now(),
                    ctx.upload_path.name,
                )
            )
        record = stores.recipes.find_active(ctx.sponsor_id, ctx.entity, fingerprint)
        prof = ctx.profile()
        self.step(
            ctx.run_id, "p1.upload", "done", {"file": ctx.upload_path.name, "sha256": _sha(data), "bytes": len(data)}
        )
        self.step(
            ctx.run_id,
            "p1.read",
            "running",
            {"sheets": [{"name": s.name, "rows": s.row_count, "header_row": s.header_row} for s in prof.sheets]},
        )
        self.emit(ctx.run_id, "phase", {"phase": "p1", "state": "active"})
        return {
            "upload": {**state["upload"], "sha256": _sha(data), "name": ctx.upload_path.name},
            "fingerprint": fingerprint,
            "recall": asdict(record) if record else None,
            "phase": "p1",
            "status": "scoping",
            "options": AffiliateOptions().to_dict(),
            "analyst_inputs": [],
            "approvers": [],
            "artifacts": [],
            "model_calls": 0,
            "replay": False,
            "gate_message": None,
            "error": None,
        }

    def _resolve_candidate(self, state: SpineState) -> State:
        """Fast path step 1: resolve the candidate sheet in code, without a model.

        Every candidate sheet is resolved at its profiled header row; a sheet
        qualifies when its name field matches at or above the score threshold
        and its ID field is matched or absent. Exactly one qualifying sheet is
        the candidate: its ResolutionSet is cached on the context and a summary
        lands in state, so the brief draft and tests can read what the spine
        resolved; the supervisor's resolve_columns tool reuses the cached set
        for the same layout instead of resolving twice.

        With none or several qualifying sheets there is no candidate: the
        single-slot cache cannot say which sheet it holds, so it is dropped
        and this returns {} — the node returns exactly {"replay": False} and
        the supervisor scopes as before, resolving whatever it chooses.
        """
        if not self.services.settings.fastpath:
            return {}
        ctx = self.ctx(state)
        min_score = self.services.settings.fastpath_min_score
        qualified: list[tuple[str, int, ResolutionSet]] = []
        for asked, header_row in _candidate_sheets(ctx.profile(), self.services.settings.fastpath_min_list):
            # A CSV's sheet is named after its file, whatever name was asked for.
            name = ctx.workbook().select(asked).name
            if ctx.resolved_layout == (name, header_row) and ctx.resolution is not None:
                resolution = ctx.resolution  # already resolved this exact layout above
            else:
                try:
                    headers = headers_for(ctx, asked, header_row)
                except LayoutError:
                    continue
                resolution = self.services.resolver.resolve(ctx.sponsor_id, headers, run_id=ctx.run_id)
                ctx.resolution = resolution
                ctx.resolved_layout = (name, header_row)
            if _qualifies(resolution, min_score):
                qualified.append((name, header_row, resolution))
        if len(qualified) != 1:
            ctx.resolution = None
            ctx.resolved_layout = None
            return {}
        sheet, header_row, resolution = qualified[0]
        ctx.resolution = resolution
        ctx.resolved_layout = (sheet, header_row)
        return {"resolution_summary": _resolution_summary(sheet, header_row, resolution)}

    def resolve(self, state: SpineState) -> State:
        """Replay when this sponsor has an approved recipe and history still resolves its bindings."""
        recall = state.get("recall")
        if not recall:
            return {**self._resolve_candidate(state), "replay": False}
        ctx = self.ctx(state)
        layout = recall["layout"]
        try:
            headers = headers_for(ctx, layout["sheet"], layout["header_row"])
        except LayoutError:
            return {**self._resolve_candidate(state), "replay": False}
        resolution = self.services.resolver.resolve(ctx.sponsor_id, headers, run_id=ctx.run_id)
        ctx.resolution = resolution
        # A CSV's sheet is named after its file; show this upload's name, not the recalled one's.
        layout = {**layout, "sheet": ctx.workbook().select(layout["sheet"]).name}
        ctx.resolved_layout = (layout["sheet"], layout["header_row"])
        source = self.services.stores.objects.local_path(recall["source_uri"])
        if (
            not resolution.replays(recall["bindings"])
            or not source.is_file()
            or _sha(source.read_bytes()) != recall["sha256"]
        ):
            # Not replaying: still resolve the fast path's candidate sheet for scope to reuse.
            return {**self._resolve_candidate(state), "replay": False}
        set_layout(ctx, layout["sheet"], layout["header_row"], recall["bindings"])
        ctx.candidate_recipe = {
            "origin": recall["origin"],
            "path": str(source),
            "sha256": recall["sha256"],
            "recipe_id": recall["id"],
            "version": recall["version"],
            "source_uri": recall["source_uri"],
            "recalled": True,
            "bindings": dict(recall["bindings"]),
            "layout": dict(layout),
        }
        bindings = recall["bindings"]
        ctx.brief = OnboardingBrief(
            source=SourceInfo(file=ctx.upload_path.name, sheet=layout["sheet"], header_row=layout["header_row"]),
            bindings=[
                BindingView(
                    field=f,
                    column=c,
                    route=ctx.binding_routes.get(f),
                    confidence=1.0 if c else None,
                    evidence="confirmed for this sponsor before",
                )
                for f, c in bindings.items()
            ],
            id_strategy="source_id" if bindings.get("affiliate_id") else "derive_from_name",
            recipe=RecipeRef(kind="recalled", id=recall["id"]),
            confidence=1.0,
            summary=f"Recalled from history: recipe {recall['id']} v{recall['version']}; no questions.",
        )
        self.step(ctx.run_id, "p1.read", "done", {"recalled": True, "layout": layout})
        self.step(ctx.run_id, "p1.saved", "done", {"recalled_from_history": True, "bindings": bindings})
        self.emit(ctx.run_id, "brief", ctx.brief.model_dump())
        self._record(state, "brief.recalled", {"recipe_id": recall["id"], "bindings": bindings}, "system")
        return {**self._context_patch(ctx), "approved": self._snapshot(ctx), "replay": True, "status": "building"}

    def scope(self, state: SpineState) -> State:
        ctx = self.ctx(state)
        ctx.brief = None
        message = None
        try:
            invoke_supervisor(self.services, ctx, "scope", analyst_inputs=state.get("analyst_inputs", []))
        except Exception as exc:
            log.exception("scope failed")
            message = f"The agent could not finish scoping: {exc}"
        if ctx.brief is None and message is None:
            message = "The agent did not submit a brief. Instruct it to retry, or reject the run."
        patch = self._context_patch(ctx)
        if ctx.brief is not None:
            self.emit(ctx.run_id, "brief", ctx.brief.model_dump())
            for q in ctx.brief.questions:
                step_id = "p1.read" if q.target in ("sheet", "header_row") else f"p1.select_{q.target.split('_')[-1]}"
                self.emit(ctx.run_id, "question", {**q.model_dump(), "step_id": step_id})
            self.step(ctx.run_id, "p1.read", "done", {"layout": ctx.layout})
        return {**patch, "gate_message": message, "status": "awaiting_brief"}

    def gate_brief(self, state: SpineState) -> State:
        ctx = self.ctx(state)
        blockers = gates.brief_blockers(ctx.brief, ctx.candidate_recipe, ctx.bindings, ctx.layout)
        response = self._gate(
            state,
            {
                "gate": "brief",
                "brief": state.get("brief"),
                "message": state.get("gate_message"),
                "blocked_reasons": blockers,
                "allowed_actions": ["approve", "answer", "change", "instruct", "reject"],
            },
        )
        if isinstance(response, str):
            return {"gate_message": response, "next": "gate_brief"}
        self._record(state, f"brief.{response.action}", response.model_dump(), response.actor)
        inputs = list(state.get("analyst_inputs", []))
        if response.action == "reject":
            self.services.stores.runs.set_status(ctx.run_id, "rejected")
            self.forget(ctx.run_id)
            return {"status": "rejected", "next": "end"}
        if response.action == "answer":
            question = next(
                (q for q in (ctx.brief.questions if ctx.brief else []) if q.id == response.question_id), None
            )
            inputs.append(
                {
                    "type": "answer",
                    "question_id": response.question_id,
                    "question": question.text if question else None,
                    "option": response.option,
                }
            )
            return {"analyst_inputs": inputs, "next": "scope", "gate_message": None}
        if response.action == "instruct":
            inputs.append({"type": "instruction", "text": response.text})
            return {"analyst_inputs": inputs, "next": "scope", "gate_message": None}
        if response.action == "change":
            inputs.append({"type": "changes", "changes": [c.model_dump() for c in response.changes]})
            return {"analyst_inputs": inputs, "next": "scope", "gate_message": None}
        if blockers:
            return {"gate_message": "Cannot approve the brief: " + "; ".join(blockers), "next": "gate_brief"}
        return {**self._approve_brief(state, ctx, response.actor), "next": "build"}

    def _approve_brief(self, state: SpineState, ctx: RunContext, actor: str) -> State:
        assert ctx.brief is not None and ctx.candidate_recipe is not None and ctx.layout is not None
        bindings = ctx.brief.binding_map()
        headers = headers_for(ctx, ctx.layout["sheet"], ctx.layout["header_row"])
        resolution = ctx.resolution
        if resolution is None or list(resolution.headers) != headers:
            resolution = self.services.resolver.resolve(ctx.sponsor_id, headers, run_id=ctx.run_id)
        # The only mapping-history write, and only after the analyst approved.
        confirmed = self.services.resolver.confirm(
            ctx.sponsor_id, resolution, {f: FieldDecision(column=c) for f, c in bindings.items()}, reviewer=actor
        )
        ctx.resolution = confirmed
        # The cached resolution now predates the history write, so a fresh
        # resolve would no longer return it; drop the spine's cache.
        ctx.resolved_layout = None
        recipe_id = f"rcp-{uuid.uuid4().hex[:12]}"
        key = f"recipes/{ctx.sponsor_id}/{recipe_id}.py"
        source = Path(ctx.candidate_recipe["path"]).read_bytes()
        ctx.stores.objects.put(key, source)
        saved = ctx.stores.recipes.save(
            RecipeRecord(
                recipe_id,
                ctx.sponsor_id,
                ctx.entity,
                state["fingerprint"],
                0,
                _sha(source),
                key,
                ctx.candidate_recipe["origin"],
                actor,
                now(),
                bindings=bindings,
                layout=ctx.layout,
            )
        )
        ctx.candidate_recipe = {
            **ctx.candidate_recipe,
            "recipe_id": saved.id,
            "version": saved.version,
            "source_uri": key,
            "path": str(ctx.stores.objects.local_path(key)),
            "sha256": _sha(source),
        }
        # Options were keyed to the previous table's rows; a newly approved brief starts clean,
        # with the brief's item type applied (a non-default one raises its own acknowledgement).
        item_type = ctx.brief.item_type if ctx.brief.item_type != "Inventory" else None
        options = AffiliateOptions(item_type=item_type)
        ctx.options = options
        ctx.result = None
        written = sum(1 for c in bindings.values() if c)
        self.step(ctx.run_id, "p1.saved", "done", {"history_written": written, "bindings": bindings})
        approvers = [*state.get("approvers", []), {"gate": "brief", "actor": actor, "at": now()}]
        self.emit(ctx.run_id, "phase", {"phase": "p1", "state": "done"})
        return {
            **self._context_patch(ctx),
            "approved": self._snapshot(ctx),
            "options": options.to_dict(),
            "approvers": approvers,
            "gate_message": None,
            "status": "building",
        }

    def build(self, state: SpineState) -> State:
        ctx = self.ctx(state)
        self._pin(state, ctx)
        self.emit(ctx.run_id, "phase", {"phase": "p2", "state": "active"})
        try:
            assert ctx.candidate_recipe is not None
            result = build(ctx, ctx.candidate_recipe)
        except (RecipeFailed, AssertionError) as exc:
            self.emit(ctx.run_id, "error", {"message": f"recipe failed: {exc}"})
            return {"result": None, "error": f"recipe failed: {exc}", "status": "error", "phase": "p3"}
        summary = summarize(ctx)
        records = {r.row: r for r in result.records}
        findings = [
            {
                "code": f.code,
                "severity": f.severity,
                "scope": f.scope,
                "row": f.row,
                "message": f.message,
                "requires_ack": f.requires_ack,
                "acknowledged": f.key in ctx.options.acknowledged,
                "source_row": records[f.row].source_row if f.row in records else None,
            }
            for f in result.findings
        ]
        methods = sorted({r.id_method for r in result.records})
        collisions = [
            f for f in findings if f["code"] in ("AFF_ERR_ITEM_ID_DUPLICATE", "AFF_ERR_ITEM_ID_TRUNCATION_COLLISION")
        ]
        self.step(ctx.run_id, "p2.options", "done", {"methods": methods})
        self.step(ctx.run_id, "p2.dedup", "done", {"rows": len(result.records), "collisions": len(collisions)})
        self.step(ctx.run_id, "p2.collisions", "blocked" if collisions else "done", {"items": collisions})
        self.step(ctx.run_id, "p3.match_table", "done", {"bindings": ctx.bindings, "routes": ctx.binding_routes})
        self.step(ctx.run_id, "p3.dq", "blocked" if not result.publishable else "done", summary)
        self.emit(ctx.run_id, "findings", {"items": findings})
        return {
            "result": {**summary, "findings": findings},
            "error": None,
            "status": "reviewing",
            "phase": "p3",
            "model_calls": ctx.model_calls,
        }

    def report(self, state: SpineState) -> State:
        ctx = self.ctx(state)
        result = state.get("result")
        if state.get("error") or not result or not result["findings"]:
            n = (result or {}).get("rows_emitted", 0)
            text = state.get("error") or f"{n} affiliates, no findings. Ready for review."
            report = RunReport(summary=text, findings_by_code={}, blocking_count=0, ack_required=0)
        else:
            ctx.report = None
            try:
                invoke_supervisor(
                    self.services, ctx, "report", summary={k: v for k, v in result.items() if k != "findings"}
                )
            except Exception as exc:
                log.exception("report failed")
                self.emit(ctx.run_id, "error", {"message": f"report failed: {exc}"})
            self._pin(state, ctx)
            report = ctx.report or RunReport(
                summary="Findings are listed below.",
                findings_by_code=result["findings_by_code"],
                blocking_count=result["errors"],
                ack_required=result["ack_required"],
            )
        self.emit(ctx.run_id, "report", report.model_dump())
        return {"report": report.model_dump(), "model_calls": ctx.model_calls}

    def gate_findings(self, state: SpineState) -> State:
        ctx = self.ctx(state)
        self._pin(state, ctx)
        error = state.get("error") or self._ensure_result(ctx)
        blockers = gates.findings_blockers(ctx.result, ctx.options)
        response = self._gate(
            state,
            {
                "gate": "findings",
                "report": state.get("report"),
                "result": state.get("result"),
                "proposal": state.get("proposal"),
                "message": state.get("gate_message") or error,
                "blocked_reasons": blockers,
                "allowed_actions": ["approve", "change", "instruct", "reject"],
            },
        )
        if isinstance(response, str):
            return {"gate_message": response, "next": "gate_findings"}
        self._record(state, f"findings.{response.action}", response.model_dump(), response.actor)
        if response.action == "reject":
            self.services.stores.runs.set_status(ctx.run_id, "rejected")
            self.forget(ctx.run_id)
            return {"status": "rejected", "next": "end"}
        if response.action == "approve":
            if not gates.can_pass_findings(ctx.result, ctx.options):
                return {
                    "gate_message": "Cannot pass the gate: " + "; ".join(blockers or ["not publishable"]),
                    "next": "gate_findings",
                }
            self.step(ctx.run_id, "p3.gate", "done", {"actor": response.actor})
            self.step(ctx.run_id, "p3.saved", "done", {"recipe": (ctx.candidate_recipe or {}).get("recipe_id")})
            self.emit(ctx.run_id, "phase", {"phase": "p3", "state": "done"})
            approvers = [*state.get("approvers", []), {"gate": "findings", "actor": response.actor, "at": now()}]
            return {"approvers": approvers, "gate_message": None, "proposal": None, "next": "render"}
        if response.action == "instruct":
            return {**self._instruct(state, ctx, response.text or ""), "next": "gate_findings"}
        return self._apply_changes(state, ctx, response)

    def _instruct(self, state: SpineState, ctx: RunContext, text: str) -> State:
        ctx.proposal = None
        ctx.last_dry_run = None
        if ctx.result is None:
            return {"gate_message": "There is no result to change yet.", "proposal": None}
        try:
            invoke_supervisor(self.services, ctx, "instruct", text=text)
        except Exception as exc:
            self._pin(state, ctx)
            log.exception("instruct failed")
            return {
                "gate_message": f"The agent could not read the instruction: {exc}",
                "proposal": None,
                "model_calls": ctx.model_calls,
            }
        self._pin(state, ctx)
        proposal = ctx.proposal or ChangeProposal(restated="No applicable change.", applicable=False)
        last: dict[str, Any] = ctx.last_dry_run or {}
        impact = last.get("impact") if proposal.applicable else None
        payload = {**proposal.model_dump(), "impact": impact}
        self.emit(
            ctx.run_id,
            "change_impact",
            {
                "changes": payload["changes"],
                "impact": impact,
                "violations": (impact or {}).get("violations", []),
                "restated": proposal.restated,
                "applicable": proposal.applicable,
            },
        )
        return {"proposal": payload, "gate_message": None, "model_calls": ctx.model_calls}

    def _apply_changes(self, state: SpineState, ctx: RunContext, response: GateResponse) -> State:
        if not response.changes:
            return {"gate_message": "No changes were given.", "next": "gate_findings"}
        if ctx.result is None:
            layout = [c for c in response.changes if isinstance(to_sdk(c), sdk_changes.LAYOUT_CHANGES)]
            if layout:
                inputs = [
                    *state.get("analyst_inputs", []),
                    {"type": "changes", "changes": [c.model_dump() for c in layout]},
                ]
                return {"analyst_inputs": inputs, "next": "scope", "gate_message": None}
            reason = state.get("error") or self._ensure_result(ctx) or "there is no result yet"
            return {
                "gate_message": f"Changes refused: {reason}. Ask the agent to revise the recipe first.",
                "next": "gate_findings",
            }
        impact = impact_for(ctx, list(response.changes))
        described = impact_dict(impact)
        self.emit(
            ctx.run_id,
            "change_impact",
            {
                "changes": [c.model_dump() for c in response.changes],
                "impact": described,
                "violations": described["violations"],
            },
        )
        if impact.violations:
            reasons = "; ".join(f"{v.rule}: {v.message}" for v in impact.violations)
            return {"gate_message": f"Changes refused: {reasons}", "next": "gate_findings"}
        if impact.requires_rebuild:
            inputs = [
                *state.get("analyst_inputs", []),
                {"type": "changes", "changes": [c.model_dump() for c in response.changes]},
            ]
            return {"analyst_inputs": inputs, "next": "scope", "gate_message": None, "proposal": None}
        assert impact.options is not None
        ctx.options = impact.options
        # Layout changes are routed to scope above; the rest are option changes.
        assert all(not isinstance(to_sdk(c), sdk_changes.LAYOUT_CHANGES) for c in response.changes)
        return {"options": impact.options.to_dict(), "next": "build", "gate_message": None, "proposal": None}

    def render(self, state: SpineState) -> State:
        ctx = self.ctx(state)
        self._pin(state, ctx)
        failure = self._ensure_result(ctx)
        if failure or ctx.result is None or ctx.canonical is None:
            raise RecipeFailed(failure or "no result to render")
        self.emit(ctx.run_id, "phase", {"phase": "p4", "state": "active"})
        csv_bytes = render.intacct_csv(ctx.result)
        decisions = [asdict(d) for d in self.services.stores.decisions.list(ctx.run_id)]
        layout = ctx.layout or {}
        review_bytes = review.workbook(
            ctx.upload_path,
            ctx.canonical,
            ctx.result,
            decisions,
            state.get("brief"),
            bindings=ctx.bindings or {},
            header_row=layout.get("header_row"),
        )
        artifacts = [
            self._artifact(ctx, "Affiliates.csv", csv_bytes, "csv"),
            self._artifact(ctx, "review.xlsx", review_bytes, "xlsx"),
        ]
        preview = [r.as_template_row() for r in ctx.result.records[:20]]
        self.step(ctx.run_id, "p4.transform", "done", {"rows": len(ctx.result.records)})
        self.step(ctx.run_id, "p4.preview", "done", {"rows": preview})
        return {"artifacts": artifacts, "status": "awaiting_signoff", "phase": "p4"}

    def _artifact(self, ctx: RunContext, name: str, data: bytes, kind: str) -> dict[str, Any]:
        key = f"runs/{ctx.run_id}/outputs/{name}"
        uri = ctx.stores.objects.put(key, data)
        ctx.stores.artifacts.add(ArtifactRecord(ctx.run_id, name, uri, _sha(data), kind))
        entry = {"name": name, "key": key, "sha256": _sha(data), "kind": kind, "bytes": len(data)}
        self.emit(ctx.run_id, "artifact", {"name": name, "url": f"/runs/{ctx.run_id}/artifacts/{name}"})
        return entry

    def gate_signoff(self, state: SpineState) -> State:
        response = self._gate(
            state,
            {
                "gate": "signoff",
                "artifacts": state.get("artifacts", []),
                "message": state.get("gate_message"),
                "blocked_reasons": [],
                "allowed_actions": ["approve", "reject"],
            },
        )
        if isinstance(response, str):
            return {"gate_message": response, "next": "gate_signoff"}
        self._record(state, f"signoff.{response.action}", response.model_dump(), response.actor)
        if response.action == "approve":
            approvers = [*state.get("approvers", []), {"gate": "signoff", "actor": response.actor, "at": now()}]
            return {"approvers": approvers, "next": "finalize", "gate_message": None}
        if response.action == "reject":
            return {
                "next": "gate_findings",
                "gate_message": f"Sign-off rejected: {response.reason or ''}".strip(),
                "status": "reviewing",
                "phase": "p3",
            }
        return {"gate_message": "Sign-off accepts approve or reject.", "next": "gate_signoff"}

    def finalize(self, state: SpineState) -> State:
        ctx = self.ctx(state)
        self._pin(state, ctx)
        stores = self.services.stores
        outputs = {a["name"]: stores.objects.get(a["key"]) for a in state.get("artifacts", [])}
        run = stores.runs.get(ctx.run_id)
        recipe = ctx.candidate_recipe or {}
        routes = ctx.binding_routes or {}
        doc = manifest.build(
            run_id=ctx.run_id,
            sponsor_id=ctx.sponsor_id,
            entity=ctx.entity,
            upload_name=ctx.upload_path.name,
            upload_bytes=ctx.upload_path.read_bytes(),
            recipe={
                "id": recipe.get("recipe_id", ""),
                "sha256": recipe.get("sha256", "0" * 64),
                "origin": "recalled" if recipe.get("recalled") else recipe.get("origin", "standard"),
                "version": recipe.get("version", 1),
            },
            options=ctx.options,
            bindings=[{"field": f, "column": c, "route": routes.get(f)} for f, c in (ctx.bindings or {}).items()],
            decisions=[asdict(d) for d in stores.decisions.list(ctx.run_id)],
            outputs=outputs,
            approvers=state.get("approvers", []),
            created_at=run.created_at if run else now(),
            finalized_at=now(),
            findings=ctx.result.findings if ctx.result else (),
        )
        artifact = self._artifact(ctx, "manifest.json", json.dumps(doc, indent=2).encode(), "json")
        stores.runs.set_status(ctx.run_id, "locked")
        self._record(state, "run.locked", {"outputs": sorted(outputs), "manifest_sha256": artifact["sha256"]}, "system")
        note = stores.objects.local_path(sponsor_notes_key(ctx.sponsor_id))
        note.parent.mkdir(parents=True, exist_ok=True)
        with note.open("a", encoding="utf-8") as handle:
            handle.write(
                f"- {now()[:10]} run {ctx.run_id}: layout {state['fingerprint'][:12]} "
                f"sheet {(ctx.layout or {}).get('sheet')!r} header row {(ctx.layout or {}).get('header_row')}, "
                f"{recipe.get('origin', 'standard')} recipe, {len(ctx.result.records) if ctx.result else 0} rows.\n"
            )
        self.step(ctx.run_id, "p4.generate", "done", {"artifacts": [*state.get("artifacts", []), artifact]})
        self.emit(ctx.run_id, "phase", {"phase": "p4", "state": "done"})
        self.forget(ctx.run_id)
        return {"artifacts": [*state.get("artifacts", []), artifact], "status": "locked", "phase": "done"}

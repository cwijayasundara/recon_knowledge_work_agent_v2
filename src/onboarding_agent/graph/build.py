"""The run spine graph and the Workbench facade the CLI and API drive.

intake → resolve → (build | gate_brief | scope → gate_brief) → build → report
→ gate_findings → render → gate_signoff → finalize
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command
from onboarding_sdk import read
from onboarding_sdk.entities.affiliate import AffiliateOptions

from ..assembly import Services
from ..observability import configure, traced_node
from .nodes import EventSink, Spine
from .state import SpineState

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
ENTITIES = ("affiliate",)
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._() -]")
# The same rule as POST /sponsors. It also keeps sponsor ids safe as path segments.
SPONSOR_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")


def snapshot_defaults() -> dict[str, Any]:
    """The full snapshot shape before intake fills it, so clients never see missing keys."""
    return {
        "status": "starting",
        "phase": "p1",
        "upload": {"key": "", "name": ""},
        "brief": None,
        "bindings": None,
        "layout": None,
        "resolution": None,
        "resolution_summary": None,
        "fastpath": False,
        "options": AffiliateOptions().to_dict(),
        "result": None,
        "report": None,
        "proposal": None,
        "gate_message": None,
        "artifacts": [],
        "approvers": [],
        "replay": False,
        "error": None,
    }


class UploadRejected(ValueError):
    pass


def _route(key: str) -> Callable[[SpineState], str]:
    def route(state: SpineState) -> str:
        return str(state.get(key) or "end")

    return route


def build_graph(spine: Spine, checkpointer: BaseCheckpointSaver[Any] | None = None) -> Any:
    configure()
    g = StateGraph(SpineState)
    for name in (
        "intake",
        "resolve",
        "scope",
        "gate_brief",
        "build",
        "report",
        "gate_findings",
        "render",
        "gate_signoff",
        "finalize",
    ):
        g.add_node(name, traced_node(name, getattr(spine, name)))
    g.add_edge(START, "intake")
    g.add_edge("intake", "resolve")
    g.add_conditional_edges(
        "resolve",
        # A replayed run builds; a fast-path run (brief drafted in code) goes
        # straight to the brief gate; otherwise the supervisor scopes first.
        lambda s: "build" if s.get("replay") else ("gate_brief" if s.get("fastpath") else "scope"),
        {"build": "build", "scope": "scope", "gate_brief": "gate_brief"},
    )
    g.add_edge("scope", "gate_brief")
    g.add_conditional_edges(
        "gate_brief", _route("next"), {"scope": "scope", "build": "build", "gate_brief": "gate_brief", "end": END}
    )
    g.add_edge("build", "report")
    g.add_edge("report", "gate_findings")
    g.add_conditional_edges(
        "gate_findings",
        _route("next"),
        {
            "build": "build",
            "scope": "scope",
            "gate_findings": "gate_findings",
            "render": "render",
            "end": END,
        },
    )
    g.add_edge("render", "gate_signoff")
    g.add_conditional_edges(
        "gate_signoff",
        _route("next"),
        {
            "finalize": "finalize",
            "gate_findings": "gate_findings",
            "gate_signoff": "gate_signoff",
        },
    )
    g.add_edge("finalize", END)
    return g.compile(checkpointer=checkpointer or InMemorySaver())


def safe_file_name(name: str) -> str:
    base = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    cleaned = _SAFE_NAME.sub("_", base)[:120]
    if not cleaned or cleaned.startswith("."):
        raise UploadRejected("invalid file name")
    return cleaned


class Workbench:
    def __init__(
        self,
        services: Services,
        *,
        checkpointer: BaseCheckpointSaver[Any] | None = None,
        sink: EventSink | None = None,
    ) -> None:
        self.services = services
        self.spine = Spine(services, sink)
        self.graph = build_graph(self.spine, checkpointer)
        self._initial: dict[str, dict[str, Any]] = {}

    @staticmethod
    def config(run_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": run_id}, "recursion_limit": 200}

    def create(self, *, sponsor_id: str, entity: str, file_name: str, data: bytes, actor: str) -> str:
        """Store the upload and register the run; ``advance`` then runs it to the first gate."""
        sponsor = sponsor_id or ""
        if not SPONSOR_ID.fullmatch(sponsor):
            raise UploadRejected("a sponsor id is required: lowercase letters, digits and '-', at most 63 characters")
        if entity not in ENTITIES:
            raise UploadRejected(f"unsupported entity {entity!r}; supported: {ENTITIES}")
        if len(data) > MAX_UPLOAD_BYTES:
            raise UploadRejected(f"upload is {len(data)} bytes; the limit is {MAX_UPLOAD_BYTES}")
        name = safe_file_name(file_name)
        suffix = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if suffix not in read.CSV_SUFFIXES | read.EXCEL_SUFFIXES:
            raise UploadRejected(f"unsupported file type {suffix or '(none)'}; expected CSV, TSV, XLSX or XLS")
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        key = f"runs/{run_id}/in/{name}"
        self.services.stores.objects.put(key, data)
        self._initial[run_id] = {
            "run_id": run_id,
            "sponsor_id": sponsor,
            "entity": entity,
            "actor": actor,
            "upload": {"key": key, "name": name},
        }
        return run_id

    def advance(self, run_id: str) -> dict[str, Any]:
        # Kept until the invoke returns so snapshot() can answer before the first checkpoint lands.
        try:
            self.graph.invoke(self._initial[run_id], self.config(run_id))
        finally:
            self._initial.pop(run_id, None)
        return self.snapshot(run_id)

    def start(self, *, sponsor_id: str, entity: str, file_name: str, data: bytes, actor: str) -> str:
        run_id = self.create(sponsor_id=sponsor_id, entity=entity, file_name=file_name, data=data, actor=actor)
        self.advance(run_id)
        return run_id

    def respond(self, run_id: str, response: dict[str, Any]) -> dict[str, Any]:
        pending = self.pending(run_id)
        if pending is None:
            raise ValueError(f"run {run_id} is not waiting at a gate")
        self.graph.invoke(Command(resume=response), self.config(run_id))
        return self.snapshot(run_id)

    def pending(self, run_id: str) -> dict[str, Any] | None:
        snap = self.graph.get_state(self.config(run_id))
        for task in snap.tasks:
            for item in task.interrupts:
                return dict(item.value)
        return None

    def snapshot(self, run_id: str) -> dict[str, Any]:
        values = self.graph.get_state(self.config(run_id)).values or self._initial.get(run_id)
        if not values:
            raise KeyError(run_id)
        return {**snapshot_defaults(), **values, "pending": self.pending(run_id)}

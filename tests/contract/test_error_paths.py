"""E2 error paths: each ends at a gate with a clear message, never a crash or a silent pass."""

from __future__ import annotations

from pathlib import Path

import pytest
from deepagents.backends.protocol import ExecuteResponse
from langchain_core.messages import BaseMessage

from onboarding_agent.graph.build import MAX_UPLOAD_BYTES, UploadRejected, Workbench
from onboarding_agent.tools.pipeline import RecipeFailed, execute_recipe
from tests.conftest import FIXTURE_DIR
from tests.support.local_sandbox import LocalSandbox
from tests.support.scripts import scope_standard
from tests.support.services import Models, context_for, offline_services

ANALYST = "analyst@sponsor-a"


def test_model_timeout_during_scope_reaches_brief_gate_with_message(tmp_path: Path) -> None:
    def timeout(messages: list[BaseMessage]):  # type: ignore[no-untyped-def]
        raise TimeoutError("model did not answer in 120s")

    models = Models()
    models.supervisor.script = [timeout, *scope_standard("clean.csv")]
    bench = Workbench(offline_services(tmp_path, models))
    run_id = bench.start(
        sponsor_id="sponsor-a",
        entity="affiliate",
        file_name="clean.csv",
        data=(FIXTURE_DIR / "clean.csv").read_bytes(),
        actor=ANALYST,
    )
    snap = bench.snapshot(run_id)
    assert snap["pending"]["gate"] == "brief"
    assert "could not finish scoping" in snap["gate_message"]
    assert "there is no brief yet" in snap["pending"]["blocked_reasons"]
    # The analyst retries by instructing the agent.
    snap = bench.respond(run_id, {"action": "instruct", "actor": ANALYST, "text": "try again"})
    assert snap["brief"] is not None and snap["gate_message"] is None


class _TimeoutSandbox(LocalSandbox):
    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        return ExecuteResponse(output=f"\n[timed out after {timeout}s]", exit_code=124, truncated=False)


def test_sandbox_timeout_is_a_recipe_failure(tmp_path: Path) -> None:
    services = offline_services(tmp_path, Models())
    ctx = context_for(services, "clean.csv")
    ctx.sandbox_factory = _TimeoutSandbox
    recipe = tmp_path / "authored.py"
    recipe.write_text("RECIPE = {}\n")
    import hashlib

    sha = hashlib.sha256(recipe.read_bytes()).hexdigest()
    with pytest.raises(RecipeFailed, match="timed out"):
        execute_recipe(ctx, {"origin": "authored", "path": str(recipe), "sha256": sha})
    ctx.close()


def test_failed_recipe_stops_at_findings_gate_with_message(tmp_path: Path) -> None:
    models = Models()
    models.supervisor.script = scope_standard("clean.csv")
    bench = Workbench(offline_services(tmp_path, models))
    run_id = bench.start(
        sponsor_id="sponsor-a",
        entity="affiliate",
        file_name="clean.csv",
        data=(FIXTURE_DIR / "clean.csv").read_bytes(),
        actor=ANALYST,
    )
    snap = bench.respond(run_id, {"action": "approve", "actor": ANALYST})
    assert snap["pending"]["gate"] == "findings"
    frozen = Path(snap["recipe"]["path"])
    frozen.write_text("import os\n")
    bench.spine.forget(run_id)
    snap = bench.respond(
        run_id, {"action": "change", "actor": ANALYST, "changes": [{"kind": "set_item_type", "value": "Non-Inventory"}]}
    )
    # A recipe that fails its check on rebuild ends at the gate with the reason.
    assert snap["pending"]["gate"] == "findings"
    assert "Changes refused: recipe failed" in snap["gate_message"]
    assert "hash" in snap["gate_message"]
    assert "the pipeline has not produced a result" in snap["pending"]["blocked_reasons"]


def test_upload_over_limit_rejected(tmp_path: Path) -> None:
    bench = Workbench(offline_services(tmp_path, Models()))
    with pytest.raises(UploadRejected, match="limit"):
        bench.create(
            sponsor_id="sponsor-a",
            entity="affiliate",
            file_name="big.csv",
            data=b"x" * (MAX_UPLOAD_BYTES + 1),
            actor=ANALYST,
        )


def test_spans_are_emitted(tmp_path: Path) -> None:
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from onboarding_agent import observability

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    observability.tracer = provider.get_tracer("test")
    try:
        models = Models()
        models.supervisor.script = scope_standard("clean.csv")
        bench = Workbench(offline_services(tmp_path, models))
        bench.start(
            sponsor_id="sponsor-a",
            entity="affiliate",
            file_name="clean.csv",
            data=(FIXTURE_DIR / "clean.csv").read_bytes(),
            actor=ANALYST,
        )
    finally:
        observability.tracer = trace.get_tracer("onboarding_agent")
    names = {s.name for s in exporter.get_finished_spans()}
    assert {"spine.intake", "spine.scope", "model.call", "tool.call"} <= names

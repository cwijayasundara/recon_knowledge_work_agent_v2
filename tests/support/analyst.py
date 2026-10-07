"""Scripted gate-driving analyst loops, shared by the live eval and replay tests."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Iterable
from typing import Any

from onboarding_agent.graph.build import Workbench


def drive_gates(
    bench: Workbench,
    run_id: str,
    decision: Callable[[dict[str, Any]], dict[str, Any]],
    *,
    max_steps: int = 12,
) -> dict[str, Any]:
    """Resume gates until the run finishes, taking each response from ``decision``."""
    snapshot = bench.snapshot(run_id)
    for _ in range(max_steps):
        if snapshot.get("pending") is None:
            return snapshot
        snapshot = bench.respond(run_id, decision(snapshot))
    raise AssertionError(f"run {run_id} did not finish within {max_steps} gate steps")


def replay_gates(
    bench: Workbench,
    run_id: str,
    steps: Iterable[dict[str, Any]],
    *,
    max_steps: int = 12,
) -> dict[str, Any]:
    """Replay recorded correction steps; use approvals wherever a case records none."""
    remaining = deque(steps)

    def decide(snapshot: dict[str, Any]) -> dict[str, Any]:
        gate = snapshot["pending"]["gate"]
        if remaining and remaining[0]["kind"].startswith(f"{gate}."):
            step = remaining.popleft()
            response = dict(step["payload"])
            actual_kind = f"{gate}.{response.get('action')}"
            assert actual_kind == step["kind"], (
                f"decision {step['seq']} diverged: expected {step['kind']}, actual {actual_kind}"
            )
            response["actor"] = step["actor"]
            return response
        return {"action": "approve", "actor": "replay-analyst"}

    final = drive_gates(bench, run_id, decide, max_steps=max_steps)
    assert not remaining, f"unconsumed regression decisions: {[(s['seq'], s['kind']) for s in remaining]}"
    return final

"""Live evaluation (E1): every fixture, from empty sponsor history, with a real model.

A scripted analyst answers questions from expected/*.json, approves briefs whose
bindings match, applies the expected fixes and acknowledges warnings. Results go
to eval_results.jsonl and eval_summary.md.

    OPENAI_API_KEY=... uv run pytest -q -m live tests/live/test_affiliate_eval.py
"""

from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from onboarding_sdk.resolve import ColumnBindingResolver

from onboarding_agent.assembly import build_services
from onboarding_agent.config import Settings
from onboarding_agent.graph.build import Workbench
from onboarding_agent.persistence.memory import memory_stores
from tests.conftest import FIXTURE_DIR, REPO_ROOT
from tests.golden.test_affiliate_golden import _csv_bytes
from tests.support.analyst import drive_gates
from tests.support.pipeline import expected

pytestmark = pytest.mark.live
ORDER = [
    "clean.csv",
    "edge.csv",
    "empty.csv",
    "extra_columns.csv",
    "titled.xlsx",
    "renamed.xlsx",
    "ids_missing.csv",
    "two_sheets.xlsx",
    "returning_sponsor.xlsx",
]
ANALYST = "eval-analyst"
MAX_STEPS = 12
OUT = REPO_ROOT / "eval_results.jsonl"
EVAL_MODEL = "gpt-5.6-luna"
BASELINE_MODEL_CALLS = 96
FASTPATH_FIXTURES = {"clean.csv", "edge.csv", "empty.csv", "extra_columns.csv", "titled.xlsx", "ids_missing.csv"}


def _analyst(bench: Workbench, run_id: str, spec: dict[str, Any], metrics: dict[str, Any]) -> dict[str, Any]:
    def decide(snapshot: dict[str, Any]) -> dict[str, Any]:
        gate = snapshot["pending"]["gate"]
        if gate == "brief":
            brief = snapshot.get("brief") or {}
            questions = brief.get("questions", [])
            metrics["questions"] += len(questions)
            if questions:
                question = questions[0]
                answer = spec.get("answers", {}).get(question.get("target"), next(iter(spec["bindings"].values())))
                option = answer if answer in question["options"] else question["options"][0]
                return {"action": "answer", "actor": ANALYST, "question_id": question["id"], "option": option}
            got = {binding["field"]: binding["column"] for binding in brief.get("bindings", [])}
            if got != spec["bindings"]:
                metrics["corrections"] += 1
                changes = [
                    {"kind": "set_column_binding", "field": field, "column": column}
                    for field, column in spec["bindings"].items()
                ]
                return {"action": "change", "actor": ANALYST, "changes": changes}
            return {"action": "approve", "actor": ANALYST}
        if gate == "findings":
            findings = (snapshot.get("result") or {}).get("findings", [])
            if spec.get("fixes") and any(finding["severity"] == "error" for finding in findings):
                return {"action": "change", "actor": ANALYST, "changes": spec["fixes"]}
            acks = [
                {"kind": "acknowledge_finding", "code": finding["code"], "row": finding["row"]}
                for finding in findings
                if finding["requires_ack"] and not finding["acknowledged"]
            ]
            if acks:
                return {"action": "change", "actor": ANALYST, "changes": acks}
        return {"action": "approve", "actor": ANALYST}

    return drive_gates(bench, run_id, decide, max_steps=MAX_STEPS)


def _assert_eval_acceptance(results: list[dict[str, Any]]) -> None:
    assert [r["fixture"] for r in results] == ORDER and all(r["passed"] for r in results), (
        f"all nine fixtures must pass: {results}"
    )
    assert all(r["model_calls"] == 0 for r in results if r["fixture"] in FASTPATH_FIXTURES), (
        f"fast-path fixtures must use zero agent model calls: {results}"
    )
    assert sum(r["model_calls"] for r in results) <= BASELINE_MODEL_CALLS * 0.6, (
        f"agent model calls must fall by at least 40% from baseline {BASELINE_MODEL_CALLS}: {results}"
    )
    assert all(r["questions"] <= 2 for r in results), results
    returning = next(r for r in results if r["fixture"] == "returning_sponsor.xlsx")
    assert returning["replay"] and returning["model_calls"] == 0, returning


def test_affiliate_eval(tmp_path: Path) -> None:
    # The eval model is set here, not taken from .env, so results compare across runs.
    model = os.environ.get("ONB_EVAL_MODEL", EVAL_MODEL)
    settings = Settings(
        object_root=str(tmp_path / "objects"),
        database_url=None,
        supervisor_model=model,
        recipe_engineer_model=model,
    )
    services = build_services(
        settings,
        stores=memory_stores(tmp_path / "objects"),
        resolver=ColumnBindingResolver.create(REPO_ROOT / "workspace/ontology/affiliate.v1.json"),
    )
    bench = Workbench(services)
    results = []
    for name in ORDER:
        spec = expected(name)
        sponsor = (
            "sponsor-eval"
            if name in ("renamed.xlsx", "returning_sponsor.xlsx")
            else f"sponsor-{Path(name).stem.replace('_', '-')}"
        )
        metrics: dict[str, Any] = {"fixture": name, "questions": 0, "corrections": 0}
        started = time.perf_counter()
        run_id = bench.start(
            sponsor_id=sponsor,
            entity="affiliate",
            file_name=name,
            data=(FIXTURE_DIR / name).read_bytes(),
            actor=ANALYST,
        )
        snap = _analyst(bench, run_id, spec, metrics)
        csv = (
            services.stores.objects.get(f"runs/{run_id}/outputs/Affiliates.csv")
            if snap.get("status") == "locked"
            else None
        )
        before = sorted(
            (f["row"] or 0, f["code"])
            for f in (snap.get("result") or {}).get("findings", [])
            if f["code"] != "AFF_INFO_ROW_EXCLUDED"
        )
        want = sorted((f["row"] or 0, f["code"]) for f in spec["findings"])
        rows_ok = spec["rows"] is None or csv == _csv_bytes(spec["rows"])
        metrics.update(
            model=model,
            passed=bool(csv) and rows_ok and (spec.get("fixes") is not None or before == want),
            status=snap.get("status"),
            model_calls=snap.get("model_calls", 0),
            wall_s=round(time.perf_counter() - started, 1),
            replay=snap.get("replay", False),
        )
        results.append(metrics)
    OUT.write_text("".join(json.dumps(r) + "\n" for r in results))
    lines = [
        f"Model: {model}",
        "",
        "| fixture | pass | questions | corrections | model calls | wall s |",
        "|---|---|---|---|---|---|",
    ]
    lines += [
        f"| {r['fixture']} | {'✓' if r['passed'] else '✗'} | {r['questions']} | {r['corrections']} | {r['model_calls']} | {r['wall_s']} |"
        for r in results
    ]
    total_calls = sum(r["model_calls"] for r in results)
    lines += [
        "",
        f"Passed: {sum(r['passed'] for r in results)}/{len(ORDER)}. "
        f"Agent model calls: {BASELINE_MODEL_CALLS} → {total_calls} "
        f"({(1 - total_calls / BASELINE_MODEL_CALLS):.1%} reduction).",
        "Matcher-internal LLM calls are not counted in ctx.model_calls.",
    ]
    summary = REPO_ROOT / "eval_summary.md"
    # Retain the scope-only baseline and previous measurements across reruns.
    with summary.open("a") as handle:
        handle.write(f"\n## Evaluation {datetime.now(UTC).isoformat()}\n\n" + "\n".join(lines) + "\n")

    _assert_eval_acceptance(results)

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


def _analyst(bench: Workbench, run_id: str, spec: dict[str, Any], metrics: dict[str, Any]) -> dict[str, Any]:
    snap = bench.snapshot(run_id)
    for _ in range(MAX_STEPS):
        pending = snap.get("pending")
        if pending is None:
            return snap
        gate = pending["gate"]
        if gate == "brief":
            brief = snap.get("brief") or {}
            questions = brief.get("questions", [])
            metrics["questions"] += len(questions)
            if questions:
                q = questions[0]
                answer = spec.get("answers", {}).get(q.get("target"), next(iter(spec["bindings"].values())))
                option = answer if answer in q["options"] else q["options"][0]
                snap = bench.respond(
                    run_id, {"action": "answer", "actor": ANALYST, "question_id": q["id"], "option": option}
                )
                continue
            got = {b["field"]: b["column"] for b in brief.get("bindings", [])}
            if got != spec["bindings"]:
                metrics["corrections"] += 1
                changes = [{"kind": "set_column_binding", "field": f, "column": c} for f, c in spec["bindings"].items()]
                snap = bench.respond(run_id, {"action": "change", "actor": ANALYST, "changes": changes})
                continue
            snap = bench.respond(run_id, {"action": "approve", "actor": ANALYST})
        elif gate == "findings":
            findings = (snap.get("result") or {}).get("findings", [])
            if spec.get("fixes") and any(f["severity"] == "error" for f in findings):
                snap = bench.respond(run_id, {"action": "change", "actor": ANALYST, "changes": spec["fixes"]})
                continue
            acks = [
                {"kind": "acknowledge_finding", "code": f["code"], "row": f["row"]}
                for f in findings
                if f["requires_ack"] and not f["acknowledged"]
            ]
            if acks:
                snap = bench.respond(run_id, {"action": "change", "actor": ANALYST, "changes": acks})
                continue
            snap = bench.respond(run_id, {"action": "approve", "actor": ANALYST})
        else:
            snap = bench.respond(run_id, {"action": "approve", "actor": ANALYST})
    return snap


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
    (REPO_ROOT / "eval_summary.md").write_text("\n".join(lines) + "\n")

    assert sum(r["passed"] for r in results) >= 8, results
    assert all(r["questions"] <= 2 for r in results), results
    returning = next(r for r in results if r["fixture"] == "returning_sponsor.xlsx")
    assert returning["replay"] and returning["model_calls"] == 0, returning

"""R4: committed correction cases replay offline to their recorded outcomes."""

from __future__ import annotations

import difflib
import hashlib
import json
from pathlib import Path

import pytest

from onboarding_agent.graph.build import Workbench
from onboarding_agent.regression import RegressionCase, case_key
from scripts.promote_regression import main as promote_case
from tests.support.analyst import replay_gates
from tests.support.fixture_agent import FixtureAgentModel
from tests.support.services import Models, offline_services

CASES_DIR = Path(__file__).parent / "cases"
TWINS_DIR = Path(__file__).parents[1] / "fixtures" / "regression"


def replay_case(tmp_path: Path, case: RegressionCase, twin_bytes: bytes) -> dict[str, object]:
    models = Models()
    if case.fixture.startswith("two_sheets."):
        models.supervisor = FixtureAgentModel()
    services = offline_services(tmp_path, models)
    bench = Workbench(services)
    run_id = bench.start(
        sponsor_id=case.sponsor_id,
        entity=case.entity,
        file_name=case.fixture,
        data=twin_bytes,
        actor="replay-analyst",
    )
    try:
        final = replay_gates(bench, run_id, [step.model_dump() for step in case.steps])
    except AssertionError as exc:
        expected = case.outcome.model_dump(exclude={"finding_codes"})
        expected_text = json.dumps(expected, indent=2, sort_keys=True)
        actual = {"status": "unfinished", "bindings": None, "csv_sha256": None}
        actual_text = json.dumps(actual, indent=2, sort_keys=True)
        diff = difflib.unified_diff(
            expected_text.splitlines(), actual_text.splitlines(), "expected", "actual", lineterm=""
        )
        raise AssertionError(f"regression case replay diverged: {exc}\n" + "\n".join(diff)) from exc
    artifacts = {artifact["name"]: artifact for artifact in final.get("artifacts", [])}
    actual = {
        "status": final.get("status"),
        "bindings": final.get("bindings"),
        "csv_sha256": artifacts.get("Affiliates.csv", {}).get("sha256"),
    }
    expected = case.outcome.model_dump(exclude={"finding_codes"})
    if actual != expected:
        actual_text = json.dumps(actual, indent=2, sort_keys=True)
        expected_text = json.dumps(expected, indent=2, sort_keys=True)
        diff = difflib.unified_diff(
            expected_text.splitlines(), actual_text.splitlines(), "expected", "actual", lineterm=""
        )
        raise AssertionError("regression case replay diverged:\n" + "\n".join(diff))
    return final


@pytest.mark.parametrize("path", sorted(CASES_DIR.glob("*.json")), ids=lambda path: path.stem)
def test_committed_cases_replay_offline(tmp_path: Path, path: Path) -> None:
    case = RegressionCase.model_validate(json.loads(path.read_text()))
    twin = TWINS_DIR / path.stem
    assert hashlib.sha256(twin.read_bytes()).hexdigest() == case.upload.sha256
    replay_case(tmp_path, case, twin.read_bytes())


@pytest.mark.parametrize("name", ["edge-change", "two-sheets-answer"])
def test_capture_promote_and_replay_synthetic_correction(tmp_path: Path, name: str) -> None:
    case = RegressionCase.model_validate(json.loads((CASES_DIR / f"{name}.json").read_text()))
    twin = TWINS_DIR / name
    models = Models()
    if case.fixture.startswith("two_sheets."):
        models.supervisor = FixtureAgentModel()
    services = offline_services(tmp_path / "capture", models)
    bench = Workbench(services)
    run_id = bench.start(
        sponsor_id=case.sponsor_id,
        entity=case.entity,
        file_name=case.fixture,
        data=twin.read_bytes(),
        actor="replay-analyst",
    )
    final = replay_gates(bench, run_id, [step.model_dump() for step in case.steps])
    assert final["status"] == "locked"
    repo = tmp_path / "promoted"
    assert (
        promote_case(
            ["--case", case_key(case.sponsor_id, run_id), "--name", name, "--twin", str(twin), "--i-confirm-synthetic"],
            stores=services.stores,
            repo_root=repo,
        )
        == 0
    )
    promoted = RegressionCase.model_validate(json.loads((repo / "tests/regression/cases" / f"{name}.json").read_text()))
    assert promoted.outcome == case.outcome
    replay_case(tmp_path / "replay", promoted, (repo / "tests/fixtures/regression" / name).read_bytes())


def test_broken_step_replay_fails_with_a_diff(tmp_path: Path) -> None:
    path = next(CASES_DIR.glob("edge-change.json"))
    case = RegressionCase.model_validate(json.loads(path.read_text()))
    case.steps[0].payload["changes"][0]["row"] = 99
    with pytest.raises(AssertionError, match="regression case replay diverged"):
        replay_case(tmp_path, case, (TWINS_DIR / path.stem).read_bytes())


def test_replay_rejects_an_unconsumed_correction(tmp_path: Path) -> None:
    path = CASES_DIR / "edge-change.json"
    case = RegressionCase.model_validate(json.loads(path.read_text()))
    # The original changes still lock successfully; this extra correction must
    # not be silently skipped just because its target gate never appears.
    answer_case = RegressionCase.model_validate(json.loads((CASES_DIR / "two-sheets-answer.json").read_text()))
    unused = answer_case.steps[0].model_copy(deep=True)
    unused.seq = 99
    case.steps.append(unused)
    with pytest.raises(AssertionError, match=r"unconsumed.*brief.answer"):
        replay_case(tmp_path, case, (TWINS_DIR / path.stem).read_bytes())


def test_replay_rejects_a_mismatched_decision_action(tmp_path: Path) -> None:
    path = CASES_DIR / "two-sheets-answer.json"
    case = RegressionCase.model_validate(json.loads(path.read_text()))
    case.steps[0].kind = "brief.change"
    with pytest.raises(AssertionError, match=r"decision.*brief.change.*brief.answer"):
        replay_case(tmp_path, case, (TWINS_DIR / path.stem).read_bytes())


def test_changed_sheet_answer_changes_the_replayed_outcome(tmp_path: Path) -> None:
    path = CASES_DIR / "two-sheets-answer.json"
    case = RegressionCase.model_validate(json.loads(path.read_text()))
    case.steps[0].payload["option"] = "Affiliates (old)"
    with pytest.raises(AssertionError, match=r"regression case replay diverged:[\s\S]*csv_sha256"):
        replay_case(tmp_path, case, (TWINS_DIR / path.stem).read_bytes())


def test_wrong_question_id_cannot_replay_the_sheet_answer(tmp_path: Path) -> None:
    path = CASES_DIR / "two-sheets-answer.json"
    case = RegressionCase.model_validate(json.loads(path.read_text()))
    case.steps[0].payload["question_id"] = "unknown-question"
    with pytest.raises(AssertionError, match="regression case replay diverged"):
        replay_case(tmp_path, case, (TWINS_DIR / path.stem).read_bytes())

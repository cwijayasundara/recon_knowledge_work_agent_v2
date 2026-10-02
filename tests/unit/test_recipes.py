from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from onboarding_sdk import canonical, read, recipes

from tests.conftest import FIXTURE_DIR, REPO_ROOT

CLEAN_BINDINGS = {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"}


def _write(tmp_path: Path, source: str, name: str = "recipe.py") -> Path:
    path = tmp_path / name
    path.write_text(source, encoding="utf-8")
    return path


def test_standard_recipe_passes_on_clean(tmp_path: Path) -> None:
    path = _write(tmp_path, recipes.standard(CLEAN_BINDINGS, "clean", 1))
    result = recipes.check(path, FIXTURE_DIR / "clean.csv")
    assert result.ok, result.errors
    assert result.coverage == {"rows_read": 8, "rows_emitted": 8, "rows_dropped": 0, "dropped": []}
    assert result.bindings == CLEAN_BINDINGS
    assert len(result.recipe_sha256) == 64


def test_standard_recipe_is_generated_without_randomness() -> None:
    assert recipes.standard(CLEAN_BINDINGS, "clean", 1) == recipes.standard(CLEAN_BINDINGS, "clean", 1)


def test_standard_csv_recipe_replays_on_a_differently_named_csv(tmp_path: Path) -> None:
    path = _write(tmp_path, recipes.standard(CLEAN_BINDINGS, "clean", 1))
    other = tmp_path / "upload-2.csv"
    other.write_bytes((FIXTURE_DIR / "clean.csv").read_bytes())
    assert recipes.check(path, other).ok


def test_standard_recipe_titled_drops_total(tmp_path: Path) -> None:
    path = _write(tmp_path, recipes.standard(CLEAN_BINDINGS, "Affiliates", 4))
    result = recipes.check(path, FIXTURE_DIR / "titled.xlsx")
    assert result.ok, result.errors
    assert result.coverage["rows_emitted"] == 8
    assert result.coverage["dropped"] == [{"sheet": "Affiliates", "row": 13, "reason": "total_row"}]


def test_standard_recipe_without_id_column(tmp_path: Path) -> None:
    bindings = {"affiliate_id": None, "affiliate_name": "Affiliate Name"}
    path = _write(tmp_path, recipes.standard(bindings, "ids_missing", 1))
    result = recipes.check(path, FIXTURE_DIR / "ids_missing.csv")
    assert result.ok, result.errors
    prepared = recipes.load(path).prepare(read.open(FIXTURE_DIR / "ids_missing.csv"))
    assert all(row.affiliate_id is None for row in prepared.rows)


def test_standard_recipe_rejects_unknown_column(tmp_path: Path) -> None:
    bindings = {"affiliate_id": "Nope", "affiliate_name": "Affiliate Name"}
    path = _write(tmp_path, recipes.standard(bindings, "clean", 1))
    result = recipes.check(path, FIXTURE_DIR / "clean.csv")
    assert not result.ok
    assert any("Nope" in error for error in result.errors)


@pytest.mark.parametrize("line", ["import os", "import requests", "from os import path", "import subprocess"])
def test_disallowed_imports_fail(tmp_path: Path, line: str) -> None:
    source = line + "\n" + recipes.standard(CLEAN_BINDINGS, "clean", 1)
    result = recipes.check(_write(tmp_path, source), FIXTURE_DIR / "clean.csv")
    assert not result.ok
    assert any("import" in error for error in result.errors)


def test_disallowed_builtins_fail(tmp_path: Path) -> None:
    source = recipes.standard(CLEAN_BINDINGS, "clean", 1) + "\n_x = open('/etc/passwd')\n"
    result = recipes.check(_write(tmp_path, source), FIXTURE_DIR / "clean.csv")
    assert not result.ok
    assert any("open" in error for error in result.errors)


NON_DETERMINISTIC = """
from onboarding_sdk.canonical import AffiliateCanonical, AffiliateRow
from onboarding_sdk.read import Workbook

RECIPE = {"entity": "affiliate", "sdk": "0.1.0", "summary": "bad",
          "bindings": {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"}}
_calls = [0]

def prepare(wb: Workbook) -> AffiliateCanonical:
    _calls[0] += 1
    return AffiliateCanonical((AffiliateRow("A", f"name {_calls[0]}", "clean", 2),))
"""


def test_non_deterministic_recipe_fails(tmp_path: Path) -> None:
    result = recipes.check(_write(tmp_path, NON_DETERMINISTIC), FIXTURE_DIR / "clean.csv")
    assert not result.ok
    assert any("deterministic" in error for error in result.errors)


def _deterministic(source: str) -> str:
    return source.replace("_calls[0] += 1\n", "").replace("{_calls[0]}", "")


def test_missing_lineage_fails(tmp_path: Path) -> None:
    source = _deterministic(NON_DETERMINISTIC).replace('"clean", 2', '"", 0')
    result = recipes.check(_write(tmp_path, source), FIXTURE_DIR / "clean.csv")
    assert not result.ok
    assert any("lineage" in error for error in result.errors)


def test_missing_binding_fails(tmp_path: Path) -> None:
    source = _deterministic(NON_DETERMINISTIC).replace('"affiliate_id": "Affiliate ID", ', "")
    result = recipes.check(_write(tmp_path, source), FIXTURE_DIR / "clean.csv")
    assert not result.ok
    assert any("affiliate_id" in error for error in result.errors)


def test_recipe_that_raises_reports_error(tmp_path: Path) -> None:
    source = recipes.standard(CLEAN_BINDINGS, "clean", 1).replace(
        "def prepare(wb: Workbook) -> AffiliateCanonical:\n",
        "def prepare(wb: Workbook) -> AffiliateCanonical:\n    raise ValueError('boom')\n",
    )
    result = recipes.check(_write(tmp_path, source), FIXTURE_DIR / "clean.csv")
    assert not result.ok
    assert any("boom" in error for error in result.errors)


def test_canonical_content_hash_changes_with_rows() -> None:
    a = canonical.AffiliateCanonical((canonical.AffiliateRow("A", "N", "s", 2),))
    b = canonical.AffiliateCanonical((canonical.AffiliateRow("A", "M", "s", 2),))
    assert a.content_hash() != b.content_hash()
    assert a.to_rules_input()[0].affiliate_name == "N"


def _cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env={"PYTHONPATH": f"{REPO_ROOT / 'packages/onboarding_sdk'}"},
        check=False,
    )


def test_cli_inspect_prints_profile() -> None:
    proc = _cli("onboarding_sdk.inspect", str(FIXTURE_DIR / "titled.xlsx"))
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["sheets"][0]["header_row"] == 4
    assert "fingerprint" in payload


def test_cli_check_exit_codes(tmp_path: Path) -> None:
    good = _write(tmp_path, recipes.standard(CLEAN_BINDINGS, "clean", 1), "good.py")
    bad = _write(tmp_path, "import os\n" + recipes.standard(CLEAN_BINDINGS, "clean", 1), "bad.py")
    ok = _cli("onboarding_sdk.recipes", "check", str(good), str(FIXTURE_DIR / "clean.csv"))
    assert ok.returncode == 0, ok.stderr
    assert json.loads(ok.stdout)["ok"] is True
    fail = _cli("onboarding_sdk.recipes", "check", str(bad), str(FIXTURE_DIR / "clean.csv"))
    assert fail.returncode == 1
    assert json.loads(fail.stdout)["ok"] is False


def test_cli_run_emits_canonical(tmp_path: Path) -> None:
    good = _write(tmp_path, recipes.standard(CLEAN_BINDINGS, "clean", 1), "good.py")
    proc = _cli("onboarding_sdk.recipes", "run", str(good), str(FIXTURE_DIR / "clean.csv"))
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    restored = canonical.AffiliateCanonical.from_dict(payload["canonical"])
    assert len(restored.rows) == 8
    assert restored == recipes.run(good, FIXTURE_DIR / "clean.csv")

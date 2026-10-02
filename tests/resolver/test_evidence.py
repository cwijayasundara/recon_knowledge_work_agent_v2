from __future__ import annotations

from onboarding_sdk import profile, read
from onboarding_sdk.resolve import evidence_for

from tests.conftest import FIXTURE_DIR


def _evidence(name: str, sheet: str, columns: list[str]):  # type: ignore[no-untyped-def]
    prof = profile.workbook(read.open(FIXTURE_DIR / name))
    return {e.column: e for e in evidence_for(prof, sheet, columns)}


def test_ids_and_names() -> None:
    ev = _evidence("clean.csv", "clean", ["Affiliate ID", "Affiliate Name", "Fund Complex"])
    assert ev["Affiliate ID"].hint == "id_like"
    assert ev["Affiliate ID"].pattern == r"AFF_\d{4}"
    assert ev["Affiliate ID"].uniqueness == 1.0
    assert ev["Affiliate Name"].hint == "name_like"
    assert ev["Fund Complex"].hint == "code_like"


def test_distractors() -> None:
    ev = _evidence("renamed.xlsx", "Export", ["Affi Name", "Zip Code", "Created By", "Notes"])
    assert ev["Affi Name"].hint == "name_like"
    assert ev["Notes"].hint == "empty"
    assert ev["Zip Code"].hint != "name_like"
    assert ev["Created By"].hint != "name_like"


def test_unknown_column_is_skipped() -> None:
    assert _evidence("clean.csv", "clean", ["Nope"]) == {}

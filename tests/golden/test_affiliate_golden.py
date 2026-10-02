from __future__ import annotations

import csv
import io
import json

import pytest
from onboarding_sdk.entities.affiliate import AffiliateOptions, process
from onboarding_sdk.render import RenderRefused, intacct_csv

from tests.conftest import FIXTURE_DIR, SAMPLE_DIR
from tests.support.pipeline import canonical_for, expected

ALL_FIXTURES = [
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


def _csv_bytes(rows: list[dict[str, str]]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(
        buffer,
        fieldnames=["ITEM_ID", "NAME", "ITEM_TYPE", "DESCRIPTION", "DONOTIMPORT"],
        lineterminator="\n",
    )
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def _ack_all(result) -> AffiliateOptions:  # type: ignore[no-untyped-def]
    return AffiliateOptions(acknowledged=frozenset((f.code, f.row) for f in result.findings if f.requires_ack))


def test_clean_is_exact_and_finding_free() -> None:
    result = process(canonical_for("clean.csv"))
    assert result.findings == ()
    assert result.publishable
    output = intacct_csv(result)
    assert output == _csv_bytes(expected("clean.csv")["rows"])
    assert output.startswith(b"ITEM_ID,NAME,ITEM_TYPE,DESCRIPTION,DONOTIMPORT\n")
    assert not output.startswith(b"\xef\xbb\xbf")
    assert b"\r\n" not in output


def test_edge_findings_match_upstream_expected() -> None:
    result = process(canonical_for("edge.csv"), AffiliateOptions(item_type="Non-Inventory"))
    golden = json.loads((SAMPLE_DIR / "expected.json").read_text())["files"]["affiliate_edge.csv"]
    want = sorted((f["row"] or 0, f["code"], f["severity"]) for f in golden["findings"])
    got = sorted((f.row or 0, f.code, f.severity) for f in result.findings)
    assert got == want
    assert not result.publishable
    with pytest.raises(RenderRefused):
        intacct_csv(result)


def test_empty_raises_zero_records_and_is_publishable_after_ack() -> None:
    result = process(canonical_for("empty.csv"))
    assert [(f.code, f.row) for f in result.findings] == [("AFF_WARN_ZERO_RECORDS", None)]
    assert not result.publishable
    acked = process(canonical_for("empty.csv"), _ack_all(result))
    assert acked.publishable
    assert intacct_csv(acked) == b"ITEM_ID,NAME,ITEM_TYPE,DESCRIPTION,DONOTIMPORT\n"


@pytest.mark.parametrize("name", ALL_FIXTURES)
def test_fixture_expectations(name: str) -> None:
    spec = expected(name)
    result = process(canonical_for(name))
    got = sorted((f.row or 0, f.code, f.severity) for f in result.findings)
    want = sorted((f["row"] or 0, f["code"], f["severity"]) for f in spec["findings"])
    assert got == want
    if spec["rows"] is not None:
        final = process(canonical_for(name), _ack_all(result))
        assert final.publishable
        assert intacct_csv(final) == _csv_bytes(spec["rows"])


def test_fixtures_dir_is_populated() -> None:
    assert (FIXTURE_DIR / "clean.csv").is_file()

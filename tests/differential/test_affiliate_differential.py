"""Our Affiliate rules against the original processor, on every fixture.

Outputs and finding sets must be identical except for the deviations listed
in KNOWN_DEVIATIONS.md.
"""

from __future__ import annotations

import csv
import io

import pytest
from onboarding_sdk.canonical import AffiliateCanonical, AffiliateRow
from onboarding_sdk.entities.affiliate import AffiliateOptions, process
from onboarding_sdk.render import intacct_csv

from tests.golden.test_affiliate_golden import ALL_FIXTURES
from tests.support.pipeline import canonical_for

original = pytest.importorskip("onboarding.static.affiliate")
bindings_mod = pytest.importorskip("onboarding.bindings")

KNOWN_DEVIATION_CODES = {"AFF_ERR_NAME_BLANK"}


def _as_source_csv(canon: AffiliateCanonical) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["Affiliate ID", "Affiliate Name"])
    for row in canon.rows:
        writer.writerow([row.affiliate_id or "", row.affiliate_name or ""])
    return buffer.getvalue().encode("utf-8")


def _run_original(canon: AffiliateCanonical, item_type: str | None, ack_all: bool):  # type: ignore[no-untyped-def]
    processor = original.AffiliateProcessor()
    binding_set = bindings_mod.ApprovedBindingSet.create(
        "affiliate", {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"}
    )
    first = processor.process_csv(_as_source_csv(canon), binding_set, item_type=item_type)
    acked = {f.code for f in first.findings if f.requires_ack} if ack_all else set()
    return processor.process_csv(_as_source_csv(canon), binding_set, item_type=item_type, acknowledged_codes=acked)


CASES = [
    AffiliateRow("AFF_1", None, "s", 2),  # NAME blank with an ID
    AffiliateRow(None, "Alpha & Beta, LLC", "s", 3),
    AffiliateRow("AFF_1", "Gamma LLC", "s", 4),
]


@pytest.mark.parametrize("name", [*ALL_FIXTURES, "synthetic"])
@pytest.mark.parametrize("item_type", [None, "Non-Inventory"])
@pytest.mark.parametrize("ack_all", [False, True])
def test_matches_original(name: str, item_type: str | None, ack_all: bool) -> None:
    canon = AffiliateCanonical(tuple(CASES)) if name == "synthetic" else canonical_for(name)
    theirs = _run_original(canon, item_type, ack_all)

    first = process(canon, AffiliateOptions(item_type=item_type))
    acknowledged = frozenset((f.code, f.row) for f in first.findings if f.requires_ack) if ack_all else frozenset()
    ours = process(canon, AffiliateOptions(item_type=item_type, acknowledged=acknowledged))

    our_findings = {
        (f.row, f.code, f.severity, f.blocks_publish, f.requires_ack)
        for f in ours.findings
        if f.code not in KNOWN_DEVIATION_CODES
    }
    their_findings = {(f.row, f.code, f.severity.value, f.blocks_publish, f.requires_ack) for f in theirs.findings}
    assert our_findings == their_findings
    assert [(r.item_id, r.name, r.item_type) for r in ours.records] == [
        (r.item_id, r.name, r.item_type) for r in theirs.records
    ]
    deviated = any(f.code in KNOWN_DEVIATION_CODES for f in ours.findings)
    if not deviated:
        assert ours.publishable == theirs.publishable
        if ours.publishable:
            assert intacct_csv(ours) == theirs.output_csv

from __future__ import annotations

import pytest
from onboarding_sdk.canonical import AffiliateCanonical, AffiliateRow
from onboarding_sdk.entities.affiliate import AffiliateOptions, process
from onboarding_sdk.render import intacct_csv

from tests.support.pipeline import canonical_for


def _codes(result) -> list[tuple[int | None, str]]:  # type: ignore[no-untyped-def]
    return sorted(((f.row, f.code) for f in result.findings), key=lambda x: (x[0] or 0, x[1]))


def test_name_blank_with_id_is_an_error() -> None:
    canon = AffiliateCanonical((AffiliateRow("AFF_1", None, "s", 2),))
    result = process(canon)
    assert _codes(result) == [(1, "AFF_ERR_NAME_BLANK")]
    assert not result.publishable


def test_id_override_resolves_duplicate() -> None:
    canon = canonical_for("edge.csv")
    before = process(canon)
    assert (4, "AFF_ERR_ITEM_ID_DUPLICATE") in _codes(before)
    after = process(canon, AffiliateOptions(id_overrides={4: "AFF_9011"}))
    assert (4, "AFF_ERR_ITEM_ID_DUPLICATE") not in _codes(after)
    assert after.records[3].item_id == "AFF_9011"
    assert after.records[3].id_method == "override"


def test_excluded_row_is_marked_and_not_judged() -> None:
    canon = canonical_for("edge.csv")
    result = process(canon, AffiliateOptions(excluded_rows={1: "no data"}))
    assert all(f.row != 1 or f.code == "AFF_INFO_ROW_EXCLUDED" for f in result.findings)
    assert result.records[0].do_not_import == "#"


def test_dataset_item_type_override_warns_and_needs_ack() -> None:
    canon = canonical_for("clean.csv")
    result = process(canon, AffiliateOptions(item_type="Non-Inventory"))
    assert _codes(result) == [(None, "AFF_WARN_ITEM_TYPE_OVERRIDE")]
    acked = process(
        canon,
        AffiliateOptions(
            item_type="Non-Inventory",
            acknowledged=frozenset({("AFF_WARN_ITEM_TYPE_OVERRIDE", None)}),
        ),
    )
    assert acked.publishable
    assert b",Non-Inventory,," in intacct_csv(acked)


def test_row_item_type_override_is_row_scoped() -> None:
    result = process(canonical_for("clean.csv"), AffiliateOptions(row_item_types={2: "Non-Inventory"}))
    assert _codes(result) == [(2, "AFF_WARN_ITEM_TYPE_OVERRIDE")]
    assert result.records[1].item_type == "Non-Inventory"
    assert result.records[0].item_type == "Inventory"


def test_unapproved_item_type_raises() -> None:
    with pytest.raises(ValueError, match="ITEM_TYPE"):
        process(canonical_for("clean.csv"), AffiliateOptions(item_type="Service"))


def test_ack_is_per_row() -> None:
    canon = canonical_for("ids_missing.csv")
    first = process(canon)
    partial = process(canon, AffiliateOptions(acknowledged=frozenset({("AFF_WARN_ITEM_ID_DERIVED", 1)})))
    assert not partial.publishable
    assert not first.publishable


def test_trace_covers_every_cell() -> None:
    result = process(canonical_for("clean.csv"))
    assert len(result.trace) == 8 * 5
    first = [t for t in result.trace if t.output_row == 1]
    assert {t.target_column for t in first} == {
        "ITEM_ID",
        "NAME",
        "ITEM_TYPE",
        "DESCRIPTION",
        "DONOTIMPORT",
    }
    item_id = next(t for t in first if t.target_column == "ITEM_ID")
    assert (item_id.rule_id, item_id.source_row, item_id.source_field) == (
        "affiliate.id.direct",
        2,
        "affiliate_id",
    )


def test_explain_derivation_matches_rule() -> None:
    from onboarding_sdk.entities.affiliate import derive_item_id, explain_derivation

    for name in [
        "O'Hare & Sons Nominees, LLC",
        "Cascade Employee Coinvestment Program Alpha, LLC",
        "  Meridian   Capital GP IV, LLC ",
        "Aurora Luxembourg Holdco S.a r.l.",
        "__A__B__",
        "",
    ]:
        segments = explain_derivation(name)
        kept = "".join(t for t, k in segments if k == "keep")
        assert kept == derive_item_id(name)[0], (name, segments)
        assert sum(k == "ruler" for _, k in segments) <= 1
    segments = explain_derivation("Cascade Employee Coinvestment Program Alpha, LLC")
    assert ("", "ruler") in segments
    assert any(k == "cut" for _, k in segments)
    assert ("'", "strip") in explain_derivation("O'Hare & Sons")

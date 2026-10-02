from __future__ import annotations

import pytest
from onboarding_sdk import changes as ch
from onboarding_sdk.entities.affiliate import AffiliateOptions

from tests.support.pipeline import canonical_for


def _ctx(name: str = "edge.csv", options: AffiliateOptions | None = None) -> ch.ChangeContext:
    return ch.ChangeContext(
        canonical=canonical_for(name),
        options=options or AffiliateOptions(),
        sheets=("edge",),
        columns=("Affiliate ID", "Affiliate Name", "Fund Complex"),
    )


def _rules(violations: list[ch.PolicyViolation]) -> list[str]:
    return [v.rule for v in violations]


def test_override_item_id_ok() -> None:
    assert ch.validate(ch.OverrideItemId(row=4, value="AFF_9011"), _ctx()) == []


@pytest.mark.parametrize(
    ("value", "rule"),
    [
        ("A" * 31, "item_id.max_length"),
        ("aff-9011", "item_id.charset"),
        ("", "item_id.required"),
        ("AFF_9010", "item_id.unique"),
    ],
)
def test_override_item_id_refusals(value: str, rule: str) -> None:
    assert rule in _rules(ch.validate(ch.OverrideItemId(row=4, value=value), _ctx()))


def test_row_out_of_range() -> None:
    assert "row.exists" in _rules(ch.validate(ch.OverrideItemId(row=99, value="X"), _ctx()))
    assert "row.exists" in _rules(ch.validate(ch.ExcludeRow(row=0, reason="x"), _ctx()))


def test_set_item_type() -> None:
    assert ch.validate(ch.SetItemType("Non-Inventory"), _ctx()) == []
    assert ch.validate(ch.SetItemType("Non-Inventory", rows=(1, 2)), _ctx()) == []
    assert "item_type.approved" in _rules(ch.validate(ch.SetItemType("Service"), _ctx()))
    assert "row.exists" in _rules(ch.validate(ch.SetItemType("Inventory", rows=(42,)), _ctx()))


def test_exclude_row_requires_reason() -> None:
    assert ch.validate(ch.ExcludeRow(row=1, reason="blank row"), _ctx()) == []
    assert "exclude.reason_required" in _rules(ch.validate(ch.ExcludeRow(row=1, reason=" "), _ctx()))


def test_acknowledge_rules() -> None:
    ctx = _ctx()
    assert ch.validate(ch.AcknowledgeFinding("AFF_WARN_ITEM_ID_DERIVED", 5), ctx) == []
    assert "ack.error_not_allowed" in _rules(ch.validate(ch.AcknowledgeFinding("AFF_ERR_ITEM_ID_DUPLICATE", 4), ctx))
    assert "ack.finding_exists" in _rules(ch.validate(ch.AcknowledgeFinding("AFF_WARN_ITEM_ID_DERIVED", 1), ctx))


def test_layout_changes() -> None:
    ctx = _ctx()
    assert ch.validate(ch.SetSheet("edge"), ctx) == []
    assert "sheet.exists" in _rules(ch.validate(ch.SetSheet("Nope"), ctx))
    assert ch.validate(ch.SetHeaderRow(2), ctx) == []
    assert "header_row.positive" in _rules(ch.validate(ch.SetHeaderRow(0), ctx))
    assert ch.validate(ch.SetColumnBinding("affiliate_id", None), ctx) == []
    assert "binding.column_exists" in _rules(ch.validate(ch.SetColumnBinding("affiliate_name", "X"), ctx))
    assert "binding.name_required" in _rules(ch.validate(ch.SetColumnBinding("affiliate_name", None), ctx))
    assert "binding.field_known" in _rules(ch.validate(ch.SetColumnBinding("amount", "Affiliate ID"), ctx))
    assert ch.validate(ch.RequestRecipeRevision("skip the notes rows"), ctx) == []
    assert "instruction.required" in _rules(ch.validate(ch.RequestRecipeRevision(""), ctx))


def test_dry_run_override_resolves_collision() -> None:
    impact = ch.dry_run([ch.OverrideItemId(row=4, value="AFF_9011")], canonical_for("edge.csv"), AffiliateOptions())
    assert impact.violations == []
    assert impact.rows_changed == [4]
    assert ("AFF_ERR_ITEM_ID_DUPLICATE", 4) in impact.findings_removed
    assert impact.preview == [{"row": 4, "before": {"ITEM_ID": "AFF_9010"}, "after": {"ITEM_ID": "AFF_9011"}}]
    assert impact.requires_rebuild is False


def test_dry_run_refuses_without_applying() -> None:
    options = AffiliateOptions()
    impact = ch.dry_run([ch.AcknowledgeFinding("AFF_ERR_ITEM_ID_BLANK", 1)], canonical_for("edge.csv"), options)
    assert _rules(impact.violations) == ["ack.error_not_allowed"]
    assert impact.options is None


def test_dry_run_sequential_validation() -> None:
    # Swapping two IDs: the second change is validated against the first.
    impact = ch.dry_run(
        [ch.OverrideItemId(3, "AFF_9020"), ch.OverrideItemId(4, "AFF_9010")],
        canonical_for("edge.csv"),
        AffiliateOptions(),
    )
    assert impact.violations == []
    assert impact.rows_changed == [3]
    assert ("AFF_ERR_ITEM_ID_DUPLICATE", 4) in impact.findings_removed


def test_dry_run_ack_makes_publishable() -> None:
    canon = canonical_for("ids_missing.csv")
    acks = [ch.AcknowledgeFinding("AFF_WARN_ITEM_ID_DERIVED", r) for r in range(1, 9)]
    impact = ch.dry_run(acks, canon, AffiliateOptions())
    assert impact.publishable_before is False
    assert impact.publishable_after is True
    assert impact.options is not None and len(impact.options.acknowledged) == 8


def test_dry_run_layout_change_requires_rebuild() -> None:
    impact = ch.dry_run(
        [ch.SetHeaderRow(2)],
        canonical_for("clean.csv"),
        AffiliateOptions(),
        sheets=("clean",),
        columns=("Affiliate ID", "Affiliate Name"),
    )
    assert impact.requires_rebuild is True
    assert impact.violations == []


def test_change_round_trips_through_dict() -> None:
    for change in [
        ch.SetSheet("A"),
        ch.SetHeaderRow(3),
        ch.SetColumnBinding("affiliate_id", None),
        ch.SetItemType("Inventory", rows=(1,)),
        ch.OverrideItemId(2, "X"),
        ch.ExcludeRow(1, "dup"),
        ch.AcknowledgeFinding("AFF_WARN_ZERO_RECORDS", None),
        ch.RequestRecipeRevision("x"),
    ]:
        assert ch.from_dict(ch.to_dict(change)) == change
    with pytest.raises(ValueError, match="kind"):
        ch.from_dict({"kind": "delete_everything"})

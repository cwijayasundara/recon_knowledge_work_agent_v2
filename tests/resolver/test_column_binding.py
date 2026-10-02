from __future__ import annotations

import pytest
from onboarding_sdk import profile, read
from onboarding_sdk.resolve import ColumnBindingResolver, FieldDecision

from tests.conftest import FIXTURE_DIR, REPO_ROOT

ONTOLOGY = REPO_ROOT / "workspace/ontology/affiliate.v1.json"


def _headers(name: str, sheet: str) -> list[str]:
    prof = profile.workbook(read.open(FIXTURE_DIR / name))
    return [c.name for c in prof.sheet(sheet).columns]


@pytest.fixture
def resolver() -> ColumnBindingResolver:
    return ColumnBindingResolver.create(ONTOLOGY)


def test_cold_start_renamed(resolver: ColumnBindingResolver) -> None:
    res = resolver.resolve("sponsor-a", _headers("renamed.xlsx", "Export"), run_id="run-1")
    ident, name = res.fields["affiliate_id"], res.fields["affiliate_name"]
    assert (ident.column, ident.route, ident.decision) == (
        "Affiliate Id",
        "ontology_exact",
        "matched",
    )
    assert name.decision == "needs_review"
    assert name.column is None
    assert "Affi Name" in [c.column for c in name.candidates]


def test_confirm_writes_history_for_that_sponsor_only(resolver: ColumnBindingResolver) -> None:
    headers = _headers("renamed.xlsx", "Export")
    first = resolver.resolve("sponsor-a", headers, run_id="run-1")
    confirmed = resolver.confirm(
        "sponsor-a",
        first,
        {
            "affiliate_id": FieldDecision(column="Affiliate Id"),
            "affiliate_name": FieldDecision(column="Affi Name"),
        },
        reviewer="analyst@sponsor-a",
    )
    assert confirmed.fields["affiliate_name"].route == "human_approved"
    assert confirmed.bindings() == {"affiliate_id": "Affiliate Id", "affiliate_name": "Affi Name"}

    again = resolver.resolve("sponsor-a", headers, run_id="run-2")
    assert again.fields["affiliate_name"].route == "history"
    assert again.fields["affiliate_name"].column == "Affi Name"
    assert again.fields["affiliate_name"].decision == "matched"
    # Approving the alias-matched ID also recorded it, so both replay from history.
    assert again.fields["affiliate_id"].route == "history"
    other = resolver.resolve("sponsor-b", headers, run_id="run-3")
    assert other.fields["affiliate_name"].route != "history"
    assert other.fields["affiliate_name"].decision == "needs_review"


def test_history_replay_after_both_confirmed(resolver: ColumnBindingResolver) -> None:
    headers = _headers("renamed.xlsx", "Export")
    first = resolver.resolve("sponsor-a", headers, run_id="run-1")
    resolver.confirm(
        "sponsor-a",
        first,
        {
            "affiliate_id": FieldDecision(column="Affiliate Id"),
            "affiliate_name": FieldDecision(column="Affi Name"),
        },
        reviewer="analyst",
    )
    replay = resolver.resolve("sponsor-a", headers, run_id="run-2")
    assert replay.replays({"affiliate_id": "Affiliate Id", "affiliate_name": "Affi Name"})
    assert not replay.replays({"affiliate_id": "Affiliate Id", "affiliate_name": "Other"})


def test_no_id_column_is_confirmed_as_absent(resolver: ColumnBindingResolver) -> None:
    res = resolver.resolve("sponsor-a", ["Affiliate Name", "Fund Complex"], run_id="run-1")
    assert res.fields["affiliate_id"].decision in {"unmapped", "needs_review"}
    confirmed = resolver.confirm(
        "sponsor-a",
        res,
        {
            "affiliate_id": FieldDecision(column=None),
            "affiliate_name": FieldDecision(column="Affiliate Name"),
        },
        reviewer="analyst",
    )
    assert confirmed.bindings() == {"affiliate_id": None, "affiliate_name": "Affiliate Name"}


def test_confirm_refuses_invented_column(resolver: ColumnBindingResolver) -> None:
    res = resolver.resolve("sponsor-a", ["Affiliate ID", "Affiliate Name"], run_id="run-1")
    with pytest.raises(ValueError, match="not an uploaded column"):
        resolver.confirm(
            "sponsor-a",
            res,
            {
                "affiliate_id": FieldDecision(column="Made Up"),
                "affiliate_name": FieldDecision(column="Affiliate Name"),
            },
            reviewer="analyst",
        )


@pytest.mark.parametrize("sponsor", ["", "*", "  "])
def test_wildcard_or_empty_sponsor_refused(resolver: ColumnBindingResolver, sponsor: str) -> None:
    with pytest.raises(ValueError, match="sponsor"):
        resolver.resolve(sponsor, ["Affiliate ID"], run_id="run-1")


def test_confirm_sponsor_must_match_resolution(resolver: ColumnBindingResolver) -> None:
    res = resolver.resolve("sponsor-a", ["Affiliate ID", "Affiliate Name"], run_id="run-1")
    with pytest.raises(ValueError, match="sponsor"):
        resolver.confirm("sponsor-b", res, {}, reviewer="analyst")


def test_in_memory_history_when_no_database_url(resolver: ColumnBindingResolver) -> None:
    from attribute_mapper import HistoryIndex

    assert isinstance(resolver.history, HistoryIndex)


def test_resolution_is_json_safe(resolver: ColumnBindingResolver) -> None:
    import json

    res = resolver.resolve("sponsor-a", ["Affiliate ID", "Affiliate Name"], run_id="run-1")
    json.dumps(res.to_dict())


def test_resolution_round_trips(resolver: ColumnBindingResolver) -> None:
    from onboarding_sdk.resolve import ResolutionSet

    res = resolver.resolve("sponsor-a", _headers("renamed.xlsx", "Export"), run_id="run-1")
    assert ResolutionSet.from_dict(res.to_dict()) == res

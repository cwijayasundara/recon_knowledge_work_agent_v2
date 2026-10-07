"""The live eval fails on incomplete fixtures or a missed fast-path budget."""

import pytest

from tests.live.test_affiliate_eval import ORDER, _assert_eval_acceptance


def _results() -> list[dict]:
    return [
        {
            "fixture": name,
            "passed": True,
            "questions": 1 if name == "two_sheets.xlsx" else 0,
            "model_calls": 6 if name in ("two_sheets.xlsx", "renamed.xlsx") else 0,
            "replay": name == "returning_sponsor.xlsx",
        }
        for name in ORDER
    ]


def test_all_nine_fixtures_meet_acceptance() -> None:
    _assert_eval_acceptance(_results())


def test_one_failed_fixture_fails_the_eval() -> None:
    results = _results()
    results[0]["passed"] = False
    with pytest.raises(AssertionError, match="all nine"):
        _assert_eval_acceptance(results)


def test_fastpath_model_call_fails_the_eval() -> None:
    results = _results()
    results[0]["model_calls"] = 1
    with pytest.raises(AssertionError, match="zero agent model calls"):
        _assert_eval_acceptance(results)


def test_missing_call_reduction_fails_the_eval() -> None:
    results = _results()
    results[5]["model_calls"] = 60
    with pytest.raises(AssertionError, match="40%"):
        _assert_eval_acceptance(results)

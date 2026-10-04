import contextlib
import json
import time
from pathlib import Path

import pytest

from onboarding_agent.copilot.rules import (
    MAX_FORMULA_CHARS,
    RangeSpec,
    check_formula,
    count_cells,
    parse_range,
    truncate_cell,
    valid_sheet_name,
)


def test_parse_range_single_and_block() -> None:
    assert parse_range("B2") == RangeSpec(2, 2, 2, 2)
    r = parse_range("$A$1:C3")
    assert (r.rows, r.cols, r.cells) == (3, 3, 9)


def test_parse_range_normalises_reversed() -> None:
    assert parse_range("C3:A1") == parse_range("A1:C3")


@pytest.mark.parametrize(
    "bad",
    ["", "A:A", "1:1", "A", "1", "A1:B", "A0", "XFE1", "A1048577", "A1:B2:C3", "Sheet1!A1", "A1;B2", "=A1"],
)
def test_parse_range_rejects(bad: str) -> None:
    with pytest.raises(ValueError):
        parse_range(bad)


@pytest.mark.parametrize("name", ["Sheet1", "Affiliates 2026", "x" * 31])
def test_sheet_name_ok(name: str) -> None:
    assert valid_sheet_name(name) == name


@pytest.mark.parametrize("name", ["", " ", "x" * 32, "a/b", "a\\b", "a?b", "a*b", "a[b", "a]b", "a:b", "'quoted"])
def test_sheet_name_rejects(name: str) -> None:
    with pytest.raises(ValueError):
        valid_sheet_name(name)


def test_truncate_cell() -> None:
    assert truncate_cell("x" * 600, 500) == "x" * 500 + "…"
    assert truncate_cell(12, 500) == 12
    assert truncate_cell(None, 500) is None
    assert truncate_cell("a\x00b\x07c", 500) == "abc"
    assert truncate_cell("a\tb\nc", 500) == "a\tb\nc"


_CORPUS = json.loads((Path(__file__).parents[2] / "fixtures/copilot/formula_corpus.json").read_text())


@pytest.mark.parametrize("f", _CORPUS["deny"])
def test_formula_denylist(f: str) -> None:
    with pytest.raises(ValueError):
        check_formula(f)


@pytest.mark.parametrize("f", _CORPUS["allow"])
def test_formula_allowed(f: str) -> None:
    check_formula(f)


@pytest.mark.parametrize(
    "payload",
    [
        "'x" * 500_000,
        '"' * 1_000_000,
        "=" + "a(" * 300_000,
        "=" + "[" * 4000 + "]" * 4000,
        "=" + "[a]" * 2700,
        "=" + "_xlfn." * 1360 + "x(",
        "=" + "_xlws." * 1300 + "WEBSERVICE",
    ],
)
def test_formula_pathological_input_is_fast(payload: str) -> None:
    start = time.perf_counter()
    with contextlib.suppress(ValueError):
        check_formula(payload)
    assert time.perf_counter() - start < 2


def test_count_cells() -> None:
    assert count_cells([[1, 2], [3, 4], [5, 6]]) == 6
    assert count_cells([]) == 0
    assert count_cells("x") == 0


@pytest.mark.parametrize(
    "bad",
    [
        [[["x" * 500] * 100000]],
        [{"a": 1}],
        [(1, 2)],
        [[b"x"]],
        [1, 2],
        [[{"a": 1}]],
        [["ok", ("t",)]],
    ],
)
def test_count_cells_rejects_nested(bad: object) -> None:
    with pytest.raises(ValueError):
        count_cells(bad)


def test_count_cells_ragged() -> None:
    assert count_cells([[1], [1, 2, 3]]) == 4


@pytest.mark.parametrize("v", [[1], {"a": 1}, b"x", (1,)])
def test_truncate_rejects_non_scalars(v: object) -> None:
    with pytest.raises(ValueError):
        truncate_cell(v, 500)


def test_truncate_numbers_and_limits() -> None:
    assert truncate_cell(float("nan"), 500) == "nan"
    assert truncate_cell(float("inf"), 500) == "inf"
    assert truncate_cell(-float("inf"), 500) == "-inf"
    big = truncate_cell(10**4000, 500)
    assert isinstance(big, str) and len(big) == 501
    assert truncate_cell(True, 5) is True
    assert truncate_cell(1.5, 5) == 1.5
    for lim in (0, -1):
        with pytest.raises(ValueError):
            truncate_cell("x", lim)
    assert truncate_cell("x" * 500, 500) == "x" * 500
    once = truncate_cell("x" * 600, 500)
    assert isinstance(once, str)
    assert truncate_cell(once, 501) == once


def test_sheet_name_more_rejects() -> None:
    for name in [
        "a'",
        "History",
        "history",
        "a\x00b",
        "a\tb",
        "a\u202eb",
        "a\u200bb",
        "a\x85b",
        "\U0001f600" * 31,
        "a\ud800b",
    ]:
        with pytest.raises(ValueError):
            valid_sheet_name(name)
    assert valid_sheet_name("x" * 31) == "x" * 31
    assert valid_sheet_name("\U0001f600" * 15) == "\U0001f600" * 15
    assert valid_sheet_name("It's ok") == "It's ok"


@pytest.mark.parametrize("ch", ["\x85", "\u200b", "\u2028", "\u2029", "\u202e", "\u2066", "\ufeff", "\x9f"])
def test_truncate_strips_invisible(ch: str) -> None:
    assert truncate_cell(f"a{ch}b", 500) == "ab"


@pytest.mark.parametrize(
    "bad", ["A\u0661", "A\u0661:B\u0662", "A\u0e51", "\tA1\r\n", "A1\u2028", "A1\x85", " A1", "A1 ", "A0000001"]
)
def test_parse_range_rejects_unicode_and_whitespace(bad: str) -> None:
    with pytest.raises(ValueError):
        parse_range(bad)


@pytest.mark.parametrize("text", ["A1", "B2", "A1:C3", "Z9:AA10", "XFD1", "A1048576", "XFD1048576", "A1:XFD1048576"])
def test_a1_round_trip(text: str) -> None:
    assert parse_range(text).a1() == text
    assert parse_range(parse_range(text).a1()) == parse_range(text)


def test_a1_canonicalises() -> None:
    assert parse_range("$c$3:$A$1").a1() == "A1:C3"


def test_bounds_accept_and_reject() -> None:
    for ok in ("XFD1", "A1048576", "XFD1048576"):
        parse_range(ok)
    for bad in ("XFE1", "A1048577"):
        with pytest.raises(ValueError):
            parse_range(bad)


_N = MAX_FORMULA_CHARS
_SHAPES = {
    "bracket_spaces": lambda n: "[x]" + " " * (n - 3),
    "quote_brackets": lambda n: "='x" + "[" * (n - 3),
    "quoted_brackets": lambda n: "'a" + "[" * (n - 3) + "'",
    "quote_colons": lambda n: "'" + "a:" * (n // 2),
    "tab_space": lambda n: "[x]" + " \t" * (n // 2),
    "bracket_tabs": lambda n: "=[x]'" + " \t" * (n // 2),
    "quotes": lambda n: "'" * n,
    "dquotes": lambda n: '"' * n,
    "dquote_pairs": lambda n: '"' + '""' * (n // 2 - 1),
    "apos_pairs": lambda n: "'a'" * (n // 3),
    "bracket_runs": lambda n: "[a" * (n // 2),
    "call_spaces": lambda n: "=CALL" + " " * (n - 5),
    "call_repeat": lambda n: "CALL " * (n // 5),
    "xll_repeat": lambda n: "_xll." * (n // 5),
    "xl_prefix": lambda n: "_xlfn." * (n // 6),
}


@pytest.mark.parametrize("name", list(_SHAPES))
def test_formula_worst_case_at_cap_is_fast(name: str) -> None:
    payload = _SHAPES[name](_N)[:_N]
    start = time.perf_counter()
    with contextlib.suppress(ValueError):
        check_formula(payload)
    assert time.perf_counter() - start < 0.1


@pytest.mark.parametrize("name", list(_SHAPES))
def test_formula_one_mb_rejected_by_length_cap(name: str) -> None:
    payload = _SHAPES[name](1_000_000)
    start = time.perf_counter()
    with pytest.raises(ValueError, match="too long"):
        check_formula(payload)
    assert time.perf_counter() - start < 0.05


def test_formula_length_boundary() -> None:
    check_formula("=" + "1" * (_N - 1))
    with pytest.raises(ValueError):
        check_formula("=" + "1" * _N)


@pytest.mark.parametrize("ch", ["\u00ad", "\u061c", "\u180e", "\ufe0f", "\ufe00", "\u200d"])
def test_hidden_chars_stripped_and_rejected(ch: str) -> None:
    assert truncate_cell(f"a{ch}b", 500) == "ab"
    with pytest.raises(ValueError):
        valid_sheet_name(f"a{ch}b")


def test_truncate_large_number_pinned() -> None:
    assert truncate_cell(10**15, 500) == str(10**15)
    assert truncate_cell(10**15 - 1, 500) == 10**15 - 1
    assert truncate_cell(1e15, 500) == str(1e15)
    assert truncate_cell(-1e15, 500) == str(-1e15)
    assert truncate_cell(1e14, 500) == 1e14

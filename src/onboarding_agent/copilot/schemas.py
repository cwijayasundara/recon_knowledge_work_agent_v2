"""Wire and tool-argument schemas for the Copilot.

Validation here is structural and fail-closed; per-call and per-session cell caps are enforced by the loop (S4).
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from onboarding_agent.copilot.rules import (
    MAX_FORMULA_CHARS,
    check_formula,
    count_cells,
    is_hidden_char,
    parse_range,
    truncate_cell,
    valid_sheet_name,
)

CLIENT_TOOLS = frozenset({"list_sheets", "describe_sheet", "read_range", "find", "get_selection"})
SERVER_TOOLS = frozenset({"run_state", "run_findings", "check_changes"})
PROPOSAL_TOOLS = frozenset({"propose_changes", "propose_write"})
ALL_TOOLS = CLIENT_TOOLS | SERVER_TOOLS | PROPOSAL_TOOLS

# Static schema ceiling only; the real per-call, per-session and write caps are enforced in S4.
MAX_PAYLOAD_CELLS = 20_000
EXCEL_CELL_CHARS = 32_767
MAX_CONTENT_BYTES = 1_000_000
MAX_CONTENT_DEPTH = 8
_NUMERIC = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
# NFKC folds fullwidth ＝＋＠－ to ASCII; U+2212 (minus sign) has no NFKC fold, so it is listed explicitly.
_FORMULA_LEADS = ("=", "+", "@", "-", "\u2212")
_CALL_ID = r"^[A-Za-z0-9_-]{1,80}$"
_RUN_ID = r"^run-[0-9a-f]{1,32}$"

Scalar = str | int | float | bool | None


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _utf16_len(text: str) -> int:
    """Length as Excel counts it (UTF-16 code units: a character outside the BMP counts twice)."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _safe_value(c: Scalar) -> Scalar:
    # Refused, never shortened: a cut would change the value, and Excel stores at most EXCEL_CELL_CHARS units.
    if isinstance(c, str) and len(c) > 4 * EXCEL_CELL_CHARS:  # bounds the work below
        raise ValueError("text is longer than Excel's cell limit")
    out = truncate_cell(c, 4 * EXCEL_CELL_CHARS)  # strips hidden characters first, so they cannot hide a leading '='
    if isinstance(out, str) and _utf16_len(out) > EXCEL_CELL_CHARS:
        raise ValueError("text is longer than Excel's cell limit")
    if isinstance(out, str):
        stripped = out.strip()
        # NFKC can expand one character to several (U+2A75 -> "=="), so take the first folded character.
        lead = unicodedata.normalize("NFKC", out.lstrip()[:1])[:1]
        if (out and out[0] in ("\t", "\r")) or (lead in _FORMULA_LEADS and not _NUMERIC.fullmatch(stripped)):
            raise ValueError(
                "use the formulas field for formulas: text values must not start with = + @ - or a tab/CR "
                "unless they are plain numbers"
            )
    return out


def _sheet(v: str) -> str:
    return valid_sheet_name(v)


def _range(v: str) -> str:
    spec = parse_range(v)
    if spec.cells > MAX_PAYLOAD_CELLS:
        raise ValueError("range is too large")
    return spec.a1()  # canonical text, never the model's raw string


def _plain(v: str, *, allow_newline: bool = False) -> str:
    if any(is_hidden_char(ch) and not (allow_newline and ch == "\n") for ch in v):
        raise ValueError("text has control or invisible characters")
    return v


_Short = Annotated[str, Field(max_length=200)]
_Long = Annotated[str, Field(max_length=2000)]
_RowNo = Annotated[int, Field(ge=1, le=1_048_576)]


class SetSheet(_Model):
    kind: Literal["set_sheet"]
    sheet: _Short


class SetHeaderRow(_Model):
    kind: Literal["set_header_row"]
    header_row: _RowNo


class SetColumnBinding(_Model):
    kind: Literal["set_column_binding"]
    field: _Short
    column: _Short | None


class SetItemType(_Model):
    kind: Literal["set_item_type"]
    value: _Long
    rows: list[_RowNo] | None = Field(default=None, max_length=1000)


class OverrideItemId(_Model):
    kind: Literal["override_item_id"]
    row: _RowNo
    value: _Long


class ExcludeRow(_Model):
    kind: Literal["exclude_row"]
    row: _RowNo
    reason: _Long


class RequestRecipeRevision(_Model):
    kind: Literal["request_recipe_revision"]
    instruction: _Long


# The stage-1 typed changes minus acknowledge_finding: only an analyst's explicit click acknowledges a finding.
CopilotChange = Annotated[
    SetSheet | SetHeaderRow | SetColumnBinding | SetItemType | OverrideItemId | ExcludeRow | RequestRecipeRevision,
    Field(discriminator="kind"),
]


class ListSheets(_Model):
    pass


class GetSelection(_Model):
    pass


class RunState(_Model):
    pass


class DescribeSheet(_Model):
    sheet: str

    _v_sheet = field_validator("sheet")(_sheet)


class ReadRange(_Model):
    sheet: str
    range: str

    _v_sheet = field_validator("sheet")(_sheet)
    _v_range = field_validator("range")(_range)


class Find(_Model):
    text: str
    sheet: str | None = None

    @field_validator("text")
    @classmethod
    def _v_text(cls, v: str) -> str:
        v = _plain(v.strip())
        if not 1 <= len(v) <= 200:
            raise ValueError("text must be 1-200 characters")
        return v

    @field_validator("sheet")
    @classmethod
    def _v_sheet(cls, v: str | None) -> str | None:
        return None if v is None else valid_sheet_name(v)


class RunFindings(_Model):
    severity: Literal["error", "warning", "info"] | None = None


class CheckChanges(_Model):
    changes: list[CopilotChange] = Field(max_length=100)


class ProposeChanges(_Model):
    restated: str = Field(min_length=1, max_length=2000)
    changes: list[CopilotChange] = Field(min_length=1, max_length=100)

    @field_validator("restated")
    @classmethod
    def _v_restated(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("restated must not be empty")
        return _plain(v, allow_newline=True)


class ProposeWrite(_Model):
    """A write proposal; nothing is written until the analyst clicks Apply.

    Values are sanitised: control/invisible characters (including ZWJ and soft hyphens, so emoji ZWJ sequences are
    not preserved) are stripped, and text that could be read as a formula must go in ``formulas``.
    """

    sheet: str
    range: str
    values: list[list[Scalar]] | None = None
    formulas: list[list[str]] | None = None
    note: str = Field(default="", max_length=500)

    @field_validator("note")
    @classmethod
    def _v_note(cls, v: str) -> str:
        return _plain(v, allow_newline=True)

    _v_sheet = field_validator("sheet")(_sheet)
    _v_range = field_validator("range")(_range)

    @field_validator("values")
    @classmethod
    def _v_values(cls, v: list[list[Scalar]] | None) -> list[list[Scalar]] | None:
        if v is None:
            return v
        if count_cells(v) > MAX_PAYLOAD_CELLS:
            raise ValueError("payload too large")
        return [[_safe_value(c) for c in row] for row in v]

    @field_validator("formulas")
    @classmethod
    def _v_formulas(cls, v: list[list[str]] | None) -> list[list[str]] | None:
        if v is None:
            return v
        if count_cells(v) > MAX_PAYLOAD_CELLS:
            raise ValueError("payload too large")
        for row in v:
            for f in row:
                if len(f) > MAX_FORMULA_CHARS:
                    raise ValueError("formula is too long")
                if not f.startswith("=") or len(f) < 2:
                    raise ValueError("formulas must start with '='")
                check_formula(f)
        return v

    @model_validator(mode="after")
    def _shape(self) -> ProposeWrite:
        if (self.values is None) == (self.formulas is None):
            raise ValueError("provide exactly one of values or formulas")
        grid = self.values if self.values is not None else self.formulas
        assert grid is not None
        spec = parse_range(self.range)
        if len(grid) != spec.rows or any(len(r) != spec.cols for r in grid):
            raise ValueError("payload shape does not match range")
        return self


TOOL_MODELS: dict[str, type[BaseModel]] = {
    "list_sheets": ListSheets,
    "describe_sheet": DescribeSheet,
    "read_range": ReadRange,
    "find": Find,
    "get_selection": GetSelection,
    "run_state": RunState,
    "run_findings": RunFindings,
    "check_changes": CheckChanges,
    "propose_changes": ProposeChanges,
    "propose_write": ProposeWrite,
}


class StartIn(_Model):
    run_id: str | None = Field(default=None, pattern=_RUN_ID)


def _check_content(content: object) -> None:
    """Iterative walk (no recursion): JSON types only, nesting <= MAX_CONTENT_DEPTH, encoded size bounded."""
    stack: list[tuple[object, int]] = [(content, 0)]
    while stack:
        node, depth = stack.pop()
        if isinstance(node, dict):
            if depth >= MAX_CONTENT_DEPTH or not all(isinstance(k, str) for k in node):
                raise ValueError("content is nested too deeply or has non-string keys")
            stack.extend((v, depth + 1) for v in node.values())
        elif isinstance(node, list):
            if depth >= MAX_CONTENT_DEPTH:
                raise ValueError("content is nested too deeply")
            stack.extend((v, depth + 1) for v in node)
        elif node is not None and not isinstance(node, str | int | float | bool):
            raise ValueError("content must be JSON")
    try:
        encoded = json.dumps(content, allow_nan=False)
    except ValueError:
        raise ValueError("content must not contain NaN or Infinity") from None
    if len(encoded.encode()) > MAX_CONTENT_BYTES:
        raise ValueError("content is too large")


class ToolResultIn(_Model):
    call_id: str = Field(pattern=_CALL_ID)
    ok: StrictBool
    content: Any = None

    @field_validator("content")
    @classmethod
    def _v_content(cls, v: Any) -> Any:
        _check_content(v)
        return v


class StepIn(_Model):
    user_message: str | None = None
    tool_results: list[ToolResultIn] | None = Field(default=None, min_length=1, max_length=32)

    @field_validator("user_message")
    @classmethod
    def _v_message(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.replace("\r\n", "\n").strip()
        if any(("\ud800" <= ch <= "\udfff") or (is_hidden_char(ch) and ch not in "\n\t") for ch in v):
            raise ValueError("user_message has control, invisible or unpaired surrogate characters")
        if not 1 <= len(v) <= 8000:
            raise ValueError("user_message must be 1-8000 characters")
        return v

    @model_validator(mode="after")
    def _one_of(self) -> StepIn:
        if (self.user_message is None) == (self.tool_results is None):
            raise ValueError("provide exactly one of user_message or tool_results")
        if self.tool_results is not None:
            ids = [r.call_id for r in self.tool_results]
            if len(set(ids)) != len(ids):
                raise ValueError("duplicate call_id")
        return self


class ToolCallOut(_Model):
    id: str
    name: str
    args: dict[str, Any]


class StepOut(_Model):
    status: Literal["tool_calls", "final"]
    tool_calls: list[ToolCallOut] = Field(default_factory=list)
    text: str = ""
    proposed_changes: list[CopilotChange] = Field(default_factory=list)
    proposed_writes: list[ProposeWrite] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


_DESCRIPTIONS = {
    "list_sheets": "List the worksheets in the open workbook.",
    "describe_sheet": "Describe one worksheet: used range, header guess, merged ranges, formula/constant/blank counts.",
    "read_range": "Read capped cell values and formulas from one range (A1 or A1:B2) of a worksheet.",
    "find": "Find text in the workbook (optionally one sheet); returns capped matches with addresses.",
    "get_selection": "Return the address of the analyst's current selection.",
    "run_state": "Summarise the bound onboarding run: phase, status, source and bindings.",
    "run_findings": "List the run's findings, optionally filtered by severity.",
    "check_changes": "Dry-run typed changes against the run and report impact and violations.",
    "propose_changes": "Propose typed changes for the analyst to review and apply; nothing is applied by this call.",
    "propose_write": "Propose writing values or formulas to a range; nothing is written until the analyst applies it.",
}


def _inline(node: Any, defs: dict[str, Any]) -> Any:
    if isinstance(node, dict):
        if "$ref" in node:
            return _inline(defs[node["$ref"].rsplit("/", 1)[-1]], defs)
        out = {k: _inline(v, defs) for k, v in node.items() if k not in ("title", "discriminator", "$defs")}
        props = out.get("properties")
        if isinstance(props, dict):
            if "kind" in props and "kind" not in out.setdefault("required", []):
                out["required"].append("kind")
            out["additionalProperties"] = False
        return out
    if isinstance(node, list):
        return [_inline(v, defs) for v in node]
    return node


def tool_specs() -> list[dict[str, Any]]:
    """OpenAI-style function specs for every registry tool (for ``bind_tools``)."""
    specs = []
    for name in sorted(ALL_TOOLS):
        schema = TOOL_MODELS[name].model_json_schema()
        params = _inline(schema, schema.get("$defs", {}))
        params.pop("description", None)
        params.setdefault("properties", {})
        params["type"] = "object"
        params["additionalProperties"] = False
        specs.append(
            {"type": "function", "function": {"name": name, "description": _DESCRIPTIONS[name], "parameters": params}}
        )
    return specs

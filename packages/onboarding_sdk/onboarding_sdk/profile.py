"""Workbook profiling: header detection, column statistics and a layout fingerprint.

The profile is what a model sees of an upload: shapes and a few samples,
never the full rows.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any

from .read import Sheet, Value, Workbook, text

SCAN_ROWS = 30
BELOW_ROWS = 5
MAX_HEADER_CANDIDATES = 3
SAMPLE_COUNT = 5
_NUMERIC = re.compile(r"^[-+]?[\d,]*\.?\d+$")
_INTEGER = re.compile(r"^[-+]?\d+$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")
_TOKENS = re.compile(r"[A-Za-z]+|\d+|\s+|.")


@dataclass(frozen=True, slots=True)
class HeaderCandidate:
    row: int
    score: float
    cells: list[str]


@dataclass(frozen=True, slots=True)
class ColumnProfile:
    name: str
    inferred_type: str
    fill_rate: float
    distinct: int
    samples: list[str]
    pattern: str | None


@dataclass(frozen=True, slots=True)
class SheetProfile:
    name: str
    max_row: int
    header_candidates: list[HeaderCandidate]
    header_row: int | None
    columns: list[ColumnProfile]
    row_count: int
    dropped: list[tuple[int, str]]
    looks_like_list: float


@dataclass(frozen=True, slots=True)
class WorkbookProfile:
    file: str
    kind: str
    sheets: list[SheetProfile] = field(default_factory=list)

    def sheet(self, name: str) -> SheetProfile:
        for sheet in self.sheets:
            if sheet.name == name:
                return sheet
        raise KeyError(name)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def shape(value: str) -> str:
    """A value's character-class outline: letters→A, digits→9, spaces→' '."""
    out = re.sub(r"[A-Za-z]+", "A", value)
    out = re.sub(r"\d+", "9", out)
    return re.sub(r"\s+", " ", out)


def _is_texty(raw: Value, cell: str) -> bool:
    return isinstance(raw, str) and not _NUMERIC.match(cell) and len(cell) <= 60


def _score_row(sheet: Sheet, row_number: int, max_width: int) -> float:
    raw = sheet.row(row_number)
    cells = [text(v) for v in raw]
    filled = [(i, c) for i, c in enumerate(cells) if c]
    if not filled or max_width == 0:
        return 0.0
    n = len(filled)
    width = n / max_width
    text_ratio = sum(_is_texty(raw[i], c) for i, c in filled) / n
    unique = len({c.casefold() for _, c in filled}) / n
    digit_frac = sum(any(ch.isdigit() for ch in c) for _, c in filled) / n

    below: list[list[str | None]] = []
    for next_row in range(row_number + 1, sheet.max_row + 1):
        values = [text(v) for v in sheet.row(next_row)]
        if any(values):
            below.append(values)
        if len(below) == BELOW_ROWS:
            break
    column_contrast: list[float] = []
    for index, cell in filled:
        column = [r[index] for r in below if index < len(r) and r[index]]
        if not column:
            column_contrast.append(0.5)
            continue
        shapes = {shape(v) for v in column if v}
        column_contrast.append(0.0 if shape(cell) in shapes else 1.0)
    contrast = sum(column_contrast) / len(column_contrast)
    return round(width * text_ratio * unique * (1 - 0.5 * digit_frac) * (0.4 + 0.6 * contrast), 4)


def header_candidates(sheet: Sheet) -> list[HeaderCandidate]:
    scan = min(sheet.max_row, SCAN_ROWS)
    max_width = max((sum(1 for v in sheet.row(r) if text(v)) for r in range(1, scan + 1)), default=0)
    scored = [(r, _score_row(sheet, r, max_width)) for r in range(1, scan + 1)]
    ranked = sorted((item for item in scored if item[1] > 0), key=lambda item: (-item[1], item[0]))
    return [
        HeaderCandidate(r, s, [c or "" for c in (text(v) for v in sheet.row(r))])
        for r, s in ranked[:MAX_HEADER_CANDIDATES]
    ]


def _infer_type(values: list[str]) -> str:
    if not values:
        return "empty"
    if all(_INTEGER.match(v) for v in values):
        return "integer"
    if all(_NUMERIC.match(v) for v in values):
        return "number"
    if all(_DATE.match(v) for v in values):
        return "date"
    if all(v.casefold() in {"true", "false"} for v in values):
        return "boolean"
    return "string"


def infer_pattern(values: list[str]) -> str | None:
    """A regex every value matches, when the values share one token outline."""
    if not values:
        return None
    tokenised = [_TOKENS.findall(v) for v in values]
    length = len(tokenised[0])
    if length > 12 or any(len(tokens) != length for tokens in tokenised):
        return None
    parts: list[str] = []
    for position in range(length):
        column = [tokens[position] for tokens in tokenised]
        first = column[0]
        if first.isdigit():
            if not all(t.isdigit() for t in column):
                return None
            sizes = {len(t) for t in column}
            parts.append(rf"\d{{{sizes.pop()}}}" if len(sizes) == 1 else r"\d+")
        elif first.isalpha():
            if not all(t.isalpha() for t in column):
                return None
            parts.append(re.escape(first) if len(set(column)) == 1 else "[A-Za-z]+")
        elif first.isspace():
            if not all(t.isspace() for t in column):
                return None
            parts.append(r"\s+")
        else:
            if len(set(column)) != 1:
                return None
            parts.append(re.escape(first))
    return "".join(parts)


def _profile_sheet(sheet: Sheet) -> SheetProfile:
    candidates = header_candidates(sheet)
    if not candidates:
        return SheetProfile(sheet.name, sheet.max_row, [], None, [], 0, [], 0.0)
    best = candidates[0]
    table = sheet.table(best.row)
    records = list(table.rows())
    columns: list[ColumnProfile] = []
    for name in table.columns:
        values = [v for v in (r.get(name) for r in records) if v]
        samples = list(dict.fromkeys(values))[:SAMPLE_COUNT]
        columns.append(
            ColumnProfile(
                name=name,
                inferred_type=_infer_type(values),
                fill_rate=round(len(values) / len(records), 4) if records else 0.0,
                distinct=len(set(values)),
                samples=samples,
                pattern=infer_pattern(values),
            )
        )
    named = [c for c in columns if not c.name.startswith("column_")]
    mean_fill = sum(c.fill_rate for c in named) / len(named) if named else 0.0
    return SheetProfile(
        name=sheet.name,
        max_row=sheet.max_row,
        header_candidates=candidates,
        header_row=best.row,
        columns=columns,
        row_count=len(records),
        dropped=table.dropped,
        looks_like_list=round(best.score * mean_fill, 4),
    )


def workbook(wb: Workbook) -> WorkbookProfile:
    return WorkbookProfile(wb.path.name, wb.kind, [_profile_sheet(s) for s in wb.sheets])


def normalise_header(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip().casefold()


def sheet_signature(sheet: SheetProfile) -> dict[str, Any]:
    return {
        "header_row": sheet.header_row,
        "headers": [normalise_header(c.name) for c in sheet.columns],
        "types": [c.inferred_type for c in sheet.columns],
    }


def fingerprint(prof: WorkbookProfile) -> str:
    """Layout identity: stable when values change, different when headers change.

    A CSV's name is its file name, which says nothing about the layout, so it
    is left out.
    """
    payload = {
        "kind": prof.kind,
        "sheets": [{"name": s.name if prof.kind == "excel" else "<csv>", **sheet_signature(s)} for s in prof.sheets],
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()

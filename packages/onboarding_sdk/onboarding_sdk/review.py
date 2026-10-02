"""The analyst's review workbook: source, a live-formula preview, findings, decisions, brief.

The preview uses formulas where Excel can reproduce the rule (a direct copy,
``LEFT(...,100)``). A derived ITEM_ID is written as a value with the rule id
in a cell note, because Excel cannot reproduce the strip rule faithfully.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import re
import zipfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

from . import read
from .canonical import AffiliateCanonical
from .entities.affiliate.policy import TEMPLATE_COLUMNS
from .entities.affiliate.rules import AffiliateRecord, AffiliateResult

_FIXED_TIME = "2000-01-01T00:00:00Z"
_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
_BOLD = Font(bold=True)


def _as_text(ws: Any, *, keep: set[str]) -> None:
    """Store every string cell as text. Source values and actor names beginning
    with '=' must not become live formulas; only our own preview formulas may."""
    for row in ws.iter_rows():
        for cell in row:
            if cell.data_type == "f" and cell.coordinate not in keep:
                cell.data_type = "s"


def xlsx_bytes(wb: Workbook) -> bytes:
    """Save with pinned timestamps so equal content gives equal bytes."""
    raw = io.BytesIO()
    wb.save(raw)
    raw.seek(0)
    out = io.BytesIO()
    with zipfile.ZipFile(raw) as src, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in sorted(src.infolist(), key=lambda info: info.filename):
            data = src.read(item.filename)
            if item.filename == "docProps/core.xml":
                data = re.sub(
                    rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</dcterms:(?:created|modified)>)",
                    rb"\g<1>" + _FIXED_TIME.encode() + rb"\g<2>",
                    data,
                )
            info = zipfile.ZipInfo(item.filename, date_time=_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            dst.writestr(info, data)
    return out.getvalue()


def _header(ws: Any, names: Sequence[str]) -> None:
    ws.append(list(names))
    for cell in ws[1]:
        cell.font = _BOLD
    ws.freeze_panes = "A2"


def _cell_value(value: read.Value) -> Any:
    # openpyxl cannot store a timedelta cell; everything else it writes natively.
    return str(value) if isinstance(value, dt.timedelta) else value


def _source_ref(
    record: AffiliateRecord,
    source: read.Sheet,
    column_index: int | None,
) -> tuple[str, str] | None:
    """(cell reference, raw text) when a record's field can be linked by formula."""
    if column_index is None or record.source_sheet != source.name:
        return None
    raw_row = source.row(record.source_row)
    raw = raw_row[column_index] if column_index < len(raw_row) else None
    if not isinstance(raw, str) or raw != raw.strip():
        return None
    return f"Source!{get_column_letter(column_index + 1)}{record.source_row}", raw


def workbook(
    upload: str | Path,
    canonical: AffiliateCanonical,
    result: AffiliateResult,
    decisions: Sequence[Mapping[str, Any]],
    brief: Mapping[str, Any] | None,
    *,
    bindings: Mapping[str, str | None],
    header_row: int | None,
) -> bytes:
    upload_wb = read.open(upload)
    source_name = canonical.rows[0].source_sheet if canonical.rows else upload_wb.sheets[0].name
    source = upload_wb.select(source_name)
    columns: list[str] = source.table(header_row).columns if header_row else []

    def index_of(field: str) -> int | None:
        column = bindings.get(field)
        return columns.index(column) if column in columns else None

    id_index, name_index = index_of("affiliate_id"), index_of("affiliate_name")
    limit = result.policy.name_limit

    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "Source"
    for raw_row in source.grid:
        ws.append([_cell_value(v) for v in raw_row])

    preview = wb.create_sheet("Upload preview")
    _header(preview, [*TEMPLATE_COLUMNS, "ID method", "Source sheet", "Source row"])
    ours: set[str] = set()
    for offset, record in enumerate(result.records, start=2):
        values: list[Any] = list(record.as_template_row().values())
        id_rule = "affiliate.id.derive_from_name"
        if record.id_method == "direct" and (ref := _source_ref(record, source, id_index)):
            values[0] = f"={ref[0]}"
            ours.add(f"A{offset}")
        name_ref = _source_ref(record, source, name_index)
        if name_ref:
            values[1] = f"=LEFT({name_ref[0]},{limit})"
            ours.add(f"B{offset}")
        preview.append([*values, record.id_method, record.source_sheet, record.source_row])
        if record.id_method == "derived":
            preview.cell(offset, 1).comment = Comment(
                f"Derived by rule {id_rule}: uppercase, spaces to _, strip non [A-Z0-9_], "
                f"collapse _, truncate to {result.policy.item_id_limit}.",
                "onboarding",
            )
        elif record.id_method == "override":
            preview.cell(offset, 1).comment = Comment("Analyst override (affiliate.id.analyst_override).", "onboarding")

    findings = wb.create_sheet("Findings")
    _header(findings, ["code", "severity", "row", "source_row", "scope", "requires_ack", "message"])
    source_rows = {r.row: r.source_row for r in result.records}
    for f in result.findings:
        findings.append(
            [
                f.code,
                f.severity,
                f.row,
                source_rows.get(f.row) if f.row else None,
                f.scope,
                f.requires_ack,
                f.message,
            ]
        )

    decisions_ws = wb.create_sheet("Decisions")
    _header(decisions_ws, ["seq", "kind", "gate", "actor", "at", "payload"])
    for d in decisions:
        decisions_ws.append(
            [
                d.get("seq"),
                d.get("kind"),
                d.get("gate"),
                d.get("actor"),
                d.get("at"),
                json.dumps(d.get("payload", {}), sort_keys=True),
            ]
        )

    brief_ws = wb.create_sheet("Brief")
    _header(brief_ws, ["section", "value"])
    for key, value in (brief or {}).items():
        brief_ws.append([key, json.dumps(value, sort_keys=True, default=str)])

    for sheet in wb.worksheets:
        _as_text(sheet, keep=ours if sheet is preview else set())
    return xlsx_bytes(wb)

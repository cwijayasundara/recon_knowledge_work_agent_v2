"""Affiliate rules, ported from the original processor and proven equal by tests/differential.

``row`` everywhere in this module is the 1-based position of a record in the
canonical table (the same numbering the original processor and its golden
expectations use). Where the record came from lives in ``source_sheet`` /
``source_row``.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from ...canonical import AffiliateCanonical
from .policy import TEMPLATE_COLUMNS, AffiliatePolicy

Severity = Literal["error", "warning", "info"]
IdMethod = Literal["direct", "derived", "override"]
AckKey = tuple[str, int | None]

_WORD_SEPARATOR = re.compile(r"\s+")
_NON_ID = re.compile(r"[^A-Z0-9_]")
_UNDERSCORES = re.compile(r"_+")
# Spaces and ordinary company-name punctuation are part of the approved
# normalisation. Apostrophes and ampersands are the cases whose removal
# changes meaning, so they need acknowledgement.
_MEANINGFUL_STRIP = re.compile(r"['&]")
_ID_RULE: dict[str, tuple[str, str]] = {
    "direct": ("affiliate.id.direct", "direct"),
    "derived": ("affiliate.id.derive_from_name", "derive"),
    "override": ("affiliate.id.analyst_override", "override"),
}


@dataclass(frozen=True, slots=True)
class Finding:
    code: str
    severity: Severity
    scope: Literal["row", "dataset"]
    message: str
    row: int | None = None
    blocks_transform: bool = False
    blocks_publish: bool = False
    requires_ack: bool = False

    @property
    def key(self) -> AckKey:
        return (self.code, self.row)


@dataclass(frozen=True, slots=True)
class CellTrace:
    output_row: int
    target_column: str
    rule_id: str
    operation: str
    source_sheet: str | None = None
    source_row: int | None = None
    source_field: str | None = None


@dataclass(frozen=True, slots=True)
class AffiliateRecord:
    row: int
    item_id: str
    name: str
    item_type: str
    id_method: IdMethod
    source_sheet: str
    source_row: int
    description: str = ""
    do_not_import: str = ""

    def as_template_row(self) -> dict[str, str]:
        values = (self.item_id, self.name, self.item_type, self.description, self.do_not_import)
        return dict(zip(TEMPLATE_COLUMNS, values, strict=True))


@dataclass(frozen=True, slots=True)
class AffiliateOptions:
    item_type: str | None = None
    row_item_types: Mapping[int, str] = field(default_factory=dict)
    id_overrides: Mapping[int, str] = field(default_factory=dict)
    excluded_rows: Mapping[int, str] = field(default_factory=dict)
    acknowledged: frozenset[AckKey] = frozenset()

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form: row keys become strings, acknowledgements a sorted list."""
        return {
            "item_type": self.item_type,
            "row_item_types": {str(k): v for k, v in sorted(self.row_item_types.items())},
            "id_overrides": {str(k): v for k, v in sorted(self.id_overrides.items())},
            "excluded_rows": {str(k): v for k, v in sorted(self.excluded_rows.items())},
            "acknowledged": [[code, row] for code, row in sorted(self.acknowledged, key=lambda k: (k[0], k[1] or 0))],
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> AffiliateOptions:
        return cls(
            item_type=payload.get("item_type"),
            row_item_types={int(k): v for k, v in payload.get("row_item_types", {}).items()},
            id_overrides={int(k): v for k, v in payload.get("id_overrides", {}).items()},
            excluded_rows={int(k): v for k, v in payload.get("excluded_rows", {}).items()},
            acknowledged=frozenset(
                (str(code), None if row is None else int(row)) for code, row in payload.get("acknowledged", [])
            ),
        )


@dataclass(frozen=True, slots=True)
class AffiliateResult:
    records: tuple[AffiliateRecord, ...]
    findings: tuple[Finding, ...]
    publishable: bool
    trace: tuple[CellTrace, ...]
    policy: AffiliatePolicy

    def open_errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error" and f.blocks_publish]

    def unacknowledged(self, acknowledged: frozenset[AckKey]) -> list[Finding]:
        return [f for f in self.findings if f.requires_ack and f.key not in acknowledged]

    def counts_by_code(self) -> dict[str, int]:
        return dict(sorted(Counter(f.code for f in self.findings).items()))


def derive_item_id(name: str, limit: int = 30) -> tuple[str, bool, bool]:
    """(derived id, meaningful characters stripped, truncated)."""
    separated = _WORD_SEPARATOR.sub("_", name.strip().upper())
    collapsed = _UNDERSCORES.sub("_", _NON_ID.sub("", separated)).strip("_")
    return collapsed[:limit], bool(_MEANINGFUL_STRIP.search(name)), len(collapsed) > limit


def explain_derivation(name: str, limit: int = 30) -> list[tuple[str, str]]:
    """How ``derive_item_id`` treats each character, for display.

    Segments are ``keep`` (in the ID), ``strip`` (removed), ``cut`` (past the
    limit) and ``ruler`` (the limit itself). Kept and cut text concatenate to
    the derived ID before truncation.
    """
    upper = _WORD_SEPARATOR.sub("_", name.strip().upper())
    segments: list[tuple[str, str]] = []
    kept = 0
    previous_underscore = True  # leading underscores are stripped too
    pending_underscore = False
    for ch in upper:
        if _NON_ID.match(ch):
            segments.append((ch, "strip"))
            continue
        if ch == "_":
            if previous_underscore:
                segments.append((ch, "strip"))
            else:
                pending_underscore = True
                previous_underscore = True
            continue
        if pending_underscore:
            segments.append(("_", "keep" if kept < limit else "cut"))
            if kept == limit - 1:
                segments.append(("", "ruler"))
            kept += 1
            pending_underscore = False
        segments.append((ch, "keep" if kept < limit else "cut"))
        kept += 1
        if kept == limit:
            segments.append(("", "ruler"))
        previous_underscore = False
    if pending_underscore:
        segments.append(("_", "strip"))
    merged: list[tuple[str, str]] = []
    for text, kind in segments:
        if merged and merged[-1][1] == kind and kind != "ruler":
            merged[-1] = (merged[-1][0] + text, kind)
        else:
            merged.append((text, kind))
    return merged


def _row_finding(code: str, severity: Severity, message: str, row: int) -> Finding:
    if severity == "error":
        return Finding(code, "error", "row", message, row, blocks_transform=True, blocks_publish=True)
    return Finding(code, severity, "row", message, row, blocks_publish=True, requires_ack=True)


def _check_item_type(value: str, policy: AffiliatePolicy) -> str:
    if value not in policy.approved_item_types:
        raise ValueError(f"unsupported ITEM_TYPE {value!r}; expected one of {policy.approved_item_types}")
    return value


def process(
    canonical: AffiliateCanonical,
    options: AffiliateOptions | None = None,
    policy: AffiliatePolicy | None = None,
) -> AffiliateResult:
    options = options or AffiliateOptions()
    policy = policy or AffiliatePolicy()
    dataset_item_type = _check_item_type(options.item_type or policy.default_item_type, policy)
    for value in options.row_item_types.values():
        _check_item_type(value, policy)

    records: list[AffiliateRecord] = []
    findings: list[Finding] = []
    trace: list[CellTrace] = []
    seen: dict[str, tuple[int, bool]] = {}

    for row, source in enumerate(canonical.to_rules_input(), start=1):
        name = (source.affiliate_name or "").strip()
        override = options.id_overrides.get(row)
        supplied = (source.affiliate_id or "").strip()
        chars_changed = was_truncated = False
        method: IdMethod
        if override is not None:
            resolved, method = override.strip(), "override"
        elif supplied:
            resolved, method = supplied, "direct"
        else:
            resolved, chars_changed, was_truncated = derive_item_id(name, policy.item_id_limit)
            method = "derived"
        derived = method == "derived"
        item_type = options.row_item_types.get(row, dataset_item_type)
        excluded = row in options.excluded_rows

        if excluded:
            findings.append(
                Finding(
                    "AFF_INFO_ROW_EXCLUDED",
                    "info",
                    "row",
                    f"row excluded from import (DONOTIMPORT='#'): {options.excluded_rows[row]}",
                    row,
                )
            )
        else:
            if not resolved:
                findings.append(
                    _row_finding(
                        "AFF_ERR_ITEM_ID_BLANK",
                        "error",
                        "ITEM_ID is blank and cannot be derived from Affiliate Name",
                        row,
                    )
                )
            elif not derived and len(resolved) > policy.item_id_limit:
                findings.append(
                    _row_finding(
                        "AFF_ERR_ITEM_ID_TOO_LONG",
                        "error",
                        f"supplied ITEM_ID exceeds {policy.item_id_limit} characters",
                        row,
                    )
                )
            if resolved and not name:
                findings.append(_row_finding("AFF_ERR_NAME_BLANK", "error", "NAME is blank", row))

            prior = seen.get(resolved) if resolved else None
            truncation_collision = prior is not None and (was_truncated or prior[1])
            if derived and resolved and not truncation_collision:
                findings.append(
                    _row_finding(
                        "AFF_WARN_ITEM_ID_DERIVED",
                        "warning",
                        "ITEM_ID was derived from Affiliate Name",
                        row,
                    )
                )
                if chars_changed:
                    findings.append(
                        _row_finding(
                            "AFF_WARN_ITEM_ID_CHARS_STRIPPED",
                            "warning",
                            "non-alphanumeric characters were normalized in derived ITEM_ID",
                            row,
                        )
                    )
            if prior is not None:
                findings.append(
                    _row_finding(
                        "AFF_ERR_ITEM_ID_TRUNCATION_COLLISION" if truncation_collision else "AFF_ERR_ITEM_ID_DUPLICATE",
                        "error",
                        f"ITEM_ID duplicates row {prior[0]}",
                        row,
                    )
                )
            elif resolved:
                seen[resolved] = (row, derived and was_truncated)

            if len(name) > policy.name_limit:
                findings.append(
                    _row_finding(
                        "AFF_WARN_NAME_TRUNCATED",
                        "warning",
                        f"Affiliate Name was truncated to {policy.name_limit} characters",
                        row,
                    )
                )
            if row in options.row_item_types and item_type != policy.default_item_type:
                findings.append(
                    _row_finding(
                        "AFF_WARN_ITEM_TYPE_OVERRIDE",
                        "warning",
                        f"ITEM_TYPE overridden to {item_type!r} for this row",
                        row,
                    )
                )

        records.append(
            AffiliateRecord(
                row=row,
                item_id=resolved,
                name=name[: policy.name_limit],
                item_type=item_type,
                id_method=method,
                source_sheet=source.source_sheet,
                source_row=source.source_row,
                do_not_import="#" if excluded else "",
            )
        )
        sheet, source_row = source.source_sheet, source.source_row
        id_rule, id_operation = _ID_RULE[method]
        item_type_overridden = row in options.row_item_types or options.item_type is not None
        trace.extend(
            (
                CellTrace(
                    row,
                    "ITEM_ID",
                    id_rule,
                    id_operation,
                    sheet,
                    source_row,
                    "affiliate_name" if derived else "affiliate_id",
                ),
                CellTrace(
                    row,
                    "NAME",
                    "affiliate.name.copy_and_limit",
                    "truncate",
                    sheet,
                    source_row,
                    "affiliate_name",
                ),
                CellTrace(
                    row,
                    "ITEM_TYPE",
                    "affiliate.item_type.override" if item_type_overridden else "affiliate.item_type.default",
                    "override" if item_type_overridden else "constant",
                ),
                CellTrace(row, "DESCRIPTION", "affiliate.template.blank", "constant"),
                CellTrace(
                    row,
                    "DONOTIMPORT",
                    "affiliate.row.excluded" if excluded else "affiliate.template.blank",
                    "override" if excluded else "constant",
                ),
            )
        )

    if not records:
        findings.append(
            Finding(
                "AFF_WARN_ZERO_RECORDS",
                "warning",
                "dataset",
                "Affiliate source contains no data rows",
                blocks_publish=True,
                requires_ack=True,
            )
        )
    if dataset_item_type != policy.default_item_type:
        findings.append(
            Finding(
                "AFF_WARN_ITEM_TYPE_OVERRIDE",
                "warning",
                "dataset",
                f"ITEM_TYPE overridden to {dataset_item_type!r}",
                blocks_publish=True,
                requires_ack=True,
            )
        )

    blocked = any(
        f.blocks_publish and (f.severity == "error" or (f.requires_ack and f.key not in options.acknowledged))
        for f in findings
    )
    return AffiliateResult(tuple(records), tuple(findings), not blocked, tuple(trace), policy)

"""Typed changes: the only way an analyst's intent (or an agent's proposal) alters a run.

``validate`` names the rule a change breaks. ``dry_run`` shows what a batch
of changes would do without applying anything.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field, fields, replace
from typing import Any

from .canonical import AffiliateCanonical
from .entities.affiliate import AffiliateOptions, AffiliatePolicy, AffiliateResult, process

_ID_CHARSET = re.compile(r"^[A-Z0-9_]+$")
BINDING_FIELDS = ("affiliate_id", "affiliate_name")


@dataclass(frozen=True, slots=True)
class SetSheet:
    sheet: str
    kind: str = field(default="set_sheet", init=False)


@dataclass(frozen=True, slots=True)
class SetHeaderRow:
    header_row: int
    kind: str = field(default="set_header_row", init=False)


@dataclass(frozen=True, slots=True)
class SetColumnBinding:
    field: str
    column: str | None
    kind: str = dataclasses.field(default="set_column_binding", init=False)


@dataclass(frozen=True, slots=True)
class SetItemType:
    value: str
    rows: tuple[int, ...] | None = None
    kind: str = field(default="set_item_type", init=False)


@dataclass(frozen=True, slots=True)
class OverrideItemId:
    row: int
    value: str
    kind: str = field(default="override_item_id", init=False)


@dataclass(frozen=True, slots=True)
class ExcludeRow:
    row: int
    reason: str
    kind: str = field(default="exclude_row", init=False)


@dataclass(frozen=True, slots=True)
class AcknowledgeFinding:
    code: str
    row: int | None
    kind: str = field(default="acknowledge_finding", init=False)


@dataclass(frozen=True, slots=True)
class RequestRecipeRevision:
    instruction: str
    kind: str = field(default="request_recipe_revision", init=False)


Change = (
    SetSheet
    | SetHeaderRow
    | SetColumnBinding
    | SetItemType
    | OverrideItemId
    | ExcludeRow
    | AcknowledgeFinding
    | RequestRecipeRevision
)
CHANGE_TYPES: dict[str, type[Any]] = {
    "set_sheet": SetSheet,
    "set_header_row": SetHeaderRow,
    "set_column_binding": SetColumnBinding,
    "set_item_type": SetItemType,
    "override_item_id": OverrideItemId,
    "exclude_row": ExcludeRow,
    "acknowledge_finding": AcknowledgeFinding,
    "request_recipe_revision": RequestRecipeRevision,
}
LAYOUT_CHANGES = (SetSheet, SetHeaderRow, SetColumnBinding, RequestRecipeRevision)


def to_dict(change: Change) -> dict[str, Any]:
    payload = asdict(change)
    if isinstance(change, SetItemType) and change.rows is not None:
        payload["rows"] = list(change.rows)
    return payload


def from_dict(payload: dict[str, Any]) -> Change:
    kind = payload.get("kind")
    cls = CHANGE_TYPES.get(str(kind))
    if cls is None:
        raise ValueError(f"unknown change kind {kind!r}; expected one of {sorted(CHANGE_TYPES)}")
    init = {f.name for f in fields(cls) if f.init}
    args = {k: v for k, v in payload.items() if k in init}
    if cls is SetItemType and args.get("rows") is not None:
        args["rows"] = tuple(args["rows"])
    return cls(**args)  # type: ignore[no-any-return]


@dataclass(frozen=True, slots=True)
class PolicyViolation:
    rule: str
    message: str


@dataclass(frozen=True, slots=True)
class ChangeContext:
    canonical: AffiliateCanonical
    options: AffiliateOptions
    sheets: tuple[str, ...] = ()
    columns: tuple[str, ...] = ()
    policy: AffiliatePolicy = field(default_factory=AffiliatePolicy)

    def result(self) -> AffiliateResult:
        return process(self.canonical, self.options, self.policy)


def _row_exists(row: int, ctx: ChangeContext) -> list[PolicyViolation]:
    count = len(ctx.canonical.rows)
    if 1 <= row <= count:
        return []
    return [PolicyViolation("row.exists", f"row {row} does not exist (rows are 1..{count})")]


def validate(change: Change, ctx: ChangeContext) -> list[PolicyViolation]:
    policy = ctx.policy
    v: list[PolicyViolation] = []
    if isinstance(change, OverrideItemId):
        v += _row_exists(change.row, ctx)
        value = change.value.strip()
        if not value:
            v.append(PolicyViolation("item_id.required", "ITEM_ID cannot be blank"))
            return v
        if len(value) > policy.item_id_limit:
            v.append(
                PolicyViolation(
                    "item_id.max_length",
                    f"ITEM_ID is {len(value)} characters; the limit is {policy.item_id_limit}",
                )
            )
        if not _ID_CHARSET.match(value):
            v.append(PolicyViolation("item_id.charset", "ITEM_ID may contain only A-Z, 0-9 and _"))
        if not v:
            result = ctx.result()
            taken = {r.item_id: r.row for r in result.records if r.row != change.row and not r.do_not_import}
            if value in taken:
                v.append(PolicyViolation("item_id.unique", f"ITEM_ID {value} is already used by row {taken[value]}"))
    elif isinstance(change, SetItemType):
        if change.value not in policy.approved_item_types:
            v.append(
                PolicyViolation(
                    "item_type.approved",
                    f"ITEM_TYPE {change.value!r} is not one of {policy.approved_item_types}",
                )
            )
        for row in change.rows or ():
            v += _row_exists(row, ctx)
    elif isinstance(change, ExcludeRow):
        v += _row_exists(change.row, ctx)
        if not change.reason.strip():
            v.append(PolicyViolation("exclude.reason_required", "say why the row is excluded"))
    elif isinstance(change, AcknowledgeFinding):
        matches = [f for f in ctx.result().findings if f.key == (change.code, change.row)]
        if not matches:
            v.append(PolicyViolation("ack.finding_exists", f"no open finding {change.code} on row {change.row}"))
        elif matches[0].severity == "error":
            v.append(
                PolicyViolation(
                    "ack.error_not_allowed",
                    f"{change.code} is an error; fix it, errors cannot be acknowledged",
                )
            )
        elif not matches[0].requires_ack:
            v.append(PolicyViolation("ack.not_required", f"{change.code} needs no acknowledgement"))
    elif isinstance(change, SetSheet):
        if ctx.sheets and change.sheet not in ctx.sheets:
            v.append(PolicyViolation("sheet.exists", f"no sheet {change.sheet!r} in the upload"))
    elif isinstance(change, SetHeaderRow):
        if change.header_row < 1:
            v.append(PolicyViolation("header_row.positive", "the header row is 1 or more"))
    elif isinstance(change, SetColumnBinding):
        if change.field not in BINDING_FIELDS:
            v.append(PolicyViolation("binding.field_known", f"unknown field {change.field!r}"))
        elif change.column is None and change.field == "affiliate_name":
            v.append(PolicyViolation("binding.name_required", "Affiliate Name must be bound"))
        elif change.column is not None and ctx.columns and change.column not in ctx.columns:
            v.append(PolicyViolation("binding.column_exists", f"no column {change.column!r} in the upload"))
    elif isinstance(change, RequestRecipeRevision):
        if not change.instruction.strip():
            v.append(PolicyViolation("instruction.required", "the revision needs an instruction"))
    return v


def apply(change: Change, options: AffiliateOptions) -> AffiliateOptions:
    """Fold an option-level change into the options. Layout changes return them unchanged."""
    if isinstance(change, OverrideItemId):
        return replace(options, id_overrides={**options.id_overrides, change.row: change.value.strip()})
    if isinstance(change, SetItemType):
        if change.rows is None:
            return replace(options, item_type=change.value)
        row_types = {**options.row_item_types, **dict.fromkeys(change.rows, change.value)}
        return replace(options, row_item_types=row_types)
    if isinstance(change, ExcludeRow):
        return replace(options, excluded_rows={**options.excluded_rows, change.row: change.reason})
    if isinstance(change, AcknowledgeFinding):
        return replace(options, acknowledged=options.acknowledged | {(change.code, change.row)})
    return options


@dataclass(frozen=True, slots=True)
class ChangeImpact:
    violations: list[PolicyViolation]
    options: AffiliateOptions | None
    requires_rebuild: bool = False
    rows_changed: list[int] = field(default_factory=list)
    findings_added: list[tuple[str, int | None]] = field(default_factory=list)
    findings_removed: list[tuple[str, int | None]] = field(default_factory=list)
    preview: list[dict[str, Any]] = field(default_factory=list)
    publishable_before: bool = False
    publishable_after: bool = False


def dry_run(
    changes: Sequence[Change],
    canonical: AffiliateCanonical,
    options: AffiliateOptions,
    *,
    sheets: tuple[str, ...] = (),
    columns: tuple[str, ...] = (),
    policy: AffiliatePolicy | None = None,
) -> ChangeImpact:
    policy = policy or AffiliatePolicy()
    before = process(canonical, options, policy)
    current = options
    violations: list[PolicyViolation] = []
    requires_rebuild = False
    for change in changes:
        ctx = ChangeContext(canonical, current, sheets, columns, policy)
        found = validate(change, ctx)
        if found:
            violations.extend(found)
            continue
        requires_rebuild = requires_rebuild or isinstance(change, LAYOUT_CHANGES)
        current = apply(change, current)
    if violations:
        return ChangeImpact(violations, None, publishable_before=before.publishable)

    after = process(canonical, current, policy)
    before_keys = {f.key for f in before.findings}
    after_keys = {f.key for f in after.findings}
    preview: list[dict[str, Any]] = []
    for old, new in zip(before.records, after.records, strict=True):
        old_row, new_row = old.as_template_row(), new.as_template_row()
        diff = [c for c in old_row if old_row[c] != new_row[c]]
        if diff:
            preview.append(
                {
                    "row": old.row,
                    "before": {c: old_row[c] for c in diff},
                    "after": {c: new_row[c] for c in diff},
                }
            )

    def _order(key: tuple[str, int | None]) -> tuple[int, str]:
        return (key[1] or 0, key[0])

    return ChangeImpact(
        violations=[],
        options=current,
        requires_rebuild=requires_rebuild,
        rows_changed=[p["row"] for p in preview],
        findings_added=sorted(after_keys - before_keys, key=_order),
        findings_removed=sorted(before_keys - after_keys, key=_order),
        preview=preview,
        publishable_before=before.publishable,
        publishable_after=after.publishable,
    )

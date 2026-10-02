"""The canonical Affiliate table a recipe produces and the rules consume."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any

from .read import Table


@dataclass(frozen=True, slots=True)
class AffiliateRow:
    affiliate_id: str | None
    affiliate_name: str | None
    source_sheet: str
    source_row: int


@dataclass(frozen=True, slots=True)
class Dropped:
    sheet: str
    row: int
    reason: str


@dataclass(frozen=True, slots=True)
class AffiliateCanonical:
    rows: tuple[AffiliateRow, ...]
    dropped: tuple[Dropped, ...] = field(default=())

    def to_rules_input(self) -> list[AffiliateRow]:
        return list(self.rows)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rows": [asdict(r) for r in self.rows],
            "dropped": [asdict(d) for d in self.dropped],
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> AffiliateCanonical:
        return cls(
            tuple(AffiliateRow(**r) for r in payload.get("rows", [])),
            tuple(Dropped(**d) for d in payload.get("dropped", [])),
        )

    def content_hash(self) -> str:
        blob = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(blob).hexdigest()


def from_table(table: Table, *, id_column: str | None, name_column: str) -> AffiliateCanonical:
    """Every table row becomes one canonical row; blanks stay blank for the rules to judge."""
    missing = [c for c in (id_column, name_column) if c is not None and c not in table.columns]
    if missing:
        raise ValueError(f"bound columns not found in sheet {table.sheet!r}: {missing}")
    rows = tuple(
        AffiliateRow(
            affiliate_id=record.get(id_column),
            affiliate_name=record.get(name_column),
            source_sheet=table.sheet,
            source_row=record.row_number,
        )
        for record in table.rows()
    )
    dropped = tuple(Dropped(table.sheet, row, reason) for row, reason in table.dropped)
    return AffiliateCanonical(rows, dropped)

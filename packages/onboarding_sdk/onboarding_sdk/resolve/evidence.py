"""Value evidence for column decisions: what a column's values look like, not what it is called."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any, Literal

from ..profile import WorkbookProfile

Hint = Literal["id_like", "name_like", "code_like", "free_text", "empty"]

_LEGAL_SUFFIX = re.compile(
    r"\b(LLC|L\.?L\.?C\.?|L\.?P\.?|LP|LLP|Ltd\.?|Limited|Inc\.?|Corp\.?|GmbH|S\.?a\.? ?r\.?l\.?|"
    r"S\.?A\.?|B\.?V\.?|N\.?V\.?|PLC|Partners|Holdings?|Fund|GP|Trust|Company|Co\.)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class ColumnEvidence:
    column: str
    samples: list[str]
    pattern: str | None
    uniqueness: float
    fill_rate: float
    hint: Hint

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _hint(samples: list[str], uniqueness: float) -> Hint:
    if not samples:
        return "empty"
    legal = sum(bool(_LEGAL_SUFFIX.search(s)) for s in samples) / len(samples)
    spaced = sum(" " in s for s in samples) / len(samples)
    digits = sum(any(ch.isdigit() for ch in s) for s in samples) / len(samples)
    short = all(len(s) <= 24 for s in samples)
    if legal >= 0.5 or (spaced >= 0.8 and digits < 0.5 and uniqueness >= 0.9):
        return "name_like"
    if spaced == 0 and short and digits >= 0.8:
        return "id_like" if uniqueness >= 0.9 else "code_like"
    if spaced == 0 and short:
        return "code_like"
    return "free_text"


def evidence_for(prof: WorkbookProfile, sheet: str, candidates: Sequence[str]) -> list[ColumnEvidence]:
    columns = {c.name: c for c in prof.sheet(sheet).columns}
    out: list[ColumnEvidence] = []
    for name in candidates:
        column = columns.get(name)
        if column is None:
            continue
        filled = round(column.fill_rate * prof.sheet(sheet).row_count)
        uniqueness = round(column.distinct / filled, 4) if filled else 0.0
        out.append(
            ColumnEvidence(
                column=name,
                samples=column.samples,
                pattern=column.pattern,
                uniqueness=uniqueness,
                fill_rate=column.fill_rate,
                hint=_hint(column.samples, uniqueness),
            )
        )
    return out

"""Regression cases: analyst corrections captured as replayable eval fixtures.

``derive_case`` reads a run's decision log and final snapshot and returns a
versioned case dict, or None when there is nothing to replay. Steps copy the
decision payloads verbatim — typed changes, question answers and instruction
text only, never cell values — so a case is safe to promote into the repo.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .persistence.interfaces import DecisionRecord

CASE_VERSION = 1

# Decisions that mean the analyst corrected the run: answers, instructions,
# changes and sign-off rejections. Approvals and spine observations capture nothing.
TRIGGER_KINDS = frozenset(
    {
        "brief.answer",
        "brief.instruct",
        "brief.change",
        "findings.change",
        "findings.instruct",
        "signoff.reject",
    }
)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CaseUpload(_Model):
    sha256: str


class CaseOutcome(_Model):
    status: str
    bindings: dict[str, str | None] = Field(default_factory=dict)
    csv_sha256: str
    finding_codes: list[str] = Field(default_factory=list)


class CaseStep(_Model):
    seq: int
    kind: str
    payload: dict[str, Any]
    actor: str
    at: str


class RegressionCase(_Model):
    version: int
    run_id: str
    sponsor_id: str
    entity: str
    fingerprint: str
    fixture: str
    upload: CaseUpload
    outcome: CaseOutcome
    steps: list[CaseStep] = Field(default_factory=list)


def case_key(sponsor_id: str, run_id: str) -> str:
    """Object-store key of a run's regression case."""
    return f"regression/{sponsor_id}/{run_id}.json"


def derive_case(
    *,
    run_id: str,
    sponsor_id: str,
    entity: str,
    fingerprint: str,
    fixture: str,
    upload_sha256: str,
    decisions: Sequence[DecisionRecord],
    status: str,
    bindings: Mapping[str, str | None],
    csv_sha256: str | None,
    finding_codes: Iterable[str],
) -> dict[str, Any] | None:
    """Build a regression case from the decision log and the final snapshot.

    Returns None when there is no replayable outcome — the run did not lock or
    its output sha is unknown — or when the log holds no correcting decision.
    """
    if status != "locked" or not csv_sha256:
        return None
    steps = [
        CaseStep(seq=d.seq, kind=d.kind, payload=d.payload, actor=d.actor, at=d.at)
        for d in decisions
        if d.kind in TRIGGER_KINDS
    ]
    if not steps:
        return None
    case = RegressionCase(
        version=CASE_VERSION,
        run_id=run_id,
        sponsor_id=sponsor_id,
        entity=entity,
        fingerprint=fingerprint,
        fixture=fixture,
        upload=CaseUpload(sha256=upload_sha256),
        outcome=CaseOutcome(
            status=status,
            bindings=dict(bindings),
            csv_sha256=csv_sha256,
            finding_codes=sorted(set(finding_codes)),
        ),
        steps=steps,
    )
    return case.model_dump()

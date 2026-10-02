"""Column binding resolution: ``attribute_mapper`` behind a small, sponsor-scoped interface.

History is strictly per sponsor: every call passes ``tenant_id=sponsor_id``
and the wildcard tenant is refused. ``confirm`` is the only path that writes
mapping history, and it runs only after an analyst's decision.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from attribute_mapper import HistoryStore, MapRun, Matcher

FIELDS = ("affiliate_id", "affiliate_name")
ENTITY = "affiliate"
SOURCE_SYSTEM = "investran"
TARGET_SYSTEM = "intacct"
Decision = Literal["matched", "needs_review", "unmapped"]


def _require_sponsor(sponsor_id: str) -> str:
    sponsor = (sponsor_id or "").strip()
    if not sponsor or sponsor == "*":
        raise ValueError("a sponsor id is required; the wildcard sponsor '*' is not allowed")
    return sponsor


@dataclass(frozen=True, slots=True)
class CandidateView:
    column: str
    score: float
    route: str


@dataclass(frozen=True, slots=True)
class FieldResolution:
    field: str
    column: str | None
    route: str | None
    score: float | None
    decision: Decision
    candidates: tuple[CandidateView, ...] = ()


@dataclass(frozen=True, slots=True)
class ResolutionSet:
    sponsor_id: str
    thread_id: str
    headers: tuple[str, ...]
    fields: dict[str, FieldResolution] = field(default_factory=dict)

    def bindings(self) -> dict[str, str | None]:
        return {name: (res.column if res.decision == "matched" else None) for name, res in self.fields.items()}

    def needs_review(self) -> list[str]:
        return [name for name, res in self.fields.items() if res.decision != "matched"]

    def replays(self, confirmed: Mapping[str, str | None]) -> bool:
        """True when every bound column of a confirmed recipe resolves from history.

        A field the recipe records as absent (None) was confirmed by the
        analyst when the recipe was frozen; history cannot record absence.
        """
        bound = {name: column for name, column in confirmed.items() if column is not None}
        return bool(bound) and all(
            (res := self.fields.get(name)) is not None
            and res.route == "history"
            and res.decision == "matched"
            and res.column == column
            for name, column in bound.items()
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> ResolutionSet:
        fields = {
            name: FieldResolution(
                raw["field"],
                raw["column"],
                raw["route"],
                raw["score"],
                raw["decision"],
                tuple(CandidateView(**c) for c in raw.get("candidates", ())),
            )
            for name, raw in payload.get("fields", {}).items()
        }
        return cls(payload["sponsor_id"], payload["thread_id"], tuple(payload["headers"]), fields)


@dataclass(frozen=True, slots=True)
class FieldDecision:
    """The analyst's answer for one field. ``column=None`` means the file has no such column."""

    column: str | None


def _from_run(sponsor_id: str, headers: Sequence[str], run: MapRun) -> ResolutionSet:
    decided: dict[str, FieldResolution] = {}
    for row in run.mappings:
        for binding in row.bindings:
            if binding.concept not in FIELDS or binding.concept in decided:
                continue
            candidates = tuple(
                CandidateView(c.target_attribute, round(float(c.score), 4), c.route) for c in binding.candidates
            )
            decision: Decision = binding.decision
            # The matcher calls a concept with only weak candidates unmapped;
            # for the analyst that is still a question, not an absence.
            if decision == "unmapped" and candidates:
                decision = "needs_review"
            decided[binding.concept] = FieldResolution(
                binding.concept,
                binding.source if binding.decision != "unmapped" else None,
                binding.route,
                binding.score,
                decision,
                candidates,
            )
    for name in FIELDS:
        decided.setdefault(name, FieldResolution(name, None, None, None, "unmapped"))
    return ResolutionSet(sponsor_id, run.thread_id, tuple(headers), decided)


class ColumnBindingResolver:
    def __init__(self, matcher: Matcher) -> None:
        self._matcher = matcher

    @classmethod
    def create(
        cls,
        ontology_path: str | Path,
        *,
        database_url: str | None = None,
        enable_embeddings: bool = False,
        embedding_model: str = "text-embedding-3-small",
        enable_llm: bool = False,
        llm_model: str = "gpt-5.6-terra",
        llm_base_url: str | None = None,
        api_key: str | None = None,
        history: HistoryStore | None = None,
    ) -> ColumnBindingResolver:
        from attribute_mapper import HistoryIndex, Matcher, MatcherConfig, load_ontology

        config = MatcherConfig(
            ontology_paths=(str(ontology_path),),
            database_url=database_url,
            enable_embeddings=enable_embeddings,
            embedding_model=embedding_model,
            embedding_base_url=llm_base_url,
            embedding_api_key=api_key,
            enable_llm=enable_llm,
            llm_model=llm_model,
            llm_base_url=llm_base_url,
            llm_api_key=api_key,
            require_human_review=True,
            history_writeback="human_only",
        )
        if history is None and not database_url:
            ontology = load_ontology(str(ontology_path))
            history = HistoryIndex(
                [],
                config_version=ontology.version,
                valid_targets={c.id for c in ontology.matchable_concepts()},
            )
        return cls(Matcher.from_config(config, history=history))

    @property
    def history(self) -> HistoryStore | None:
        return self._matcher.history

    def resolve(self, sponsor_id: str, headers: Sequence[str], *, run_id: str) -> ResolutionSet:
        sponsor = _require_sponsor(sponsor_id)
        # One thread per (run, header set): re-resolving after a layout change
        # must not resume the previous, still-paused review.
        digest = hashlib.sha256("\x1f".join(headers).encode()).hexdigest()[:8]
        run = self._matcher.map_entity(
            ENTITY,
            list(headers),
            tenant_id=sponsor,
            source_system=SOURCE_SYSTEM,
            target_system=TARGET_SYSTEM,
            thread_id=f"{run_id}:bind:{digest}",
        )
        return _from_run(sponsor, headers, run)

    def confirm(
        self,
        sponsor_id: str,
        resolution: ResolutionSet,
        decisions: Mapping[str, FieldDecision],
        *,
        reviewer: str,
    ) -> ResolutionSet:
        """Write the analyst's decisions to this sponsor's history. The only history write path."""
        sponsor = _require_sponsor(sponsor_id)
        if sponsor != resolution.sponsor_id:
            raise ValueError("confirm must use the sponsor the resolution was made for")
        payload_decisions: list[dict[str, Any]] = []
        for name in FIELDS:
            if name not in decisions:
                continue
            column = decisions[name].column
            current = resolution.fields[name]
            if column is None:
                payload_decisions.append({"concept": name, "action": "reject", "source": None})
                continue
            if column not in resolution.headers:
                raise ValueError(f"{column!r} is not an uploaded column")
            action = "approve" if column == current.column else "remap"
            payload_decisions.append({"concept": name, "action": action, "source": column})
        run = self._matcher.resume(resolution.thread_id, {"reviewer": reviewer, "decisions": payload_decisions})
        result = _from_run(sponsor, resolution.headers, run)
        # A rejected field is a confirmed absence, not an open question.
        fields = {
            name: (
                FieldResolution(name, None, "human_rejected", None, "matched")
                if name in decisions and decisions[name].column is None
                else res
            )
            for name, res in result.fields.items()
        }
        return ResolutionSet(sponsor, resolution.thread_id, resolution.headers, fields)

    def close(self) -> None:
        self._matcher.close()

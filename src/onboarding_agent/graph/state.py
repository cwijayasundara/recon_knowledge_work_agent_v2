"""Structured models exchanged between the spine, the agents and the analyst.

These are the pydantic boundary types. The spine's own state is a plain
JSON-safe dict so any checkpointer can store it.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypedDict

from onboarding_sdk import changes as sdk_changes
from pydantic import BaseModel, ConfigDict, Field

Route = Literal["history", "ontology_exact", "fuzzy", "embedding", "llm", "human_approved", "agent", "analyst"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceInfo(_Model):
    file: str
    sheet: str
    header_row: int = Field(ge=1)
    rows_read: int = 0
    rows_emitted: int = 0
    rows_dropped: int = 0
    drop_reasons: list[str] = Field(default_factory=list)


class BindingView(_Model):
    field: Literal["affiliate_id", "affiliate_name"]
    column: str | None
    route: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    evidence: str = ""


class Question(_Model):
    id: str
    text: str
    options: list[str] = Field(min_length=1)
    evidence: str = ""
    # What an answer changes: a sheet, the header row, or a field binding.
    target: Literal["sheet", "header_row", "affiliate_id", "affiliate_name", "item_type", "other"] = "other"


class RecipeRef(_Model):
    kind: Literal["standard", "authored", "recalled"]
    id: str | None = None


class OnboardingBrief(_Model):
    source: SourceInfo
    bindings: list[BindingView]
    id_strategy: Literal["source_id", "derive_from_name", "mixed"]
    item_type: Literal["Inventory", "Non-Inventory"] = "Inventory"
    recipe: RecipeRef
    expected_findings: list[str] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list, max_length=2)
    confidence: float = Field(ge=0, le=1)
    summary: str = ""

    def binding_map(self) -> dict[str, str | None]:
        return {b.field: b.column for b in self.bindings}


# Typed changes mirror onboarding_sdk.changes; the SDK validates and applies them.
class SetSheet(_Model):
    kind: Literal["set_sheet"] = "set_sheet"
    sheet: str


class SetHeaderRow(_Model):
    kind: Literal["set_header_row"] = "set_header_row"
    header_row: int


class SetColumnBinding(_Model):
    kind: Literal["set_column_binding"] = "set_column_binding"
    field: str
    column: str | None


class SetItemType(_Model):
    kind: Literal["set_item_type"] = "set_item_type"
    value: str
    rows: list[int] | None = None


class OverrideItemId(_Model):
    kind: Literal["override_item_id"] = "override_item_id"
    row: int
    value: str


class ExcludeRow(_Model):
    kind: Literal["exclude_row"] = "exclude_row"
    row: int
    reason: str


class AcknowledgeFinding(_Model):
    kind: Literal["acknowledge_finding"] = "acknowledge_finding"
    code: str
    row: int | None


class RequestRecipeRevision(_Model):
    kind: Literal["request_recipe_revision"] = "request_recipe_revision"
    instruction: str


TypedChange = Annotated[
    SetSheet
    | SetHeaderRow
    | SetColumnBinding
    | SetItemType
    | OverrideItemId
    | ExcludeRow
    | AcknowledgeFinding
    | RequestRecipeRevision,
    Field(discriminator="kind"),
]


def to_sdk(change: BaseModel) -> sdk_changes.Change:
    return sdk_changes.from_dict(change.model_dump())


class RunReport(_Model):
    summary: str
    findings_by_code: dict[str, int] = Field(default_factory=dict)
    explanations: dict[str, str] = Field(default_factory=dict)
    proposed_changes: list[TypedChange] = Field(default_factory=list)
    blocking_count: int = 0
    ack_required: int = 0


class ChangeProposal(_Model):
    """The supervisor's reading of an analyst instruction (instruct mode)."""

    restated: str
    changes: list[TypedChange] = Field(default_factory=list)
    applicable: bool = True


class GateResponse(_Model):
    action: Literal["approve", "answer", "change", "instruct", "reject"]
    actor: str = Field(min_length=1)
    question_id: str | None = None
    option: str | None = None
    changes: list[TypedChange] = Field(default_factory=list)
    text: str | None = None
    reason: str | None = None


class RecipeResult(_Model):
    """What the recipe engineer returns."""

    path: str
    summary: str
    coverage: dict[str, Any] = Field(default_factory=dict)
    open_questions: list[str] = Field(default_factory=list)


class SpineState(TypedDict, total=False):
    run_id: str
    sponsor_id: str
    entity: str
    actor: str
    upload: dict[str, Any]
    fingerprint: str
    phase: str
    status: str
    recall: dict[str, Any] | None
    resolution: dict[str, Any] | None
    # What the spine resolved in code: sheet, header row and per-field
    # column/route/score/decision. None when nothing was resolved in code.
    resolution_summary: dict[str, Any] | None
    # The resolve node drafted the brief in code and routed straight to the
    # brief gate; no agent is part of the run unless a gate hands it to one.
    fastpath: bool
    brief: dict[str, Any] | None
    analyst_inputs: list[dict[str, Any]]
    bindings: dict[str, str | None] | None
    binding_routes: dict[str, str | None]
    layout: dict[str, Any] | None
    recipe: dict[str, Any] | None
    approved: dict[str, Any] | None
    options: dict[str, Any]
    result: dict[str, Any] | None
    report: dict[str, Any] | None
    proposal: dict[str, Any] | None
    gate_message: str | None
    artifacts: list[dict[str, Any]]
    approvers: list[dict[str, Any]]
    model_calls: int
    replay: bool
    error: str | None
    next: str

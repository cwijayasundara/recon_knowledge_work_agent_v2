"""Gate predicates. Code decides whether a gate may pass; no agent can."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from onboarding_sdk.entities.affiliate import AffiliateOptions, AffiliateResult

from ..graph.state import OnboardingBrief


def brief_blockers(
    brief: OnboardingBrief | None,
    recipe: dict[str, Any] | None,
    bindings: dict[str, str | None] | None = None,
    layout: dict[str, Any] | None = None,
) -> list[str]:
    """What stops the analyst approving: the brief must describe exactly the recipe that will run."""
    if brief is None:
        return ["there is no brief yet"]
    reasons = []
    if brief.questions:
        reasons.append(f"{len(brief.questions)} open question(s) must be answered first")
    if not brief.binding_map().get("affiliate_name"):
        reasons.append("Affiliate Name is not bound")
    if recipe is None:
        reasons.append("no checked recipe")
        return reasons
    source = {"sheet": brief.source.sheet, "header_row": brief.source.header_row}
    if bindings != brief.binding_map() or recipe.get("bindings") != brief.binding_map():
        reasons.append("the brief's columns differ from the columns the recipe reads")
    if layout != source or recipe.get("layout") != source:
        reasons.append("the brief's sheet or header row differs from the recipe's")
    path = Path(str(recipe.get("path", "")))
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != recipe.get("sha256"):
        reasons.append("the recipe file changed after it was checked")
    return reasons


def findings_blockers(result: AffiliateResult | None, options: AffiliateOptions) -> list[str]:
    if result is None:
        return ["the pipeline has not produced a result"]
    reasons = [f"{f.code} on row {f.row} is an error and must be fixed" for f in result.open_errors()]
    reasons += [
        f"{f.code}{'' if f.row is None else f' on row {f.row}'} needs acknowledgement"
        for f in result.unacknowledged(options.acknowledged)
    ]
    return reasons


def can_pass_findings(result: AffiliateResult | None, options: AffiliateOptions) -> bool:
    return not findings_blockers(result, options) and result is not None and result.publishable

"""Everything one run's tools and nodes share: the upload, the stores, and what agents submitted.

Tools write their structured outputs here; spine nodes copy them into graph
state. Nothing in this object is trusted to pass a gate.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from onboarding_sdk import profile, read
from onboarding_sdk.canonical import AffiliateCanonical
from onboarding_sdk.entities.affiliate import AffiliateOptions, AffiliateResult
from onboarding_sdk.resolve import ColumnBindingResolver, ResolutionSet

from .graph.state import ChangeProposal, OnboardingBrief, RunReport
from .persistence.interfaces import Stores
from .sandbox.base import RunSandbox, SandboxMounts

Emit = Callable[[str, dict[str, Any]], None]
SandboxFactory = Callable[[str, SandboxMounts], RunSandbox]


def _no_emit(kind: str, payload: dict[str, Any]) -> None:
    del kind, payload


@dataclass
class RunContext:
    run_id: str
    sponsor_id: str
    entity: str
    actor: str
    upload_path: Path
    run_dir: Path
    workspace: Path
    resolver: ColumnBindingResolver
    stores: Stores
    sandbox_factory: SandboxFactory | None = None
    emit: Emit = _no_emit

    resolution: ResolutionSet | None = None
    layout: dict[str, Any] | None = None
    bindings: dict[str, str | None] | None = None
    binding_routes: dict[str, str | None] = field(default_factory=dict)
    candidate_recipe: dict[str, Any] | None = None
    brief: OnboardingBrief | None = None
    report: RunReport | None = None
    proposal: ChangeProposal | None = None
    last_dry_run: dict[str, Any] | None = None
    options: AffiliateOptions = field(default_factory=AffiliateOptions)
    canonical: AffiliateCanonical | None = None
    result: AffiliateResult | None = None
    model_calls: int = 0
    # Recipe hash and options the current result was built from; the spine
    # rebuilds whenever this differs from the approved snapshot.
    result_key: str | None = None

    _profile: profile.WorkbookProfile | None = None
    _sandbox: RunSandbox | None = None

    @property
    def mounts(self) -> SandboxMounts:
        return SandboxMounts(
            input_dir=self.upload_path.parent,
            ref_dir=self.run_dir / "ref",
            skills_dir=self.workspace / "skills",
        )

    def workbook(self) -> read.Workbook:
        return read.open(self.upload_path)

    def profile(self) -> profile.WorkbookProfile:
        if self._profile is None:
            self._profile = profile.workbook(self.workbook())
        return self._profile

    def fingerprint(self) -> str:
        return profile.fingerprint(self.profile())

    def sandbox(self) -> RunSandbox:
        if self._sandbox is None:
            if self.sandbox_factory is None:
                raise RuntimeError("no sandbox is configured for this run")
            self.mounts.ref_dir.mkdir(parents=True, exist_ok=True)
            box = self.sandbox_factory(self.run_id, self.mounts)
            box.start()
            self._sandbox = box
        return self._sandbox

    def close(self) -> None:
        if self._sandbox is not None:
            self._sandbox.close()
            self._sandbox = None

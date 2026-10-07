"""Offline services: in-memory stores, in-memory history, scripted models, local sandbox."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from onboarding_sdk.resolve import ColumnBindingResolver

from onboarding_agent.assembly import Services, build_services, run_context
from onboarding_agent.config import Settings
from onboarding_agent.persistence.memory import memory_stores
from onboarding_agent.run_context import RunContext
from tests.conftest import FIXTURE_DIR, REPO_ROOT
from tests.support.local_sandbox import local_sandbox_factory
from tests.support.scripted_model import ScriptedChatModel


class Models:
    """Per-role scripted models; a test sets the scripts before running."""

    def __init__(self) -> None:
        self.supervisor = ScriptedChatModel()
        self.recipe_engineer = ScriptedChatModel()
        self.copilot = ScriptedChatModel()

    def __call__(self, role: str) -> ScriptedChatModel:
        if role == "copilot":
            return self.copilot
        return self.supervisor if role == "supervisor" else self.recipe_engineer

    @property
    def calls(self) -> int:
        return self.supervisor.calls + self.recipe_engineer.calls + self.copilot.calls


def offline_services(tmp_path: Path, models: Models, **overrides: Any) -> Services:
    """Offline Services with the fast-path settings pinned so ONB_* env vars
    cannot change what a test sees; pass keyword overrides to flip them."""
    pinned: dict[str, Any] = {
        "object_root": str(tmp_path / "objects"),
        "sandbox_backend": "docker",
        "fastpath": True,
        "fastpath_min_list": 0.5,
        "fastpath_min_score": 0.95,
        **overrides,
    }
    settings = Settings(_env_file=None, **pinned)  # type: ignore[call-arg]
    return build_services(
        settings,
        stores=memory_stores(tmp_path / "objects"),
        resolver=ColumnBindingResolver.create(REPO_ROOT / "workspace/ontology/affiliate.v1.json"),
        model_factory=models,  # type: ignore[arg-type]
        sandbox_factory=local_sandbox_factory,
    )


def context_for(services: Services, fixture: str, run_id: str = "run-1", sponsor: str = "sponsor-a") -> RunContext:
    target = services.stores.objects.local_path(f"runs/{run_id}/in/{fixture}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(FIXTURE_DIR / fixture, target)
    return run_context(
        services,
        run_id=run_id,
        sponsor_id=sponsor,
        entity="affiliate",
        actor="analyst@sponsor-a",
        upload_path=target,
    )

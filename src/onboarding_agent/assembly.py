"""One assembly for every surface: services, per-run context, middleware and agents.

The CLI, the API and the tests all build through here. Tests swap the model
factory (scripted model), the stores (in memory) and the sandbox factory.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from langchain.agents.middleware import ModelCallLimitMiddleware, ModelRetryMiddleware
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.language_models import BaseChatModel
from onboarding_sdk.resolve import ColumnBindingResolver

from .agents import recipe_engineer as recipe_engineer_mod
from .agents import supervisor as supervisor_mod
from .config import Settings
from .middleware.offload import OffloadMiddleware
from .middleware.redaction import RedactionMiddleware
from .models import Role, chat_model
from .observability import TracingCallback
from .persistence.interfaces import Stores
from .persistence.memory import LocalObjectStore, memory_stores
from .run_context import Emit, RunContext, SandboxFactory
from .sandbox.base import RunSandbox, SandboxMounts

REPO_ROOT = Path(__file__).resolve().parents[2]
ModelFactory = Callable[[Role], BaseChatModel]
RECIPE_ENGINEER_CALL_LIMIT = 30


def _retryable() -> tuple[type[Exception], ...]:
    import openai

    return (
        openai.APIConnectionError,
        openai.APITimeoutError,
        openai.RateLimitError,
        openai.InternalServerError,
    )


class ModelCallCounter(BaseCallbackHandler):
    """Counts chat model calls into the run context, subagents included."""

    def __init__(self, ctx: RunContext) -> None:
        self.ctx = ctx

    def on_chat_model_start(self, serialized: dict[str, Any], messages: Any, **kwargs: Any) -> None:
        self.ctx.model_calls += 1


def docker_sandbox_factory(settings: Settings) -> SandboxFactory:
    def factory(run_id: str, mounts: SandboxMounts) -> RunSandbox:
        from .sandbox.docker_backend import DockerSandbox

        return DockerSandbox(run_id, mounts, image=settings.sandbox_image)

    return factory


def aca_sandbox_factory(settings: Settings) -> SandboxFactory:
    def factory(run_id: str, mounts: SandboxMounts) -> RunSandbox:
        from .sandbox.aca_backend import AcaSessionSandbox

        assert settings.aca_pool_endpoint is not None
        return AcaSessionSandbox(run_id, mounts, endpoint=settings.aca_pool_endpoint)

    return factory


@dataclass
class Services:
    settings: Settings
    stores: Stores
    resolver: ColumnBindingResolver
    workspace: Path
    model_factory: ModelFactory
    sandbox_factory: SandboxFactory | None
    closers: list[Callable[[], None]] = field(default_factory=list)

    def secrets(self) -> list[str]:
        names = ("OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "ONB_API_TOKEN", "ONB_DATABASE_URL")
        return [os.environ[n] for n in names if os.environ.get(n)]

    def close(self) -> None:
        for close in reversed(self.closers):
            close()


def build_services(
    settings: Settings,
    *,
    stores: Stores | None = None,
    resolver: ColumnBindingResolver | None = None,
    model_factory: ModelFactory | None = None,
    sandbox_factory: SandboxFactory | None = None,
    workspace: Path | None = None,
) -> Services:
    workspace = (workspace or REPO_ROOT / settings.workspace_root).resolve()
    closers: list[Callable[[], None]] = []
    if stores is None:
        objects = LocalObjectStore(Path(settings.object_root))
        if settings.database_url:
            from .persistence.postgres import postgres_stores

            stores, pool = postgres_stores(settings.database_url, objects)
            closers.append(pool.close)
        else:
            stores = memory_stores(Path(settings.object_root))
    if resolver is None:
        resolver = ColumnBindingResolver.create(
            workspace / "ontology" / "affiliate.v1.json",
            database_url=settings.database_url,
            enable_embeddings=settings.matcher_enable_embeddings,
            embedding_model=settings.embedding_model,
            enable_llm=settings.matcher_enable_llm,
            llm_model=settings.matcher_llm_model,
            llm_base_url=settings.azure_openai_base_url if settings.model_provider == "azure_openai_v1" else None,
            api_key=os.environ.get("OPENAI_API_KEY"),
        )
        closers.append(resolver.close)
    if sandbox_factory is None and settings.sandbox_backend == "docker":
        sandbox_factory = docker_sandbox_factory(settings)
    elif sandbox_factory is None and settings.sandbox_backend == "aca":
        sandbox_factory = aca_sandbox_factory(settings)
    return Services(
        settings=settings,
        stores=stores,
        resolver=resolver,
        workspace=workspace,
        model_factory=model_factory or (lambda role: chat_model(role, settings)),
        sandbox_factory=sandbox_factory,
        closers=closers,
    )


def run_context(
    services: Services,
    *,
    run_id: str,
    sponsor_id: str,
    entity: str,
    actor: str,
    upload_path: Path,
    emit: Emit | None = None,
) -> RunContext:
    run_dir = services.stores.objects.local_path(f"runs/{run_id}")
    ctx = RunContext(
        run_id=run_id,
        sponsor_id=sponsor_id,
        entity=entity,
        actor=actor,
        upload_path=upload_path,
        run_dir=run_dir,
        workspace=services.workspace,
        resolver=services.resolver,
        stores=services.stores,
        sandbox_factory=services.sandbox_factory,
    )
    if emit is not None:
        ctx.emit = emit
    return ctx


def _middleware(services: Services, ctx: RunContext, call_limit: int) -> list[Any]:
    return [
        OffloadMiddleware(ctx.run_dir / "artifacts" / "tool-results"),
        RedactionMiddleware(services.secrets()),
        ModelRetryMiddleware(max_retries=2, retry_on=_retryable(), on_failure="error"),
        ModelCallLimitMiddleware(run_limit=call_limit, exit_behavior="end"),
    ]


def _prompt(services: Services, name: str) -> str:
    return (REPO_ROOT / "instructions" / f"{name}.md").read_text(encoding="utf-8")


def build_supervisor(services: Services, ctx: RunContext, mode: supervisor_mod.Mode = "scope") -> Any:
    engineer = recipe_engineer_mod.build_recipe_engineer(
        services.model_factory("recipe_engineer"),
        ctx,
        prompt=_prompt(services, "recipe_engineer"),
        extra_middleware=_middleware(services, ctx, RECIPE_ENGINEER_CALL_LIMIT),
    )
    return supervisor_mod.build_supervisor(
        services.model_factory("supervisor"),
        ctx,
        prompt=_prompt(services, "supervisor"),
        engineer=engineer,
        extra_middleware=_middleware(services, ctx, services.settings.max_model_calls),
        mode=mode,
    )


def invoke_supervisor(services: Services, ctx: RunContext, mode: supervisor_mod.Mode, **extra: Any) -> dict[str, Any]:
    agent = build_supervisor(services, ctx, mode)
    message = supervisor_mod.mode_message(mode, ctx, **extra)
    ctx.emit("agent_message", {"role": "system", "mode": mode, "text": message})
    result: dict[str, Any] = agent.invoke(
        {"messages": [{"role": "user", "content": message}]},
        config={"callbacks": [ModelCallCounter(ctx), TracingCallback(ctx.run_id)], "recursion_limit": 150},
    )
    return result


def build_checkpointer(services: Services) -> Any:
    """Postgres checkpoints when a database is configured, else in memory (tests, offline CLI)."""
    url = services.settings.database_url
    if not url:
        from langgraph.checkpoint.memory import InMemorySaver

        return InMemorySaver()
    from langgraph.checkpoint.postgres import PostgresSaver
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool

    pool = ConnectionPool(
        url, min_size=1, max_size=8, kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row}
    )
    services.closers.append(pool.close)
    saver = PostgresSaver(pool)  # type: ignore[arg-type]
    saver.setup()
    return saver

"""Chat model factory. OpenAI and Azure OpenAI (v1 API) only."""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from langchain_openai import ChatOpenAI

from .config import Settings, get_settings

Role = Literal["supervisor", "recipe_engineer"]
AZURE_SCOPE = "https://cognitiveservices.azure.com/.default"


def _azure_token_provider(scope: str) -> Callable[[], str]:
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider

    return get_bearer_token_provider(DefaultAzureCredential(), scope)


def chat_model(role: Role, settings: Settings | None = None) -> ChatOpenAI:
    settings = settings or get_settings()
    if role == "supervisor":
        model, effort = settings.supervisor_model, settings.supervisor_effort
    elif role == "recipe_engineer":
        model, effort = settings.recipe_engineer_model, settings.recipe_engineer_effort
    else:
        raise ValueError(f"unknown model role {role!r}")

    kwargs: dict[str, object] = {
        "model": model,
        "use_responses_api": True,
        "reasoning": {"effort": effort},
        "timeout": settings.model_timeout_s,
        "max_retries": 2,
    }
    if settings.model_provider == "azure_openai_v1":
        kwargs["base_url"] = settings.azure_openai_base_url
        kwargs["api_key"] = _azure_token_provider(AZURE_SCOPE)
    return ChatOpenAI(**kwargs)  # type: ignore[arg-type]

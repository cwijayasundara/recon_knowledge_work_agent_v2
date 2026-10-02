from __future__ import annotations

import pytest
from pydantic import ValidationError

from onboarding_agent.config import Settings
from onboarding_agent.models import chat_model


def test_defaults_are_local_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("ONB_MODEL_PROVIDER", "ONB_SUPERVISOR_MODEL", "ONB_DATABASE_URL"):
        monkeypatch.delenv(name, raising=False)
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    assert settings.model_provider == "openai"
    assert settings.supervisor_model == "gpt-5.6-terra"
    assert settings.recipe_engineer_model == "gpt-5.6-terra"
    assert settings.database_url is None
    assert settings.sandbox_backend == "docker"


def test_env_prefix_parses_azure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ONB_MODEL_PROVIDER", "azure_openai_v1")
    monkeypatch.setenv("ONB_AZURE_OPENAI_BASE_URL", "https://res.openai.azure.com/openai/v1/")
    monkeypatch.setenv("ONB_SUPERVISOR_MODEL", "gpt-6-astra")
    monkeypatch.setenv("ONB_RECIPE_ENGINEER_MODEL", "gpt-5.6-sol")
    monkeypatch.setenv("ONB_MAX_MODEL_CALLS", "12")
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    assert settings.model_provider == "azure_openai_v1"
    assert settings.supervisor_model == "gpt-6-astra"
    assert settings.max_model_calls == 12


def test_azure_requires_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ONB_MODEL_PROVIDER", "azure_openai_v1")
    monkeypatch.delenv("ONB_AZURE_OPENAI_BASE_URL", raising=False)
    with pytest.raises(ValidationError, match="AZURE_OPENAI_BASE_URL"):
        Settings(_env_file=None)  # type: ignore[call-arg]


def test_unknown_provider_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ONB_MODEL_PROVIDER", "anthropic")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


def test_chat_model_openai_uses_responses_api(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    settings = Settings(_env_file=None, supervisor_effort="high")  # type: ignore[call-arg]
    model = chat_model("supervisor", settings)
    assert model.model_name == "gpt-5.6-terra"
    assert model.use_responses_api is True
    assert model.reasoning == {"effort": "high"}
    assert model.max_retries == 2
    assert model.request_timeout == settings.model_timeout_s


def test_chat_model_azure_uses_token_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_provider(scope: str) -> object:
        calls.append(scope)
        return lambda: "token"

    monkeypatch.setattr("onboarding_agent.models._azure_token_provider", fake_provider)
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        model_provider="azure_openai_v1",
        azure_openai_base_url="https://res.openai.azure.com/openai/v1/",
        recipe_engineer_model="gpt-5.6-sol",
    )
    model = chat_model("recipe_engineer", settings)
    assert model.model_name == "gpt-5.6-sol"
    assert str(model.openai_api_base).startswith("https://res.openai.azure.com")
    assert calls == ["https://cognitiveservices.azure.com/.default"]


def test_chat_model_rejects_unknown_role() -> None:
    with pytest.raises(ValueError, match="role"):
        chat_model("critic", Settings(_env_file=None))  # type: ignore[arg-type,call-arg]

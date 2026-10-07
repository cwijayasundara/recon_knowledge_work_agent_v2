"""Runtime settings. Every variable is read with the ``ONB_`` prefix."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ModelProvider = Literal["openai", "azure_openai_v1"]
Effort = Literal["minimal", "low", "medium", "high"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ONB_", env_file=".env", extra="ignore")

    model_provider: ModelProvider = "openai"
    supervisor_model: str = "gpt-5.6-terra"
    recipe_engineer_model: str = "gpt-5.6-terra"
    matcher_llm_model: str = "gpt-5.6-terra"
    embedding_model: str = "text-embedding-3-small"
    supervisor_effort: Effort = "medium"
    recipe_engineer_effort: Effort = "medium"
    azure_openai_base_url: str | None = None

    copilot_enabled: bool = False
    copilot_model: str = "gpt-5.6-terra"
    copilot_effort: Effort = "medium"
    copilot_max_cells_per_call: int = Field(default=2000, ge=1)
    copilot_max_cells_per_session: int = Field(default=20000, ge=1)
    copilot_max_steps_per_turn: int = Field(default=8, ge=1)
    copilot_max_write_cells: int = Field(default=2000, ge=1)
    copilot_cell_char_limit: int = Field(default=500, ge=1)
    copilot_session_ttl_s: int = Field(default=3600, ge=1)
    copilot_max_sessions_per_actor: int = Field(default=5, ge=1)
    copilot_session_max_lifetime_s: int = Field(default=43200, ge=1)
    copilot_max_concurrent_steps: int = Field(default=8, ge=1)

    database_url: str | None = None
    object_root: str = "var/objects"

    sandbox_backend: Literal["docker", "aca"] = "docker"
    sandbox_image: str = "onb-sandbox"
    aca_pool_endpoint: str | None = None

    max_model_calls: int = 40
    model_timeout_s: float = 120.0

    string_matcher_path: str = "../../advance_research/string_matcher_v1"
    workspace_root: str = "workspace"
    api_token: str | None = None
    # Azure: Container Apps built-in auth (Entra ID) signs the user in and forwards
    # X-MS-CLIENT-PRINCIPAL-NAME; the API then requires and records that name.
    trust_easy_auth: bool = False
    # "id:Name,id:Name" registered at API start (local manual testing).
    seed_sponsors: str = ""
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # Matcher and resolver features that need a model; off keeps the
    # resolver deterministic (history, alias, fuzzy) for offline runs.
    matcher_enable_llm: bool = False
    matcher_enable_embeddings: bool = False

    # Code fast path: the spine resolves the single list-like sheet in code so
    # a standard brief can be drafted without a model call. Off restores the
    # supervisor-only scoping path.
    fastpath: bool = True
    fastpath_min_list: float = Field(default=0.5, ge=0.0, le=1.0)
    fastpath_min_score: float = Field(default=0.95, ge=0.0, le=1.0)

    # Regression capture: finalize stores a case for a locked run the analyst
    # corrected, reading the decision log and snapshot only. Off writes nothing.
    regression_capture: bool = True

    @model_validator(mode="after")
    def _azure_needs_endpoint(self) -> Settings:
        if self.model_provider == "azure_openai_v1" and not self.azure_openai_base_url:
            raise ValueError("ONB_AZURE_OPENAI_BASE_URL is required for azure_openai_v1")
        if self.sandbox_backend == "aca" and not self.aca_pool_endpoint:
            raise ValueError("ONB_ACA_POOL_ENDPOINT is required for the aca sandbox")
        return self


def get_settings() -> Settings:
    return Settings()

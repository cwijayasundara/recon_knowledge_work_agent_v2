from __future__ import annotations

import os
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
STRING_MATCHER = Path(
    os.environ.get(
        "STRING_MATCHER_PATH",
        os.environ.get("ONB_STRING_MATCHER_PATH", REPO_ROOT / "../../advance_research/string_matcher_v1"),
    )
).resolve()
SAMPLE_DIR = STRING_MATCHER / "docs/sample_data/affiliate"
FIXTURE_DIR = REPO_ROOT / "tests/fixtures/affiliate"


def _key_from_dotenv() -> None:
    """Live tests may take OPENAI_API_KEY from .env; nothing else is loaded, so ONB_*
    values there never change what the offline tests see."""
    if os.environ.get("OPENAI_API_KEY"):
        return
    from dotenv import dotenv_values

    key = dotenv_values(REPO_ROOT / ".env").get("OPENAI_API_KEY") if (REPO_ROOT / ".env").is_file() else None
    if key:
        os.environ["OPENAI_API_KEY"] = key


_key_from_dotenv()


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("OPENAI_API_KEY"):
        return
    skip = pytest.mark.skip(reason="OPENAI_API_KEY is not set")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def sample_dir() -> Path:
    return SAMPLE_DIR


@pytest.fixture
def fixture_dir() -> Path:
    return FIXTURE_DIR

"""Real-container checks. Needs Docker and `docker build -t onb-sandbox -f sandbox/Dockerfile .`."""

from __future__ import annotations

from pathlib import Path

import pytest
from onboarding_sdk import recipes

from onboarding_agent.sandbox.base import SandboxMounts
from onboarding_agent.sandbox.docker_backend import DockerSandbox
from tests.conftest import FIXTURE_DIR

pytestmark = pytest.mark.docker


@pytest.fixture
def sandbox(tmp_path: Path):  # type: ignore[no-untyped-def]
    for name in ("in", "ref", "skills"):
        (tmp_path / name).mkdir()
    (tmp_path / "in" / "clean.csv").write_bytes((FIXTURE_DIR / "clean.csv").read_bytes())
    with DockerSandbox("test", SandboxMounts(tmp_path / "in", tmp_path / "ref", tmp_path / "skills")) as box:
        yield box


def test_sdk_importable(sandbox: DockerSandbox) -> None:
    assert sandbox.execute('python -c "import onboarding_sdk"').exit_code == 0


def test_in_is_read_only(sandbox: DockerSandbox) -> None:
    assert sandbox.execute("touch /in/x").exit_code != 0


def test_no_secrets_in_env(sandbox: DockerSandbox) -> None:
    result = sandbox.execute("env | grep -iE 'key|token|secret' || true")
    assert result.output.strip() == ""


def test_no_network(sandbox: DockerSandbox) -> None:
    code = "import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)"
    assert sandbox.execute(f'python -c "{code}"').exit_code != 0


def test_recipes_check_runs_inside(sandbox: DockerSandbox) -> None:
    source = recipes.standard({"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"}, "clean", 1)
    assert sandbox.upload_files([("/work/recipe.py", source.encode())])[0].error is None
    result = sandbox.execute("python -m onboarding_sdk.recipes check /work/recipe.py /in/clean.csv")
    assert result.exit_code == 0, result.output
    assert sandbox.download_files(["/work/recipe.py"])[0].content == source.encode()

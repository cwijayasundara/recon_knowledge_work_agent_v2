"""Serve the API with the fixture agent (no live model) for Playwright and offline demos.

uv run python -m tests.e2e.serve_scripted --port 8000
"""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

import uvicorn

from onboarding_agent.surfaces.api import create_app
from tests.support.fixture_agent import FixtureAgentModel
from tests.support.services import Models, offline_services


def build(root: Path):  # type: ignore[no-untyped-def]
    models = Models()
    models.supervisor = FixtureAgentModel()
    services = offline_services(root, models)
    services.stores.sponsors.add("sponsor-a", "Sponsor A")
    services.stores.sponsors.add("sponsor-b", "Sponsor B")
    services.stores.sponsors.add("sponsor-c", "Sponsor C")
    return create_app(services=services)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--root", type=Path, default=None)
    args = parser.parse_args()
    root = args.root or Path(tempfile.mkdtemp(prefix="onb-e2e-"))
    uvicorn.run(build(root), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()

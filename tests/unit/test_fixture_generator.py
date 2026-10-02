from __future__ import annotations

import hashlib
import importlib.util
import sys
from pathlib import Path

from tests.conftest import REPO_ROOT, SAMPLE_DIR


def _load_generator():  # type: ignore[no-untyped-def]
    spec = importlib.util.spec_from_file_location("generate_fixtures", REPO_ROOT / "scripts/generate_fixtures.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["generate_fixtures"] = module
    spec.loader.exec_module(module)
    return module


def _digest(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def test_generator_is_idempotent(tmp_path: Path) -> None:
    gen = _load_generator()
    gen.generate(SAMPLE_DIR, tmp_path / "a")
    gen.generate(SAMPLE_DIR, tmp_path / "b")
    first, second = _digest(tmp_path / "a"), _digest(tmp_path / "b")
    assert first == second
    assert len([name for name in first if not name.startswith("expected")]) == 9


def test_committed_fixtures_are_current(tmp_path: Path) -> None:
    gen = _load_generator()
    gen.generate(SAMPLE_DIR, tmp_path)
    assert _digest(tmp_path) == _digest(REPO_ROOT / "tests/fixtures/affiliate")

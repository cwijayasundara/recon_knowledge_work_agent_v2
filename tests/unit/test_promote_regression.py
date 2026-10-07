"""E6: ``scripts/promote_regression.py`` promotion flow.

The script needs the ``--i-confirm-synthetic`` flag in every case, prints the
review summary before refusing, pins the twin's sha256 to the case, strips
capture-time step timestamps so a promoted case is byte-stable, and honours
``--force``. Tests run against a tmp object store seeded through the real
``derive_case`` capture path.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

from onboarding_agent.persistence.interfaces import DecisionRecord, RunRecord
from onboarding_agent.persistence.memory import memory_stores
from onboarding_agent.regression import RegressionCase, case_key, derive_case
from tests.conftest import REPO_ROOT

RUN = "run-1"
SPONSOR = "sponsor-a"
AT = "2026-01-01T00:00:00.000000Z"
LATER_AT = "2026-03-03T03:03:03.000000Z"
UPLOAD = b"affiliate_id,affiliate_name\nA1,Alpha\n"
CSV_SHA = "c" * 64
ACTOR = "analyst@sponsor-a"


def _load_script() -> Any:
    spec = importlib.util.spec_from_file_location("promote_regression", REPO_ROOT / "scripts/promote_regression.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["promote_regression"] = module
    spec.loader.exec_module(module)
    return module


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _seed(root: Path, *, at: str = AT, upload: bytes = UPLOAD, pin_sha: str | None = None) -> Any:
    """A locked run with one correction, its upload and captured case, in a tmp
    object store. ``pin_sha`` makes the case pin a different upload sha."""
    stores = memory_stores(root / "objects")
    key = f"runs/{RUN}/in/edge.csv"
    stores.objects.put(key, upload)
    stores.runs.create(
        RunRecord(RUN, SPONSOR, "affiliate", "locked", key, _digest(upload), "fp-1", ACTOR, AT, AT, "edge.csv")
    )
    case = derive_case(
        run_id=RUN,
        sponsor_id=SPONSOR,
        entity="affiliate",
        fingerprint="fp-1",
        fixture="edge.csv",
        upload_sha256=pin_sha or _digest(upload),
        decisions=[DecisionRecord(RUN, 1, "findings.change", {"action": "change"}, ACTOR, at)],
        status="locked",
        bindings={"affiliate_id": "Affiliate ID"},
        csv_sha256=CSV_SHA,
        finding_codes=["AFF_WARN_ITEM_ID_DERIVED"],
    )
    assert case is not None
    stores.objects.put(case_key(SPONSOR, RUN), json.dumps(case, indent=2).encode())
    return stores


def _promote(script: Any, stores: Any, root: Path, *extra: str) -> int:
    return script.main(["--case", case_key(SPONSOR, RUN), *extra], stores=stores, repo_root=root)


def _case_file(root: Path, name: str) -> Path:
    return root / "tests/regression/cases" / f"{name}.json"


def _twin_file(root: Path, name: str) -> Path:
    return root / "tests/fixtures/regression" / name


def test_refuses_to_write_without_the_confirmation_flag(tmp_path: Path, capsys: Any) -> None:
    script = _load_script()
    stores = _seed(tmp_path)
    rc = _promote(script, stores, tmp_path)
    assert rc == 2
    out = capsys.readouterr()
    assert "findings.change" in out.out and "fp-1" in out.out and "csv_sha256" in out.out  # summary printed first
    assert "refusing to write" in out.err
    assert not _case_file(tmp_path, RUN).exists()
    assert not _twin_file(tmp_path, RUN).exists()


def test_round_trip_with_the_flag(tmp_path: Path) -> None:
    script = _load_script()
    stores = _seed(tmp_path)
    rc = _promote(script, stores, tmp_path, "--i-confirm-synthetic", "--name", "edge-change")
    assert rc == 0
    case = RegressionCase.model_validate(json.loads(_case_file(tmp_path, "edge-change").read_bytes()))
    assert case.run_id == RUN and case.sponsor_id == SPONSOR and case.entity == "affiliate"
    assert case.fingerprint == "fp-1"
    assert case.upload.sha256 == _digest(UPLOAD)
    assert _twin_file(tmp_path, "edge-change").read_bytes() == UPLOAD
    assert case.outcome.csv_sha256 == CSV_SHA
    assert case.outcome.bindings == {"affiliate_id": "Affiliate ID"}
    assert all(step.at == "" for step in case.steps)


def test_name_defaults_to_the_run_id(tmp_path: Path) -> None:
    script = _load_script()
    stores = _seed(tmp_path)
    rc = _promote(script, stores, tmp_path, "--i-confirm-synthetic")
    assert rc == 0
    assert _case_file(tmp_path, RUN).exists()
    assert _twin_file(tmp_path, RUN).exists()


def test_rejects_a_default_twin_that_hashes_differently(tmp_path: Path, capsys: Any) -> None:
    script = _load_script()
    stores = _seed(tmp_path, pin_sha="d" * 64)
    rc = _promote(script, stores, tmp_path, "--i-confirm-synthetic")
    assert rc == 1
    assert "the case pins" in capsys.readouterr().err
    assert not _case_file(tmp_path, RUN).exists()
    assert not _twin_file(tmp_path, RUN).exists()


def test_promoting_the_same_store_twice_is_byte_identical(tmp_path: Path) -> None:
    script = _load_script()
    stores = _seed(tmp_path)
    assert _promote(script, stores, tmp_path, "--i-confirm-synthetic", "--force") == 0
    first = _case_file(tmp_path, RUN).read_bytes()
    # A re-capture stamps new times into the store's case; promotion must erase
    # that, not encode it.
    _seed(tmp_path, at=LATER_AT)
    assert _promote(script, stores, tmp_path, "--i-confirm-synthetic", "--force") == 0
    second = _case_file(tmp_path, RUN).read_bytes()
    assert first == second
    assert AT.encode() not in first and LATER_AT.encode() not in second


def test_rejects_an_explicit_twin_that_hashes_differently(tmp_path: Path, capsys: Any) -> None:
    script = _load_script()
    stores = _seed(tmp_path)
    twin = tmp_path / "twin.csv"
    twin.write_bytes(b"affiliate_id,affiliate_name\nA1,Alpha-2\n")
    rc = _promote(script, stores, tmp_path, "--twin", str(twin), "--i-confirm-synthetic")
    assert rc == 1
    err = capsys.readouterr().err
    assert "case pins" in err
    assert not _case_file(tmp_path, RUN).exists()
    assert not _twin_file(tmp_path, RUN).exists()


def test_twin_with_unchanged_bytes_does_not_warn(tmp_path: Path, capsys: Any) -> None:
    script = _load_script()
    stores = _seed(tmp_path)
    twin = tmp_path / "same.csv"
    twin.write_bytes(UPLOAD)
    rc = _promote(script, stores, tmp_path, "--twin", str(twin), "--i-confirm-synthetic")
    assert rc == 0
    assert "WARNING" not in capsys.readouterr().err


def test_overwrite_requires_force(tmp_path: Path) -> None:
    script = _load_script()
    stores = _seed(tmp_path)
    assert _promote(script, stores, tmp_path, "--i-confirm-synthetic") == 0
    first = _case_file(tmp_path, RUN).read_bytes()
    assert _promote(script, stores, tmp_path, "--i-confirm-synthetic") == 1
    assert _case_file(tmp_path, RUN).read_bytes() == first
    assert _twin_file(tmp_path, RUN).read_bytes() == UPLOAD
    assert _promote(script, stores, tmp_path, "--i-confirm-synthetic", "--force") == 0
    assert _case_file(tmp_path, RUN).read_bytes() == first


def test_missing_run_record_advises_twin(tmp_path: Path, capsys: Any) -> None:
    script = _load_script()
    _seed(tmp_path)
    fresh = memory_stores(tmp_path / "objects")  # same object root, empty run store
    rc = _promote(script, fresh, tmp_path, "--i-confirm-synthetic")
    assert rc == 1
    assert "--twin" in capsys.readouterr().err
    assert not _case_file(tmp_path, RUN).exists()


def test_invalid_names_are_rejected(tmp_path: Path) -> None:
    script = _load_script()
    stores = _seed(tmp_path)
    for name in ("../escape", "A_UPPER", ""):
        rc = _promote(script, stores, tmp_path, "--i-confirm-synthetic", "--name", name)
        assert rc == 1, name
    assert not _case_file(tmp_path, RUN).exists()


def test_missing_case_key_is_rejected(tmp_path: Path, capsys: Any) -> None:
    script = _load_script()
    rc = script.main(
        ["--case", "uploads/sponsor-a/other.json", "--i-confirm-synthetic"], stores=_seed(tmp_path), repo_root=tmp_path
    )
    assert rc == 1
    assert "regression/<sponsor>/<run>.json" in capsys.readouterr().err

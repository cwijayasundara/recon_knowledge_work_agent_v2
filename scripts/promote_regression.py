"""Promote a captured regression case into the repo (plan R3).

Reads a case from the object store (``regression/<sponsor>/<run_id>.json``),
prints a review summary, and — only with ``--i-confirm-synthetic`` — writes the
case to ``tests/regression/cases/<name>.json`` and the upload bytes (the
"synthetic twin") to ``tests/fixtures/regression/<name>``. The twin must hash
to the case's ``upload.sha256``; production uploads are never committed, so a
twin of a real upload must be regenerated with the
``scripts/generate_fixtures.py`` patterns and passed via ``--twin`` (which
re-pins ``upload.sha256`` and invalidates ``outcome.csv_sha256`` until the case
is replayed).

Offline and model-free: stores come from the settings' object root (Postgres
run store when ``ONB_DATABASE_URL`` is set), never from a live run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

from onboarding_agent.config import Settings
from onboarding_agent.persistence.interfaces import Stores
from onboarding_agent.persistence.memory import LocalObjectStore, memory_stores
from onboarding_agent.regression import RegressionCase, case_key

REPO_ROOT = Path(__file__).resolve().parents[1]
CASES_DIR = Path("tests/regression/cases")
TWINS_DIR = Path("tests/fixtures/regression")
NAME = re.compile(r"[a-z0-9][a-z0-9._-]*")


class PromotionError(RuntimeError):
    """A condition a human must resolve before the case can be committed."""


def _no_close() -> None:
    pass


def build_stores(settings: Settings) -> tuple[Stores, Callable[[], None]]:
    """The narrow slice of assembly.build_services promotion needs: the object
    store, plus the run store (Postgres) for ``upload_uri`` lookups."""
    if settings.database_url:
        from onboarding_agent.persistence.postgres import postgres_stores

        stores, pool = postgres_stores(settings.database_url, LocalObjectStore(Path(settings.object_root)))
        return stores, pool.close
    return memory_stores(Path(settings.object_root)), _no_close


def _load_case(stores: Stores, object_key: str) -> RegressionCase:
    parts = object_key.split("/")
    if (
        len(parts) != 3
        or parts[0] != "regression"
        or not parts[2].endswith(".json")
        or case_key(parts[1], parts[2][: -len(".json")]) != object_key
    ):
        raise PromotionError(f"case key must look like {case_key('<sponsor>', '<run>')}, got {object_key!r}")
    try:
        raw = stores.objects.get(object_key)
    except (FileNotFoundError, ValueError) as exc:
        raise PromotionError(f"case {object_key!r} not found in the object store: {exc}") from exc
    try:
        return RegressionCase.model_validate(json.loads(raw))
    except ValueError as exc:  # pydantic ValidationError and JSONDecodeError both
        raise PromotionError(f"object {object_key!r} is not a valid regression case: {exc}") from exc


def _twin_bytes(stores: Stores, case: RegressionCase) -> bytes:
    """Original upload bytes: the run record's ``upload_uri`` in the object store."""
    run = stores.runs.get(case.run_id)
    if run is None:
        raise PromotionError(
            f"no run record for {case.run_id!r} (in-memory runs vanish with their process); "
            "pass --twin <path> with the upload's bytes"
        )
    try:
        return stores.objects.get(run.upload_uri)
    except (FileNotFoundError, ValueError) as exc:
        raise PromotionError(f"upload {run.upload_uri!r} not found in the object store: {exc}") from exc


def _summary(case: RegressionCase, twin_source: str, twin_sha: str, case_dest: Path, twin_dest: Path) -> str:
    step_lines = [f"    {s.seq:>3} {s.kind:<20} {s.actor}  {json.dumps(s.payload, sort_keys=True)}" for s in case.steps]
    lines = [
        "Regression case review",
        f"  case       : run {case.run_id} / sponsor {case.sponsor_id} / entity {case.entity} (v{case.version})",
        f"  fingerprint: {case.fingerprint}",
        f"  upload     : {twin_source} sha256={twin_sha}",
        f"  outcome    : status={case.outcome.status} csv_sha256={case.outcome.csv_sha256}",
        f"  bindings   : {json.dumps(case.outcome.bindings, sort_keys=True)}",
        f"  findings   : {', '.join(case.outcome.finding_codes) or '(none)'}",
        "  steps      :",
        *(step_lines or ["    (none)"]),
        f"  write case : {case_dest}",
        f"  write twin : {twin_dest}",
    ]
    return "\n".join(lines)


def promote(
    object_key: str,
    *,
    name: str | None,
    twin: Path | None,
    force: bool,
    confirmed: bool,
    stores: Stores,
    repo_root: Path,
) -> int:
    case = _load_case(stores, object_key)
    name = case.run_id if name is None else name
    if not NAME.fullmatch(name):
        raise PromotionError(f"invalid --name {name!r}: lowercase letters, digits, '.', '_' and '-' only")

    if twin is None:
        twin_source = "the run's original upload"
        twin_bytes = _twin_bytes(stores, case)
    else:
        twin_source = f"path: {twin}"
        try:
            twin_bytes = twin.read_bytes()
        except OSError as exc:
            raise PromotionError(f"cannot read --twin {twin}: {exc}") from exc
    twin_sha = hashlib.sha256(twin_bytes).hexdigest()

    case_dest = repo_root / CASES_DIR / f"{name}.json"
    twin_dest = repo_root / TWINS_DIR / name
    print(_summary(case, twin_source, twin_sha, case_dest, twin_dest))

    if twin is None and twin_sha != case.upload.sha256:
        print(
            f"error: the run's upload hashes to {twin_sha}, but the case pins {case.upload.sha256}; "
            "refusing to commit bytes the case does not vouch for",
            file=sys.stderr,
        )
        return 1
    if twin_sha != case.upload.sha256:
        print(
            f"\nWARNING: --twin re-pins upload.sha256 to {twin_sha}. outcome.csv_sha256 still belongs to the\n"
            "old upload's output, so this case WILL FAIL until the replay runner has re-verified it. Only\n"
            "synthetic twins (generated with the scripts/generate_fixtures.py patterns) may be committed.",
            file=sys.stderr,
        )

    if not confirmed:
        print(
            "\nrefusing to write: promoting commits the twin into the repo; re-run with "
            "--i-confirm-synthetic once you have reviewed the case above",
            file=sys.stderr,
        )
        return 2
    existing = [p for p in (case_dest, twin_dest) if p.exists()]
    if existing and not force:
        print(f"error: refusing to overwrite {', '.join(map(str, existing))} without --force", file=sys.stderr)
        return 1

    # Byte-stable commit: steps' captured-at timestamps are capture-time noise,
    # so they are stripped — two captures of the same corrections must promote
    # to identical bytes.
    promoted = case.model_copy(deep=True)
    promoted.upload.sha256 = twin_sha
    for step in promoted.steps:
        step.at = ""
    payload = (json.dumps(promoted.model_dump(), indent=2) + "\n").encode()

    case_dest.parent.mkdir(parents=True, exist_ok=True)
    twin_dest.parent.mkdir(parents=True, exist_ok=True)
    case_dest.write_bytes(payload)
    twin_dest.write_bytes(twin_bytes)
    print(f"\nwrote {case_dest}\nwrote {twin_dest}")
    return 0


def main(
    argv: Sequence[str] | None = None,
    *,
    stores: Stores | None = None,
    repo_root: Path | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--case", required=True, metavar="OBJECT_KEY", help="object-store key of the captured case")
    parser.add_argument("--name", help="case/twin name (default: the case key's run id)")
    parser.add_argument("--twin", type=Path, help="promote this file as the twin instead of the run's own upload")
    parser.add_argument("--force", action="store_true", help="overwrite an existing case or twin")
    parser.add_argument(
        "--i-confirm-synthetic", action="store_true", help="human confirmation that the twin is synthetic"
    )
    args = parser.parse_args(argv)

    closer = _no_close
    try:
        if stores is None:
            stores, closer = build_stores(Settings())
        return promote(
            args.case,
            name=args.name,
            twin=args.twin,
            force=args.force,
            confirmed=args.i_confirm_synthetic,
            stores=stores,
            repo_root=repo_root or REPO_ROOT,
        )
    except PromotionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        closer()


if __name__ == "__main__":
    raise SystemExit(main())

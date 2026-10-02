from __future__ import annotations

import io
from pathlib import Path

from onboarding_agent.surfaces import cli
from tests.conftest import FIXTURE_DIR
from tests.support.scripts import report_simple, scope_standard
from tests.support.services import Models, offline_services


def test_cli_interactive_run_with_ack(tmp_path: Path) -> None:
    models = Models()
    models.supervisor.script = [*scope_standard("ids_missing.csv"), *report_simple()]
    services = offline_services(tmp_path, models)
    args = cli.parser().parse_args(
        ["run", "affiliate", str(FIXTURE_DIR / "ids_missing.csv"), "--sponsor", "sponsor-a", "--actor", "me"]
    )
    inp = io.StringIO("?\napprove\napprove\nack-warnings\napprove\napprove\n")
    out = io.StringIO()
    code = cli.run(args, services, inp=inp, out=out)
    text = out.getvalue()
    assert code == 0, text
    assert "--- gate: brief ---" in text and "AFF_WARN_ITEM_ID_DERIVED" in text
    assert "blocked: AFF_WARN_ITEM_ID_DERIVED on row 1 needs acknowledgement" in text
    assert "finished: locked" in text
    assert "Affiliates.csv" in text


def test_cli_history(tmp_path: Path) -> None:
    models = Models()
    models.supervisor.script = scope_standard("clean.csv")
    services = offline_services(tmp_path, models)
    args = cli.parser().parse_args(
        ["run", "affiliate", str(FIXTURE_DIR / "clean.csv"), "--sponsor", "sponsor-a", "--yes"]
    )
    assert cli.run(args, services, out=io.StringIO()) == 0
    out = io.StringIO()
    cli.history(cli.parser().parse_args(["history", "sponsor-a"]), services, out)
    assert '"affiliate_name": "Affiliate Name"' in out.getvalue()


def test_cli_rejects_bad_upload(tmp_path: Path) -> None:
    services = offline_services(tmp_path, Models())
    args = cli.parser().parse_args(["run", "affiliate", str(tmp_path / "missing.csv"), "--sponsor", "sponsor-a"])
    assert cli.run(args, services, out=io.StringIO()) == 2

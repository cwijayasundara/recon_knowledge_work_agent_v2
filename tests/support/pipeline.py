"""Test helpers: run an upload through the standard recipe path without a model."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from onboarding_sdk import read
from onboarding_sdk.canonical import AffiliateCanonical, from_table

from tests.conftest import FIXTURE_DIR


def expected(name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_DIR / "expected" / f"{Path(name).stem}.json").read_text())


def canonical_for(name: str) -> AffiliateCanonical:
    spec = expected(name)
    wb = read.open(FIXTURE_DIR / name)
    table = wb.select(spec["sheet"]).table(spec["header_row"])
    return from_table(
        table,
        id_column=spec["bindings"]["affiliate_id"],
        name_column=spec["bindings"]["affiliate_name"],
    )

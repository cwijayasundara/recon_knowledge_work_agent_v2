"""The Intacct Affiliates upload file."""

from __future__ import annotations

import csv
import io

from .entities.affiliate.policy import TEMPLATE_COLUMNS
from .entities.affiliate.rules import AffiliateResult


class RenderRefused(RuntimeError):
    """The result has open errors or unacknowledged warnings."""


def intacct_csv(result: AffiliateResult) -> bytes:
    """Pinned column order, UTF-8 without BOM, ``\\n`` line endings."""
    if not result.publishable:
        raise RenderRefused("result is not publishable: resolve errors and acknowledge warnings")
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=list(TEMPLATE_COLUMNS), lineterminator="\n", extrasaction="raise")
    writer.writeheader()
    for record in result.records:
        writer.writerow(record.as_template_row())
    return buffer.getvalue().encode("utf-8")

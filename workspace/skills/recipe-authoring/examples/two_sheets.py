"""Affiliates split across two sheets with the same header: concatenate them."""

from onboarding_sdk.canonical import AffiliateCanonical, from_table
from onboarding_sdk.read import Workbook

RECIPE = {
    "entity": "affiliate",
    "sdk": "0.1.0",
    "summary": "Sheets 'GP entities' and 'Management entities', header on row 1 of each.",
    "bindings": {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"},
}
SHEETS = ("GP entities", "Management entities")


def prepare(wb: Workbook) -> AffiliateCanonical:
    rows, dropped = [], []
    for name in SHEETS:
        part = from_table(
            wb.select(name).table(1),
            id_column=RECIPE["bindings"]["affiliate_id"],
            name_column=RECIPE["bindings"]["affiliate_name"],
        )
        rows.extend(part.rows)
        dropped.extend(part.dropped)
    return AffiliateCanonical(tuple(rows), tuple(dropped))

"""One table under one header row."""

from onboarding_sdk.canonical import AffiliateCanonical, from_table
from onboarding_sdk.read import Workbook

RECIPE = {
    "entity": "affiliate",
    "sdk": "0.1.0",
    "summary": "Sheet 'Affiliates', header on row 1.",
    "bindings": {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"},
}


def prepare(wb: Workbook) -> AffiliateCanonical:
    table = wb.select("Affiliates").table(1)
    return from_table(
        table,
        id_column=RECIPE["bindings"]["affiliate_id"],
        name_column=RECIPE["bindings"]["affiliate_name"],
    )

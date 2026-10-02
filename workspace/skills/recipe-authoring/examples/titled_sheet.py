"""Title rows above the header and a trailing total row.

`table()` stops at the first blank row after the header and drops rows that
start with "Total", recording them in `dropped`.
"""

from onboarding_sdk.canonical import AffiliateCanonical, from_table
from onboarding_sdk.read import Workbook

RECIPE = {
    "entity": "affiliate",
    "sdk": "0.1.0",
    "summary": "Sheet 'Affiliates', title rows 1-3, header on row 4, total row dropped.",
    "bindings": {"affiliate_id": "Affiliate ID", "affiliate_name": "Affiliate Name"},
}


def prepare(wb: Workbook) -> AffiliateCanonical:
    table = wb.select("Affiliates").table(4)
    return from_table(
        table,
        id_column=RECIPE["bindings"]["affiliate_id"],
        name_column=RECIPE["bindings"]["affiliate_name"],
    )

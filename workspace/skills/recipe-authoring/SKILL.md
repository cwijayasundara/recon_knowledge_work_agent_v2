---
name: recipe-authoring
description: The recipe contract, the onboarding_sdk API a recipe may use, and worked examples for non-standard layouts.
---

# Recipe authoring

A recipe is a Python module that turns one upload layout into the canonical
Affiliate table. It must pass `python -m onboarding_sdk.recipes check`.

## Contract

```python
RECIPE = {
    "entity": "affiliate",
    "sdk": "0.1.0",
    "summary": "one sentence: what the recipe reads",
    "bindings": {"affiliate_id": "<column or None>", "affiliate_name": "<column>"},
}


def prepare(wb: Workbook) -> AffiliateCanonical: ...
```

- Use the bindings in `/ref/bindings.json`. Never invent a column.
- Imports allowed: `onboarding_sdk`, `re`, `datetime`, `polars`, `math`,
  `decimal`, `string`, `itertools`, `functools`, `collections`, `typing`,
  `dataclasses`, `unicodedata`, `enum`. No `os`, files, network, `open`,
  `eval`, `getattr` or dunder attributes.
- Deterministic: two runs give the same table.
- Every row keeps lineage: `source_sheet` and `source_row` (1-based sheet row).
- Record rows you skip in `dropped` with a reason.
- Do not clean or fix values: blanks stay blank, the rules judge them.

## SDK

```python
from onboarding_sdk.read import Workbook  # wb.sheets, wb.sheet(name), wb.select(name)

# Sheet: .name, .grid, .max_row, .row(n) -> list of values, .table(header_row) -> Table
# Table: .columns, .rows() -> RowView(row_number, get(column)), .dropped
from onboarding_sdk.canonical import AffiliateCanonical, AffiliateRow, Dropped, from_table
from onboarding_sdk.read import text  # cell value -> trimmed str or None
```

## Loop

1. `python -m onboarding_sdk.inspect /in/<file>` to see the profile.
2. `cat /ref/bindings.json`.
3. Write `/work/recipe.py` (start from an example in `examples/`).
4. `python -m onboarding_sdk.recipes check /work/recipe.py /in/<file>`.
5. Fix and repeat until `"ok": true` (at most 5 attempts).

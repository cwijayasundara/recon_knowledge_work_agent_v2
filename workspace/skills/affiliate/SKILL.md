---
name: affiliate
description: Affiliate (Investran → Sage Intacct) rules and finding codes, and what each finding means to an analyst.
---

# Affiliate

The full process flow is in `references/flow.md`. The rules run in code
(`onboarding_sdk.entities.affiliate`); you explain them, you never apply them.

## Output

`Affiliates.csv`: `ITEM_ID, NAME, ITEM_TYPE, DESCRIPTION, DONOTIMPORT`,
UTF-8 without BOM. ITEM_TYPE defaults to `Inventory`.

## Findings and what to tell the analyst

| Code | Severity | Meaning | Typical fix (typed change) |
|---|---|---|---|
| `AFF_ERR_ITEM_ID_BLANK` | ERR | No ID and no name to derive one from | `exclude_row` if the row is empty, else `override_item_id` |
| `AFF_ERR_ITEM_ID_TOO_LONG` | ERR | Supplied ID over 30 characters | `override_item_id` with a ≤30-char ID |
| `AFF_ERR_ITEM_ID_DUPLICATE` | ERR | Two different affiliates share an ID | `override_item_id` on one of them |
| `AFF_ERR_ITEM_ID_TRUNCATION_COLLISION` | ERR | Two derived IDs collide after truncation to 30 | `override_item_id`; there is no auto-suffix |
| `AFF_ERR_NAME_BLANK` | ERR | An ID with no name | `exclude_row`, or fix the source |
| `AFF_WARN_ITEM_ID_DERIVED` | WARN | ID derived from the name | `acknowledge_finding` after checking the ID |
| `AFF_WARN_ITEM_ID_CHARS_STRIPPED` | WARN | `'` or `&` removed while deriving | `acknowledge_finding` or `override_item_id` |
| `AFF_WARN_NAME_TRUNCATED` | WARN | Name over 100 characters; NAME keeps the first 100 | `acknowledge_finding` |
| `AFF_WARN_ITEM_TYPE_OVERRIDE` | WARN | ITEM_TYPE set to Non-Inventory | `acknowledge_finding` to confirm intent |
| `AFF_WARN_ZERO_RECORDS` | WARN | The file has a header and no rows | `acknowledge_finding` ("no affiliates this engagement") |
| `AFF_INFO_ROW_EXCLUDED` | INFO | Row marked `DONOTIMPORT='#'` | none |

Errors cannot be acknowledged; they must be fixed. Every warning needs an
acknowledgement, per row.

## Typed changes

`set_item_type(value, rows?)`, `override_item_id(row, value)`,
`exclude_row(row, reason)`, `acknowledge_finding(code, row)`,
`set_sheet`, `set_header_row`, `set_column_binding(field, column)`,
`request_recipe_revision(instruction)`. `row` is the record number in the
preview (1 = first data row), not the spreadsheet row.

An instruction that maps to no typed change (for example "amounts are
signed" on an Affiliate file, which has no amounts) is restated as "no
applicable change" with `applicable=false`.

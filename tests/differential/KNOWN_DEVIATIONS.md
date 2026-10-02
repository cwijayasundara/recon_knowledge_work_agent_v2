# Known deviations from the original `AffiliateProcessor`

The differential test excludes exactly these. Anything else that differs is a bug.

| Code / behaviour | Original | Ours | Why |
|---|---|---|---|
| `AFF_ERR_NAME_BLANK` | Not raised when an ID is present and the name is blank; the row renders with an empty NAME | Raised as a blocking ERR on that row | The flow lists "NAME blank" under ERR (docs/reference/affiliate-flow.md, Phase 3). Only raised when an ID exists, so a fully blank row still yields only `AFF_ERR_ITEM_ID_BLANK`, matching the golden expectations. |

## Extensions (no original equivalent; not exercised by the differential test)

- **Per-finding acknowledgement.** The original acknowledges by code. We acknowledge `(code, row)` pairs so an analyst confirms each derived ID. Acknowledging every raised pair reproduces the original's by-code behaviour, which is what the differential test does.
- **`id_overrides`**: the analyst's ITEM_ID edit in the preview grid. Treated as a supplied ID (length and uniqueness checked; no derived-ID warning).
- **`row_item_types`**: per-row `Non-Inventory` override, raising a row-scoped `AFF_WARN_ITEM_TYPE_OVERRIDE`.
- **`excluded_rows`**: `DONOTIMPORT='#'`. Excluded rows are rendered, not judged, do not take part in dedup, and carry an informational `AFF_INFO_ROW_EXCLUDED`.

# Affiliate static configuration: process-flow reference

Transcribed from the six-page "Affiliate Static Configuration — Upload Algorithm (Investran → Sage Intacct), MVP1 Reference Document" and the `Mapping_Inv Affiliate` tab of the static-data mapping workbook. This file is the authoritative text for the `affiliate` skill and the rules module. Where the two sources disagree, the settled decision is recorded under "Decisions".

## Scope and key rules

- One path: **Affiliate Load**. Phases: Upload & Identify → ID Generation & Dedup → Map & Quality Assurance → Transform & Output.
- "Affiliate data is low-volume (typically 2–3 records): GP, Management Company, related entities. Often manually entered directly in Intacct by the onboarding team."
- "Affiliates are GLOBAL in Intacct, not entity-scoped. One Affiliates.csv covers all entities for the client."
- Typical source: a simple ID + Name list prepared by the onboarding team. (Deriving affiliates from GL data is out of scope for the MVP.)
- Inherit the client-provided Affiliate ID. If there is none, derive it from the affiliate name. Rule: strip non-alphanumeric, uppercase, collapse consecutive underscores, truncate to 30 characters, flag for review.
- A duplicate ITEM_ID within the batch is a **blocking error**. The analyst resolves it manually. There is **no auto-suffix**.
- A zero-record input is valid (not every engagement has affiliates), but it raises a warning that must be acknowledged.
- Output is `Affiliates.csv` (UTF-8, no BOM), imported manually into Intacct: Company → Import Data → Inventory Affiliates.

## Phase 1: Upload & Identify

1. **Analyst** uploads the source file (CSV, XLSX or XLS).
2. **System** detects the sheet count and headers. A single sheet is auto-selected. For a multi-sheet workbook, the analyst confirms the sheet containing affiliate data.
3. **System** identifies candidate columns for Affiliate ID and Affiliate Name.
4. **Analyst** confirms or overrides the Affiliate ID column. The options are Affiliate ID (suggested), Affiliate Name (use when there is no ID column; the ID is derived) and "Other column…".
5. **Analyst** confirms or overrides the Affiliate Name column.
6. Column choices are saved.

## Phase 2: ID Generation & Dedup

- ITEM_ID is the primary identifier: at most 30 characters, unique within the batch.
- **Option A**: use the source Affiliate ID directly. IDs must be 30 characters or fewer, and the analyst confirms them in preview.
- **Option B**: derive the ID from the Affiliate Name. The analyst confirms or edits each generated ID in preview.
- **Within-batch dedup** collapses to one record per ITEM_ID. This includes truncation collisions, where two different names produce the same 30-character ID. Collisions block export, and the analyst edits the conflicting ITEM_ID in the preview grid.
- The preview grid shows ITEM_ID, NAME and the derivation method. The analyst may edit any ITEM_ID, and the system re-checks uniqueness after each edit.

## Phase 3: Map & Quality Assurance

- ITEM_ID comes from Phase 2, NAME is direct, ITEM_TYPE is `Inventory` by default, DESCRIPTION is blank, and DONOTIMPORT is blank or `#`.
- Match rule: "Known → auto · Similar → suggest · New → review."

| Intacct field | Required | Source / rule | Confidence | Action |
|---|---|---|---|---|
| ITEM_ID | Yes | From Phase 2 (inherited or derived, ≤30 chars) | High | Auto / Confirm |
| NAME | Yes | Affiliate Name, truncated at 100 chars | High | Auto |
| ITEM_TYPE | Yes | `Inventory` (default) | High | Auto |
| DESCRIPTION | No | Blank | High | Auto |
| DONOTIMPORT | No | Blank or `#` | High | Auto |

**ERR (blocks transformation):** ITEM_ID blank for any row · ITEM_ID over 30 characters · duplicate ITEM_ID within the batch, including truncation collisions · NAME blank.

**WARN (analyst must acknowledge):** ITEM_ID derived from name ("confirm generated ID is appropriate") · NAME over 100 characters ("will be truncated") · ITEM_TYPE overridden to Non-Inventory ("confirm intent") · zero records ("confirm no affiliates needed for this engagement").

**Gate:** the analyst confirms or overrides field matches, resolves all ERR and acknowledges all WARN before Phase 4. Mappings are saved.

## Phase 4: Transform & Output

- **System**: Affiliate ID → ITEM_ID (inherited or derived, ≤30) · Affiliate Name → NAME (truncated at 100) · ITEM_TYPE = Inventory · DESCRIPTION blank.
- **Analyst final review**: approves the transformed list before export. They may override ITEM_TYPE to Non-Inventory for specific rows, and may exclude rows with `DONOTIMPORT='#'`.
- **Output**: the Intacct Affiliates upload template.
- Sample rows: `GP-FUND-I / GP Fund I LLC`, `MGMT-CO / Management Company LLC`, `REL-ENT-A / Related Entity Alpha LP`.

## Mapping workbook: `Mapping_Inv Affiliate`

| Target | Source | Type | Logic | Mandatory |
|---|---|---|---|---|
| DONOTIMPORT | – | – | Blank, or `#` for records needing attention; rows starting with `#` are ignored on import | No |
| ITEM_ID | Affiliate Id / Affiliate Name | Transform | If Affiliate Id is not found, derive the ID from Affiliate Name; truncate to 30 characters. Alphanumeric and underscore | Yes |
| NAME | Affiliate / Affiliate Name | Direct | Length 100 | Yes |
| DESCRIPTION | – | – | Leave blank | No |
| ITEM_TYPE | – | Hardcoded | (sheet shows "Non-Inventory") | Yes |

## Decisions

- **Column name:** `ITEM_TYPE` (not `ITEMTYPE`). Our ontology copy uses `ITEM_TYPE`.
- **Default value:** `Inventory` as in the flow document, with `Non-Inventory` as an acknowledged override (`AFF_WARN_ITEM_TYPE_OVERRIDE`). The mapping sheet's hardcoded `Non-Inventory` is treated as superseded; confirm with the business if in doubt.
- **Derived-ID characters:** characters outside `[A-Z0-9_]` are stripped, and `AFF_WARN_ITEM_ID_CHARS_STRIPPED` requires acknowledgement.
- **GL-derived affiliates:** out of scope for the MVP.
- **Finding codes** (unchanged from the existing processor): `AFF_ERR_ITEM_ID_BLANK`, `AFF_ERR_ITEM_ID_TOO_LONG`, `AFF_ERR_ITEM_ID_DUPLICATE`, `AFF_ERR_ITEM_ID_TRUNCATION_COLLISION`, `AFF_WARN_ITEM_ID_DERIVED`, `AFF_WARN_ITEM_ID_CHARS_STRIPPED`, `AFF_WARN_NAME_TRUNCATED`, `AFF_WARN_ZERO_RECORDS`, `AFF_WARN_ITEM_TYPE_OVERRIDE`.

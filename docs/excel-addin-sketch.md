# Excel add-in sketch: task-pane flow against the workbench API

Status: sketch, not a build plan. Written against `src/onboarding_agent/surfaces/api.py`, the `GateResponse` contract (`graph/state.py`) and the typed changes (`onboarding_sdk/changes.py`). Not verified: that the backend emits every SSE event listed in `docs/ui-spec.md` §8. Check before building on them.

Decisions behind it: Excel users can send sponsor data to our API (confirmed), and the pain we target is **messy source files**, which our recipe engineer handles.

## Key design choice: send the file, not ranges

The add-in uploads the **whole workbook as a file** to `POST /runs`, using `Office.context.document.getFileAsync(Compressed)`.

- The sha256, fingerprint, recipe and manifest all stay as they are.
- The recipe engineer and sandbox see the real file, including titled sheets and multi-sheet layouts.
- The add-in needs no new intake logic.

The user's open sheet is only used for the pane's picks and highlights. The server stays the source of truth.

## Task-pane flow

```
┌ Pane ────────────────────────────┐        ┌ API ──────────────────────────────┐
│ 0 Sign in (Entra SSO)            │───────▶│ actor header / Easy Auth          │
│   Sponsor picker                 │◀───────│ GET /sponsors                     │
│                                  │        │                                   │
│ 1 "Onboard this workbook"        │ file   │ POST /runs (sponsor, entity, file)│
│   getFileAsync → upload          │───────▶│  → 202 {run_id}                   │
│   progress ← events              │◀──SSE──│ GET /runs/{id}/events             │
│                                  │        │                                   │
│ 2 Brief + questions              │◀──SSE──│ brief / question events           │
│   sheet?  header row? columns?   │───────▶│ POST /runs/{id}/gate              │
│   (click a tab/cell = answer)    │        │  {action:"answer", question_id,   │
│   highlight proposed header/cols │        │   option}                         │
│   in the user's own sheet        │◀───────│ GET /runs/{id}/grid?view=source   │
│                                  │        │                                   │
│ 3 Approve brief                  │───────▶│ gate {action:"approve"}           │
│   (agent builds; recipe sandbox) │◀──SSE──│ step / tool / report / findings   │
│                                  │        │                                   │
│ 4 Review sheet (generated)       │◀───────│ GET /runs/{id}/grid?view=preview  │
│   ITEM_ID, NAME, ITEM_TYPE,      │        │  (lineage, flags, id_method)      │
│   flags, source_row              │        │                                   │
│   edit ITEM_ID cell ─ onChanged  │───────▶│ POST /runs/{id}/dry-run           │
│     → impact shown in pane       │◀───────│  {impact, violations}             │
│   Apply                          │───────▶│ gate {action:"change", changes}   │
│   Acknowledge warn / exclude     │───────▶│  acknowledge_finding / exclude_row│
│                                  │        │                                   │
│ 5 Sign off                       │───────▶│ gate {action:"approve"}  (blocked │
│   disabled until gate allows     │◀──SSE──│  unless gate event allows it)     │
│   download Affiliates.csv        │◀───────│ GET /runs/{id}/artifacts/{name}   │
└──────────────────────────────────┘        └───────────────────────────────────┘
```

## Where Excel adds the most for messy files

- **Header and layout questions:** when the agent asks "which row is the header?" or "which sheet?", the pane selects that range or tab in the user's own workbook. The user confirms with a click, using `source` grid rows and `header_row`.
- **Column bindings:** the proposed ID and Name columns are highlighted. If the user disagrees, they click another column, which sends `set_column_binding`.
- **Lineage:** `source_sheet` and `source_row` per output row let a click on a Review row jump to the source cell.
- **History replay:** a repeat layout for the same sponsor shows "matches saved layout, zero model calls" and skips most questions.

## The Review sheet is a view, not state

The add-in writes the `preview` grid into a protected "Review" sheet. Edits to `ITEM_ID` are intercepted with `worksheet.onChanged`:

1. Revert the cell optimistically.
2. Call `dry-run` with `override_item_id {row, value}`.
3. Show impact and policy violations in the pane.
4. On Apply, send a `change` gate and re-render from the server.

Acknowledgements and approvals are pane buttons that post gates, never cell edits. This keeps the rule that agents and users can't bypass gates by editing cells. The Review sheet can be re-rendered at any time, so a deleted warning row costs nothing.

Typed changes available today: `set_sheet`, `set_header_row`, `set_column_binding`, `set_item_type`, `override_item_id`, `exclude_row`, `acknowledge_finding`, `request_recipe_revision`.

## API changes needed

| Gap | Fix |
|---|---|
| **Auth** | The API reads `x-ms-client-principal-name` when `trust_easy_auth` is on. Turn that on behind Entra and use `Office.auth.getAccessToken` (SSO) from the pane. |
| **CORS** | Add the add-in origin to `cors_origins`. |
| **SSE** | `EventSource` can't set headers, but the API already accepts `access_token` and `actor` as query params. A fetch-based stream parser avoids tokens in URLs. |
| **Hosting** | The add-in needs an HTTPS host and a manifest. Azure Static Web Apps is simplest. |
| **Review-sheet writeback** | No change. `/grid` is paged at 500, which is plenty for Affiliate. Larger entities will need batching. |
| **Download** | Risk: file downloads from task panes are inconsistent on Excel desktop. Spike `displayDialogAsync` or opening the artifact URL in the browser. |

## Spike order

1. Hello-world pane that signs in and lists sponsors.
2. `getFileAsync` upload, then SSE progress. This proves intake with messy files.
3. Question cards driven by `gate` answers, with range highlighting.
4. The Review sheet and `onChanged` to `dry-run` loop.
5. Sign-off gate and CSV download.

Steps 1–2 validate the riskiest parts (auth and file transfer) first.

# Workbench UI spec: Affiliate onboarding

Visual reference: `docs/ui-mockup.html`. Source of truth for structure: the Affiliate process-flow document (`docs/reference/affiliate-flow.md`, transcribed from `string_matcher_v1/docs/full_flows/affiliate/`).

## 1. Concept: the UI is the process-flow document, made live

Analysts already know the flow document page by page. The workbench reproduces it: the same header band, the same phases (drawn as a workflow diagram with their approval gates), the same colour legend, and each phase as the same vertical sequence of step boxes joined by arrows, one phase per tab. The difference is that every box is live. System boxes show what the agent actually found, analyst boxes are the controls, risk boxes list the real errors, and output boxes confirm what was saved or generated.

Rules for faithfulness:

- **Step titles use the document's wording**, for example "System reads file — detects sheet count and column headers", "Collisions are blocking errors — analyst must resolve manually before export", "Gate before Phase 4".
- **Colours follow the document's legend:**
  - System / Automated (blue), which in this product includes the agent;
  - Analyst / Human Action (red);
  - Output / Success (green);
  - Risk / Warning (dark red);
  - Decision prompts (amber), as used for "ID generation logic" in the document.
- **Phase colours follow the document's process-phase table:** Phase 1 teal, Phase 2 blue, Phase 3 amber, Phase 4 green.
- **Option lists look like the document's**: radio rows with a green **Suggested** tag and an amber **Manual** tag ("Other column…"), plus "View all columns in this file".

## 2. Page structure

```
┌ Header band ─ "Affiliate Load · Affiliates are global — one file per fund complex" ── PHASE n — NAME  ● ○ ○ ○ ┐
│ sponsor · run · file · history status                                                                          │
├ Workflow: [Phase 1] ◇ Brief gate → [Phase 2] → [Phase 3] ◇ Findings gate → [Phase 4] ◇ Sign-off gate ─────────┤
├ Colour legend (one line) ──────────────────────────────────────────────────────────────────────────────────────┤
├ [Phase 1] [Phase 2] [Phase 3] [Phase 4]  (tabs) ─────────────────────┬ Copilot (sticky) ───────────────────────┤
│ the selected phase's step boxes + arrows                             │ activity ticker                          │
│                                                                      │ explanation / question / change cards    │
│                                                                      │ "Tell the agent…"                        │
├ Decision ledger ─────────────────────────────────────────────────────┴──────────────────────────────────────────┤
```

- The workflow diagram is generated from the flow definition: one node per phase, and a gate diamond after every phase that declares a `gate`. Nodes show live phase state; gates show waiting / passed (with the approver) / skipped when history was recalled. The run's current phase is marked "You are here"; a locked run ends in a lock.
- Each phase is a tab. The shown tab follows the run's current phase (the header band's phase title and dots track it too). Picking another tab, or a diagram node, pins that tab until the run advances or the analyst uses the "Run is now at Phase n →" link. Inactive panels stay mounted, so edits in progress survive a tab switch.
- Completed phases stay available as the record of what was decided. Future phases are selectable but dimmed, with a "Opens after the Phase n gate" state.
- Tabs follow the WAI-ARIA tabs pattern: arrow keys, Home and End move between them.
- Below 1100px the copilot becomes a drawer. Below 700px the diagram stacks vertically and the tabs drop the phase names.

## 3. Phase-by-phase mapping

Each row is one box in the document, in order.

### Phase 1 — Upload & Identify

| Document box | Type | Live content | Controls |
|---|---|---|---|
| Upload source file (CSV, XLSX, XLS) | Analyst | File name, columns, rows, hash | Drop zone / replace file |
| System reads file — detects sheet count and column headers | System (agent) | Sheets found; the chosen sheet and header row; each candidate column with its evidence (sample values, pattern such as `AFF_\d{4}`, id-like or name-like) | If several sheets qualify, a **question card inside this box** asks which one |
| Select the column for Affiliate ID — system highlights best candidate · analyst confirms or overrides | Analyst | Options exactly as the document: the suggested column; Affiliate Name ("use if no ID column — system will derive ID from name"); Other column… (Manual). Each suggestion shows its provenance: `history ×n`, `ontology alias`, `fuzzy 0.93`, `llm`, `agent` | Radio select; "View all columns in this file" |
| Select the column for Affiliate Name | Analyst | Same pattern | Radio select |
| Column choices saved | Output | "Written to Sponsor A history (n bindings)" after confirmation | — |

The **brief gate** is passed when the analyst confirms the column choices. The agent's summary of the brief appears in the copilot. On a returning sponsor with a history match, Phase 1 arrives pre-completed with a "Recalled from history" note.

### Phase 2 — ID Generation & Dedup

| Document box | Type | Live content | Controls |
|---|---|---|---|
| ID generation logic — how should Affiliate ID (ITEM_ID) be assigned? | Decision prompt | Rule text (≤30 characters, unique in batch) | — |
| ID Assignment Options | Analyst | A. Use source Affiliate ID directly · B. System derives from Affiliate Name. The agent marks its recommendation as Suggested and explains mixed cases (e.g. "rows 5–7 have no ID, so B applies to them") | Radio select, which produces a change proposal with impact |
| Within-batch dedup — collapse to one record per ITEM_ID | System | Rows scanned, duplicates, truncation collisions, with row numbers | — |
| Collisions are blocking errors — analyst must resolve manually before export | Risk | "No auto-suffix is applied." Count of open collisions | "Ask copilot for a suggestion" |
| Analyst reviews deduped list, resolves any ID collisions | Analyst | **Preview grid**: row, name, ITEM_ID, method (source / derived / override), flags. Derivation diff: stripped characters struck through, amber ruler at 30, faded cut tail. A red edge marks rows sharing an ID | Inline ITEM_ID edit with live validation (≤30, `[A-Z0-9_]`, unique) via debounced dry-run |

### Phase 3 — Map & Quality Assurance

| Document box | Type | Live content | Controls |
|---|---|---|---|
| Map source columns to Intacct Affiliate template fields | Decision prompt | "ITEM_ID from Phase 2 · NAME direct · ITEM_TYPE 'Inventory' · DESCRIPTION blank · DONOTIMPORT blank or '#'" | — |
| Match Source Columns → Intacct Fields | System | The document's table: Intacct field, Req?, Source / Logic, Conf, Act | Override a row (rare) |
| Data Quality Flags — ERR / WARN | Risk | The document's two-band panel. ERR band: "blocks transformation (must resolve before proceeding)". WARN band: "non-blocking · analyst must acknowledge". Each flag shows affected rows and the agent's proposed fix | ERR: fix actions (Edit ID, Exclude row, Apply fix). WARN: Acknowledge (per flag or per code, with note) |
| Gate before Phase 4 | Analyst | "Analyst confirms / overrides each field match · resolves all ERR flags · acknowledges WARN flags" | **Pass gate**, disabled until the conditions hold; its tooltip lists what remains |
| Mappings saved to DB | Output | "Auto-recalled for Sponsor A next time" | — |

### Phase 4 — Transform & Output

| Document box | Type | Live content | Controls |
|---|---|---|---|
| Transform each field on the affiliate list | System | The document's rule line, plus the counts transformed | — |
| Final review — analyst approves transformed list before export | Analyst | "May override ITEM_TYPE to 'Non-Inventory' for specific rows. May exclude rows via DONOTIMPORT = '#'" | Per-row ITEM_TYPE override (raises the ack warning); DONOTIMPORT toggle with reason |
| Intacct Affiliates Upload Template — Output Preview | Output | The exact 5-column template. Any cell opens its lineage popover (source row, rule id, last decision) | — |
| Generate Intacct Affiliates Upload Template | Output (primary button) | Sign-off: checklist, approver, then generation of `Affiliates.csv`, `review.xlsx` and `manifest.json` | **Generate** = sign off & lock |

## 4. Agent presence inside the flow

- Boxes done by the agent carry an **Agent** badge and a "Why?" disclosure with its reasoning and evidence.
- Questions appear **inside the box they belong to**, for example the sheet question in "System reads file" or the duplicate-ID question in "Analyst reviews deduped list". They are mirrored in the copilot.
- A box the agent is currently working on shows a thin animated border and a line such as "Checking Sponsor A history…". This is driven by SSE `tool` events.

## 5. Copilot panel

A sticky panel on the right that acts as a conversation thread:

| Card | Contents | Actions |
|---|---|---|
| Explanation | Why a flag fired, in business language, tagged with its phase and rows | Jump to rows |
| Question | 2–4 options with evidence | Pick; "Other…" |
| Change proposal | Restated typed change, impact (rows changed, flags added or removed), policy violations | Apply · Cancel |
| Brief (Phase 1) | Bindings with provenance, ID strategy, recipe type, expected flags | Confirm (same as the Phase 1 confirmation) |

The composer "Tell the agent…" always yields an explanation or a change proposal, never a silent change.

## 6. Decision ledger

A timeline under the flow, coloured with the legend: blue for system/agent, red for the analyst, green for output. Each entry records time, actor, what was decided, source (history / alias / fuzzy / llm / agent / analyst) and affected rows. It is exportable, and becomes part of `manifest.json` at generation.

## 7. Keyboard

`J`/`K` next/previous flag · `A` acknowledge · `E` edit ITEM_ID · `P` preview impact · `Enter` apply · `G` then `1–4` open that phase's tab · `/` composer · `?` help.

## 8. Data contracts (frontend ↔ API)

- **SSE** `GET /runs/{id}/events`:
  - `phase {phase, state, counts, summary}`
  - `step {phase, step_id, state, content}`: fills the live content of a document box
  - `agent_message {id, delta}`
  - `tool {name, status, label, step_id}`
  - `question {id, step_id, text, options, evidence}`
  - `brief {…}`
  - `report {…}`
  - `findings {items}`
  - `gate {gate, allowed_actions, blocked_reasons}`
  - `change_impact {changes, impact, violations}`
  - `decision {entry}`
  - `artifact {name, url}`
  - `error {message}`
- **Step ids** are fixed per the document: `p1.upload`, `p1.read`, `p1.select_id`, `p1.select_name`, `p1.saved`, `p2.logic`, `p2.options`, `p2.dedup`, `p2.collisions`, `p2.review`, `p3.map`, `p3.match_table`, `p3.dq`, `p3.gate`, `p3.saved`, `p4.transform`, `p4.final_review`, `p4.preview`, `p4.generate`. The backend emits `step` events against these ids, so adding an entity means adding its step catalogue, not new screens.
- **REST:**
  - `POST /runs/{id}/gate` (`GateResponse`)
  - `POST /runs/{id}/dry-run` (typed changes → impact; used for live validation)
  - `GET /runs/{id}/grid?view=ids|preview`, with per-cell lineage
  - `GET /sponsors/{id}/history`

## 9. Reuse across entities

The page is generated from a **flow definition**: `workspace/flows/affiliate.flow.yaml` lists phases, then boxes (id, type, title from the document, lens component). The Investor (four paths), Vendor, Investment, Commitment and GL flows become new flow files plus any new lens components. The shell, legend, copilot and ledger stay the same.

```yaml
entity: affiliate
title: Affiliate Load
subtitle: Affiliates are global — one file per fund complex
phases:
  - id: p1
    name: Upload & Identify
    colour: teal
    steps:
      - {id: p1.upload, type: analyst, title: "Upload source file (CSV, XLSX, XLS)", lens: upload}
      - {id: p1.read, type: system, title: "System reads file — detects sheet count and column headers", lens: sheet_detect}
      - {id: p1.select_id, type: analyst, title: "Select the column for Affiliate ID", lens: column_choice, field: affiliate_id}
      - {id: p1.select_name, type: analyst, title: "Select the column for Affiliate Name", lens: column_choice, field: affiliate_name}
      - {id: p1.saved, type: output, title: "Column choices saved", lens: saved}
  # p2 … p4 as in section 3
```

## 10. Visual language and build notes

- Header band and table headers in deep navy, as in the document. Surfaces are calm; colour is used only for actor and state. Light and dark themes via CSS variables, WCAG AA, visible focus rings, reduced motion honoured.
- Type: IBM Plex Sans (UI), IBM Plex Mono (IDs, codes, step ids), Source Serif 4 (phase headings).
- Stack: Next.js 16 (App Router), React 19, TypeScript, TanStack Table, Tailwind v4 with CSS-variable tokens, `EventSource` for SSE, a single run store fed by events.
- Components: `FlowShell`, `WorkflowDiagram`, `Legend`, `PhaseSection`, `StepBox(type)`, `Arrow`, `OptionList`, `IdPreviewGrid`, `DerivationDiff`, `MatchTable`, `DqPanel`, `GateBar`, `TemplatePreview`, `LineagePopover`, `Copilot`, `ChangeCard`, `QuestionCard`, `DecisionLedger`.
- Tests: Playwright e2e against the API with the scripted model; visual snapshots of each phase.

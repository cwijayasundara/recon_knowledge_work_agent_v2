"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { activePhase, phaseState } from "@/lib/phases";
import type { Finding, Flow, FlowStep, Snapshot, TypedChange } from "@/lib/types";
import { useRun, type RunStore } from "@/lib/useRun";
import { Copilot } from "./Copilot";
import { DecisionLedger } from "./DecisionLedger";
import { Legend } from "./Legend";
import { ColumnChoice } from "./lenses/ColumnChoice";
import { DqPanel } from "./lenses/DqPanel";
import { GateBar } from "./lenses/GateBar";
import { IdPreviewGrid } from "./lenses/IdPreviewGrid";
import { MatchTable } from "./lenses/MatchTable";
import { FinalReview, TemplatePreview } from "./lenses/TemplatePreview";
import { Arrow, StepBox } from "./StepBox";
import { WorkflowDiagram } from "./WorkflowDiagram";

const RULE_TEXT: Record<string, string> = {
  "p2.logic": "ITEM_ID is the primary identifier for an affiliate in Intacct. Maximum 30 characters. Must be unique within the batch.",
  "p3.map": "ITEM_ID from Phase 2 · NAME direct · ITEM_TYPE 'Inventory' · DESCRIPTION blank · DONOTIMPORT blank or '#'",
  "p4.transform": "Affiliate ID → ITEM_ID (inherited or derived, ≤30) · Affiliate Name → NAME (truncated at 100) · ITEM_TYPE = Inventory · DESCRIPTION blank.",
};
const WHO: Record<string, "agent" | "you" | "system" | null> = { system: "agent", analyst: "you", output: null, risk: null, decision: null };

interface LensProps {
  store: RunStore;
  snap: Snapshot;
  step: FlowStep;
  runId: string;
  ui: UiState;
}
interface UiState {
  selected: number | null;
  setSelected: (r: number | null) => void;
  editing: number | null;
  setEditing: (r: number | null) => void;
  activeFlag: number;
  focusComposer: (text?: string) => void;
  showPhase: (phase: number) => void;
}

function Lens({ store, snap, step, runId, ui }: LensProps) {
  const gate = snap.pending?.gate;
  const busy = store.busy;
  const change = (changes: TypedChange[]) => store.respond({ action: "change", changes });
  const findings: Finding[] = snap.result?.findings ?? [];
  const collisions = findings.filter((f) => f.code.includes("DUPLICATE") || f.code.includes("COLLISION"));
  const live = store.steps[step.id];
  switch (step.lens) {
    case "upload": {
      const c = store.steps["p1.upload"]?.content as { bytes?: number } | undefined;
      return <div className="live"><b>{snap.upload.name}</b>{snap.result ? ` · ${snap.result.rows_emitted} data rows` : snap.brief?.source.rows_emitted ? ` · ${snap.brief.source.rows_emitted} data rows` : ""}{c?.bytes ? ` · ${c.bytes} bytes` : ""}{snap.upload.sha256 ? ` · sha ${snap.upload.sha256.slice(0, 8)}…` : ""}</div>;
    }
    case "sheet_detect": {
      const sheets = (store.steps["p1.upload"] && (store.steps["p1.read"]?.content.sheets as { name: string; rows: number; header_row: number }[] | undefined)) ?? [];
      const layout = snap.layout ?? (snap.brief ? { sheet: snap.brief.source.sheet, header_row: snap.brief.source.header_row } : null);
      const questions = snap.brief?.questions.filter((q) => q.target === "sheet" || q.target === "header_row") ?? [];
      return (
        <>
          <div className="live">
            {sheets.length > 0 && <>{sheets.length === 1 ? "Single sheet → auto-selected. " : `${sheets.length} sheets: ${sheets.map((s) => `${s.name} (${s.rows} rows)`).join(", ")}. `}</>}
            {layout ? <>Using <b>{layout.sheet}</b>, header on row {layout.header_row}. </> : "Reading the file… "}
            {snap.brief?.bindings.map((b) => b.column && <span key={b.field}><b>{b.column}</b> ({b.evidence || b.field}). </span>)}
            {snap.replay && <b>Recalled from history.</b>}
          </div>
          {questions.map((q) => (
            <div className="optlist" key={q.id} role="radiogroup" aria-label={q.text}>
              <div className="q">{q.text} <span>{q.evidence}</span></div>
              {q.options.map((o) => (
                <button key={o} className="opt" role="radio" aria-checked={false} disabled={busy || gate !== "brief"} onClick={() => store.respond({ action: "answer", question_id: q.id, option: o })}>
                  <span className="r" /><span>{o}</span><span />
                </button>
              ))}
            </div>
          ))}
        </>
      );
    }
    case "column_choice":
      if (!snap.brief) return null;
      return <ColumnChoice snap={snap} field={step.field as "affiliate_id" | "affiliate_name"} enabled={gate === "brief" && !busy}
        onChange={(column) => change([{ kind: "set_column_binding", field: step.field!, column }])} />;
    case "saved":
      if (step.id === "p1.saved") {
        const n = Object.values(snap.bindings ?? {}).filter(Boolean).length;
        // A layout change sends the run back to the brief gate, so the gate wins over "saved".
        if (gate !== "brief" && snap.replay) return <div className="saved">Recalled from {snap.sponsor_id} history · no questions</div>;
        if (gate !== "brief" && snap.approvers.some((a) => a.gate === "brief")) return <div className="saved">Column choices saved · written to {snap.sponsor_id} history ({n} bindings)</div>;
        return (
          <GateBar label="Brief gate" conditions="confirm the sheet and both column choices" testId="approve-brief"
            reasons={snap.pending?.gate === "brief" ? snap.pending.blocked_reasons : []} enabled={gate === "brief"} busy={busy} action="Confirm column choices"
            onPass={() => store.respond({ action: "approve" })} />
        );
      }
      return snap.approvers.some((a) => a.gate === "findings") && gate !== "findings"
        ? <div className="saved">Mappings saved · auto-recalled for {snap.sponsor_id} next time</div>
        : <div className="live">Saved when the Phase 3 gate passes.</div>;
    case "rule_text":
      return <span className="sd">{RULE_TEXT[step.id]}{step.id === "p4.transform" && snap.result ? ` ${snap.result.rows_emitted} rows transformed.` : ""}</span>;
    case "id_options": {
      const strategy = snap.brief?.id_strategy;
      const derived = store.grid.filter((r) => r.id_method === "derived").map((r) => r.row);
      return (
        <div className="optlist" role="radiogroup" aria-label="ID assignment option">
          <div className="q">ID Assignment Options <span>— recommendation from the brief</span></div>
          <div className="opt" role="radio" aria-checked={strategy !== "derive_from_name"}><span className="r" />
            <span><b>A. Use source Affiliate ID directly</b> — IDs must be ≤30 characters.{derived.length > 0 && strategy !== "derive_from_name" ? ` Rows ${derived.join(", ")} have no ID, so B applies to them.` : ""}</span>
            {strategy !== "derive_from_name" ? <span className="tag sug">Suggested</span> : <span />}</div>
          <div className="opt" role="radio" aria-checked={strategy === "derive_from_name"}><span className="r" />
            <span><b>B. System derives from Affiliate Name</b> — strip non-alphanumeric, uppercase, collapse underscores, truncate to 30.</span>
            {strategy === "derive_from_name" ? <span className="tag sug">Suggested</span> : <span />}</div>
        </div>
      );
    }
    case "dedup_stats":
      if (!snap.result) return <div className="live">Runs after the Phase 1 gate.</div>;
      return <div className="live">{store.grid.length} rows scanned · <b>{collisions.filter((c) => c.code.includes("DUPLICATE")).length} duplicate(s)</b> · <b>{collisions.filter((c) => c.code.includes("COLLISION")).length} truncation collision(s)</b>{collisions.length ? ` (rows ${collisions.map((c) => c.row).join(", ")})` : ""}</div>;
    case "collisions":
      return (
        <div className="acts" style={{ alignItems: "center" }}>
          <span className="sd">No auto-suffix is applied. {collisions.length} open collision(s). Edit the conflicting ITEM_ID in the grid below.</span>
          <button className="btn" disabled={!collisions.length || gate !== "findings"} onClick={() => ui.focusComposer(`Suggest unique IDs for rows ${collisions.map((c) => c.row).join(", ")}`)}>Ask copilot for a suggestion</button>
        </div>
      );
    case "id_preview_grid":
      if (!store.grid.length) return null;
      return <IdPreviewGrid runId={runId} rows={store.grid} editable={gate === "findings" && !busy} selected={ui.selected} onSelect={ui.setSelected}
        editing={ui.editing} setEditing={ui.setEditing} onApply={(c) => change([c])} />;
    case "match_table":
      return snap.result ? <MatchTable snap={snap} /> : null;
    case "dq_panel":
      return snap.result ? <DqPanel findings={findings} report={snap.report} enabled={gate === "findings" && !busy} active={ui.activeFlag} onChange={change}
        onEdit={(row) => { ui.setEditing(row); ui.showPhase(2); requestAnimationFrame(() => document.getElementById("p2-review")?.scrollIntoView({ behavior: "smooth" })); }} /> : null;
    case "gate_bar":
      return <GateBar label="Gate before Phase 4" conditions="analyst confirms field matches · resolves all ERR flags · acknowledges WARN flags" testId="pass-findings"
        reasons={gate === "findings" ? snap.pending!.blocked_reasons : []} enabled={gate === "findings"} busy={busy} action="Pass gate"
        onPass={() => store.respond({ action: "approve" })} />;
    case "final_review":
      return store.grid.length ? (
        <>
          <span className="sd">May override ITEM_TYPE to &apos;Non-Inventory&apos; for specific rows. May exclude rows via DONOTIMPORT = &apos;#&apos;.{gate !== "findings" ? " Available while the Phase 3 gate is open." : ""}</span>
          <FinalReview rows={store.grid} enabled={gate === "findings" && !busy} onChange={change} />
        </>
      ) : null;
    case "template_preview":
      return store.grid.length ? <TemplatePreview rows={store.grid} decisions={snap.decisions} /> : null;
    case "generate": {
      const locked = snap.status === "locked";
      return (
        <div style={{ display: "grid", gap: 8 }}>
          <span className="sd">Sign-off: {snap.approvers.map((a) => `${a.gate} by ${a.actor}`).join(" · ") || "no approvals yet"}</span>
          {!locked && (
            <div className="acts">
              <button className="generate" data-testid="generate" disabled={gate !== "signoff" || busy} onClick={() => store.respond({ action: "approve" })}>
                Generate Intacct Affiliates Upload Template
              </button>
              {gate === "signoff" && <button className="btn" disabled={busy} onClick={() => store.respond({ action: "reject", reason: "back to review" })}>Back to review</button>}
            </div>
          )}
          {locked && (
            <div className="saved" data-testid="artifacts">
              Generated and locked:{" "}
              {snap.artifacts.map((a) => <a key={a.name} href={api.artifactUrl(runId, a.name)} style={{ marginRight: 10 }}>{a.name}</a>)}
            </div>
          )}
        </div>
      );
    }
  }
  return live ? <div className="live">{JSON.stringify(live.content)}</div> : null;
}

export function FlowShell({ runId }: { runId: string }) {
  const store = useRun(runId);
  const { snap } = store;
  const [flow, setFlow] = useState<Flow | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [activeFlag, setActiveFlag] = useState(0);
  const [help, setHelp] = useState(false);
  const composer = useRef<HTMLInputElement>(null);
  const goPending = useRef(false);
  // The shown tab follows the run's phase until the analyst picks another one; the run advancing resets that.
  const current = activePhase(snap);
  const [picked, setPicked] = useState<number | null>(null);
  const [followed, setFollowed] = useState(current);
  if (followed !== current) {
    setFollowed(current);
    setPicked(null);
  }
  const shown = picked ?? current;
  const showPhase = useCallback((n: number) => setPicked(n === current ? null : n), [current]);

  useEffect(() => { api.flow("affiliate").then(setFlow).catch(() => setFlow(null)); }, []);

  const flags = useMemo(() => {
    const f = snap?.result?.findings ?? [];
    return [...f.filter((x) => x.severity === "error"), ...f.filter((x) => x.severity === "warning")];
  }, [snap]);

  const ui: UiState = {
    selected, setSelected, editing, setEditing, activeFlag,
    focusComposer: (text) => {
      if (composer.current) {
        if (text) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(composer.current, text);
          composer.current.dispatchEvent(new Event("input", { bubbles: true }));
        }
        composer.current.focus();
      }
    },
    showPhase,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
      const gate = snap?.pending?.gate;
      if (goPending.current && /^[1-4]$/.test(e.key)) {
        goPending.current = false;
        showPhase(Number(e.key));
        return;
      }
      goPending.current = false;
      switch (e.key) {
        case "j": setActiveFlag((i) => Math.min(i + 1, Math.max(flags.length - 1, 0))); break;
        case "k": setActiveFlag((i) => Math.max(i - 1, 0)); break;
        case "a": {
          const f = flags[activeFlag];
          if (f && f.severity === "warning" && !f.acknowledged && gate === "findings") store.respond({ action: "change", changes: [{ kind: "acknowledge_finding", code: f.code, row: f.row }] });
          break;
        }
        case "e": {
          const row = flags[activeFlag]?.row ?? selected;
          if (row && gate === "findings") setEditing(row);
          break;
        }
        case "p": document.querySelector("[data-testid=change-card]")?.scrollIntoView({ behavior: "smooth" }); break;
        case "Enter": if (target.tagName !== "BUTTON" && snap?.proposal?.applicable && gate === "findings") store.respond({ action: "change", changes: snap.proposal.changes }); break;
        case "g": goPending.current = true; break;
        case "/": e.preventDefault(); composer.current?.focus(); break;
        case "?": setHelp((v) => !v); break;
        default: return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flags, activeFlag, selected, snap, store, showPhase]);

  if (!flow || !snap) {
    return <main className="app"><div className="box">{store.error ? <p className="err-text" role="alert">Cannot load run {runId}: {store.error}</p> : "Loading the run…"}</div></main>;
  }
  const phase = flow.phases[current - 1];
  const onTabKey = (e: React.KeyboardEvent, n: number) => {
    const last = flow.phases.length;
    const next = e.key === "ArrowRight" ? (n % last) + 1 : e.key === "ArrowLeft" ? ((n + last - 2) % last) + 1
      : e.key === "Home" ? 1 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    showPhase(next);
    document.getElementById(`tab-p${next}`)?.focus();
  };

  return (
    <main className="app">
      <header className="band">
        <div>
          <Link href="/" className="back">← All runs</Link>
          <div className="t">{flow.title}</div>
          <div className="s">{flow.subtitle}</div>
          <div className="meta" style={{ marginTop: 8 }}>
            <span>Sponsor <b>{snap.sponsor_id}</b></span>
            <span>Run <b className="mono">{snap.run_id}</b></span>
            <span>File <b>{snap.upload.name}</b></span>
            <span>History <b>{snap.replay ? "recalled" : snap.brief?.bindings.some((b) => b.route === "history") ? "partly recalled" : "none used"}</b></span>
          </div>
        </div>
        <span className="grow" />
        <div>
          <div className="ph">Phase {current} — {phase.name}</div>
          <div className="dots" aria-label={`Phase ${current} of ${flow.phases.length}`}>{flow.phases.map((p, i) => <i key={p.id} className={i + 1 === current ? "on" : ""} />)}</div>
        </div>
      </header>
      <section className="overview">
        <WorkflowDiagram flow={flow} snap={snap} current={current} shown={shown} onSelect={showPhase} />
        <Legend />
      </section>
      <div className="main">
        <div className="flow">
          <div className="tabs" role="tablist" aria-label="Phases">
            {flow.phases.map((p, i) => {
              const st = phaseState(p.id, snap);
              const n = i + 1;
              return (
                <button key={p.id} type="button" role="tab" id={`tab-${p.id}`} aria-controls={`ph-${p.id}`} aria-selected={n === shown}
                  tabIndex={n === shown ? 0 : -1} className={`tab ${p.id}${n === shown ? " on" : ""}${st.cls === "wait" ? " dim" : ""}`}
                  onClick={() => showPhase(n)} onKeyDown={(e) => onTabKey(e, n)} data-testid={`tab-${p.id}`}>
                  <span className={`tab-dot ${st.cls}`} aria-hidden="true" />Phase {n}<span className="tab-name"> · {p.name}</span>
                </button>
              );
            })}
          </div>
          {shown !== current && (
            <button type="button" className="back-to-run" onClick={() => showPhase(current)} data-testid="back-to-run">
              {snap.status === "locked" ? "Run is locked at" : "Run is now at"} Phase {current} — {phase.name} →
            </button>
          )}
          {flow.phases.map((p, i) => {
            const st = phaseState(p.id, snap);
            return (
              <section key={p.id} role="tabpanel" hidden={i + 1 !== shown} className={`phase${st.cls === "wait" ? " locked" : ""}`} id={`ph-${p.id}`} aria-labelledby={`tab-${p.id}`}>
                <div className="phase-h">
                  <h2 id={`h-${p.id}`}><span className="sq" style={{ background: `var(--${p.id})` }} />Phase {i + 1} — {p.name}</h2>
                  <span className="grow" />
                  <span className={`state ${st.cls}`}>{st.label}</span>
                </div>
                <div className="steps">
                  {p.steps.map((s, j) => {
                    const lens = <Lens store={store} snap={snap} step={s} runId={runId} ui={ui} />;
                    const bare = s.lens === "column_choice" || s.lens === "saved" || s.lens === "gate_bar";
                    return (
                      <div key={s.id}>
                        {j > 0 && <Arrow />}
                        {bare ? <div data-step={s.id}>{lens}</div> : (
                          <StepBox id={s.id} type={s.type} title={s.title} who={WHO[s.type]} working={store.busy && store.steps[s.id]?.state === "running"}
                            why={s.id === "p1.read" && snap.brief ? snap.brief.summary : s.id === "p3.dq" && snap.report ? snap.report.summary : null}>
                            {lens}
                          </StepBox>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        <Copilot ref={composer} snap={snap} activity={store.activity} busy={store.busy} onRespond={store.respond} />
      </div>
      {store.error && <div className="msg" role="alert">{store.error}</div>}
      <DecisionLedger decisions={snap.decisions} pending={snap.pending?.gate} />
      {help && (
        <div className="card help box" role="dialog" aria-label="Keyboard shortcuts">
          <div className="ct"><span>Keyboard</span><button className="btn" onClick={() => setHelp(false)}>Close</button></div>
          <p><span className="kbd">J</span>/<span className="kbd">K</span> next/previous flag · <span className="kbd">A</span> acknowledge · <span className="kbd">E</span> edit ITEM_ID · <span className="kbd">P</span> show impact · <span className="kbd">Enter</span> apply proposal · <span className="kbd">G</span> then <span className="kbd">1–4</span> go to phase · <span className="kbd">/</span> composer · <span className="kbd">?</span> help</p>
        </div>
      )}
    </main>
  );
}

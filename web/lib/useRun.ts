"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { GridRow, Snapshot } from "./types";

export interface StepState {
  state: string;
  content: Record<string, unknown>;
}

export interface RunStore {
  snap: Snapshot | null;
  grid: GridRow[];
  steps: Record<string, StepState>;
  activity: string[];
  error: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  respond: (body: Record<string, unknown>) => Promise<void>;
}

const REFRESH_ON = new Set(["gate", "idle", "brief", "report", "findings", "decision", "artifact", "error", "change_impact"]);

/** One store per run, fed by the snapshot endpoint and the SSE stream. */
export function useRun(runId: string): RunStore {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [grid, setGrid] = useState<GridRow[]>([]);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [activity, setActivity] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.run(runId);
      setSnap(next);
      setBusy(next.working);
      if (next.result) setGrid((await api.grid(runId)).rows);
      else setGrid([]);
      setError(next.job_error);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 120);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const source = new EventSource(api.eventsUrl(runId));
    const on = (kind: string) => (e: MessageEvent) => {
      // EventSource fires its own dataless "error" on connection loss; it shares a name with our error event.
      if (typeof e.data !== "string") return;
      const data = JSON.parse(e.data) as Record<string, unknown>;
      if (kind === "step") {
        const id = String(data.step_id);
        setSteps((s) => ({ ...s, [id]: { state: String(data.state), content: (data.content as Record<string, unknown>) ?? {} } }));
        if (data.state === "running") setActivity((a) => [...a.slice(-19), `Working on ${id}…`]);
      } else if (kind === "agent_message" && data.mode) {
        setActivity((a) => [...a.slice(-19), `Agent: ${String(data.mode)} mode`]);
      } else if (kind === "decision") {
        const entry = data.entry as { kind: string; actor: string };
        setActivity((a) => [...a.slice(-19), `${entry.actor}: ${entry.kind}`]);
      } else if (kind === "error") {
        setActivity((a) => [...a.slice(-19), `Error: ${String(data.message)}`]);
      }
      if (kind === "idle") setBusy(false);
      if (REFRESH_ON.has(kind)) schedule();
    };
    const kinds = ["step", "phase", "agent_message", "tool", "question", "brief", "report", "findings", "gate", "change_impact", "decision", "artifact", "error", "idle"];
    for (const k of kinds) source.addEventListener(k, on(k) as EventListener);
    return () => source.close();
  }, [runId, refresh, schedule]);

  const respond = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await api.gate(runId, body);
      } catch (e) {
        setError((e as Error).message);
        setBusy(false);
      }
      schedule();
    },
    [runId, schedule],
  );

  return { snap, grid, steps, activity, error, busy, refresh, respond };
}

import type { ReactNode } from "react";
import type { StepType } from "@/lib/types";

const CLASS: Record<StepType, string> = { system: "", analyst: "ana", output: "out", risk: "risk", decision: "amber" };

export function StepBox(props: {
  id: string;
  type: StepType;
  title: string;
  who?: "agent" | "you" | "system" | null;
  detail?: string;
  working?: boolean;
  why?: string | null;
  children?: ReactNode;
}) {
  const { id, type, title, who, detail, working, why, children } = props;
  return (
    <div className={`step ${CLASS[type]}${working ? " working" : ""}`} data-step={id} id={id.replace(".", "-")}>
      <div className="sh">
        <span className="st">{title}</span>
        <span className="grow" />
        {who === "agent" && <span className="who agent">Agent</span>}
        {who === "system" && <span className="who agent">System</span>}
        {who === "you" && <span className="who you">You</span>}
      </div>
      {detail && <span className="sd">{detail}</span>}
      {children}
      {why && (
        <details className="why">
          <summary>Why?</summary>
          <p>{why}</p>
        </details>
      )}
    </div>
  );
}

export function Arrow() {
  return <div className="arrow" aria-hidden="true" />;
}

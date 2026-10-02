import type { GridRow } from "@/lib/types";

/** Segments come from the SDK's explain_derivation; this only draws them. */
export function DerivationDiff({ segments }: { segments: NonNullable<GridRow["derivation"]> }) {
  return (
    <span className="deriv" aria-label="How the ID was derived">
      {segments.map(([text, kind], i) =>
        kind === "strip" ? <s key={i}>{text}</s> : kind === "cut" ? <span key={i} className="tail">{text}</span> : kind === "ruler" ? <span key={i} className="ruler" title="30-character limit" /> : <span key={i}>{text}</span>,
      )}
    </span>
  );
}

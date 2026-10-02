export function Legend() {
  return (
    <div className="box legend-box">
      <h3>Colour legend</h3>
      <div className="legend">
        <div><i style={{ background: "var(--sys)" }} /><b>System / Agent</b><span>Done by the pipeline or the agent</span></div>
        <div><i style={{ background: "var(--ana)" }} /><b>Analyst action</b><span>Needs your review, confirmation or decision</span></div>
        <div><i style={{ background: "var(--out)" }} /><b>Output / success</b><span>Deliverable or passed gate</span></div>
        <div><i style={{ background: "var(--risk)" }} /><b>Risk / warning</b><span>Error flag or blocking condition</span></div>
        <div><i style={{ background: "var(--amber)" }} /><b>Decision prompt</b><span>A rule the flow asks you to apply</span></div>
      </div>
    </div>
  );
}

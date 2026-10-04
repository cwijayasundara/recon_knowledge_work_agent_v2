import type { RunState } from "../state/store";

export function Progress({ state }: { state: RunState }) {
  const { snap, connection, activity, busy } = state;
  return (
    <section class="progress" data-testid="progress" aria-live="polite">
      <p class="conn">Connection: {connection}</p>
      <p>
        {busy ? <span class="spinner" role="status" aria-label="Working" /> : null}
        Phase: <strong>{snap?.phase ?? "starting"}</strong> · Status: <strong>{snap?.status ?? "pending"}</strong>
      </p>
      {activity.length > 0 ? (
        <details class="activity-log" data-testid="activity">
          <summary>Activity</summary>
          <ul class="activity">
            {activity.slice(-5).map((line, i) => (
              <li key={`${i}-${line}`}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

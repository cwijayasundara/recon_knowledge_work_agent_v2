/** The active gate's message from the server, verbatim (a refusal of the last action shows up here). */
export function GateMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div class="banner banner-warning" role="status" data-testid="gate-message">
      {message}
    </div>
  );
}

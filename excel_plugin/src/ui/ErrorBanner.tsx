export function ErrorBanner({ message, requestId }: { message: string; requestId?: string }) {
  return (
    <div class="banner banner-error" role="alert" data-testid="error-banner">
      <strong>Error: </strong>
      <span>{message}</span>
      {requestId ? <span class="ref"> (ref {requestId})</span> : null}
    </div>
  );
}

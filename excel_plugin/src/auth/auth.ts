export interface Auth {
  label: string;
  headers(): Promise<Record<string, string>>;
  /** Forgets a token request the caller gave up on (it timed out), so the next headers() asks afresh. */
  reset?(): void;
}

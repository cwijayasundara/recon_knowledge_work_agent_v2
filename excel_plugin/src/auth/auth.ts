export interface Auth {
  label: string;
  headers(): Promise<Record<string, string>>;
}

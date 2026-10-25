/** Messages between main and the backend utility process (parent port). */
export type MainToBackend =
  | { type: "init"; dbPath: string; demo: boolean; dev: boolean; socketPath: string; tokenPath: string; version: string; diag: { session: string; build: string; channel: "production" | "dev" | "test" | "demo" } }
  | { type: "port"; clientId: string }
  /**
   * Quitting or updating: stop starting ops, give a send in flight until the
   * deadline, close the database (its WAL checkpointed) and answer. `force`
   * (a plain quit) closes even if a send is still going; otherwise the
   * backend keeps running and says "sending", then "sends-idle" once it isn't.
   */
  | { type: "shutdown"; id: number; deadlineMs: number; force: boolean }
  | { type: "secret-result"; id: number; ok: boolean; value?: string | number[] | (string | null)[]; error?: string };

export type BackendToMain =
  | { type: "ready" }
  | { type: "shutdown-result"; id: number; outcome: "closed" | "forced" | "sending" }
  | { type: "sends-idle" }
  | { type: "secret"; id: number; op: "encrypt"; plain: string }
  | { type: "secret"; id: number; op: "decrypt"; blob: number[] }
  /** blobs sealed under Única's keychain item: main opens them through the keychain helper */
  | { type: "legacy-secrets"; id: number; blobs: number[][] }
  | { type: "open-external"; url: string }
  | { type: "policy"; localMode: boolean; errorReports: "ask" | "always" | "never"; language: string }
  /** diagnostics: log entries (batched), the breadcrumb mirror, and records; main validates all of it again */
  | { type: "diag"; entries: unknown[] }
  | { type: "diag-ring"; crumbs: unknown[] }
  | { type: "diag-record"; record: unknown };

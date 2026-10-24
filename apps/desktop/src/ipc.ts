/** Messages between main and the backend utility process (parent port). */
export type MainToBackend =
  | { type: "init"; dbPath: string; demo: boolean; dev: boolean; socketPath: string; tokenPath: string; version: string }
  | { type: "port"; clientId: string }
  | { type: "secret-result"; id: number; ok: boolean; value?: string | number[] | (string | null)[]; error?: string };

export type BackendToMain =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "secret"; id: number; op: "encrypt"; plain: string }
  | { type: "secret"; id: number; op: "decrypt"; blob: number[] }
  /** blobs sealed under Única's keychain item: main opens them through the keychain helper */
  | { type: "legacy-secrets"; id: number; blobs: number[][] }
  | { type: "open-external"; url: string }
  | { type: "policy"; localMode: boolean }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

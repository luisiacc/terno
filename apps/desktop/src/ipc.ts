/** Messages between main and the backend utility process (parent port). */
export type MainToBackend =
  | { type: "init"; dbPath: string; demo: boolean; dev: boolean; socketPath: string; tokenPath: string; version: string }
  | { type: "port"; clientId: string }
  | { type: "secret-result"; id: number; ok: boolean; value?: string | number[]; error?: string };

export type BackendToMain =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "secret"; id: number; op: "encrypt"; plain: string }
  | { type: "secret"; id: number; op: "decrypt"; blob: number[] }
  | { type: "open-external"; url: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

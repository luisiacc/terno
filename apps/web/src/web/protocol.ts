/** Messages between a tab and its backend worker (RPC itself flows over a dedicated MessagePort). */

export interface WorkerInit {
  type: "init";
  /** the RPC port: the same envelope as desktop's utility process */
  port: MessagePort;
  /** the mailbox (database) name */
  name: string;
  /** `?storage=`: an explicit adapter, never silently replaced */
  requestedStorage: string | null;
  /** the adapter this mailbox was created with (remembered by the page) */
  pinnedStorage: string | null;
  /** demo builds: seed an empty mailbox from the mock generator */
  demo: { threads: number; accounts: number } | null;
  /** the page's build: the worker must be the same one */
  build: string;
  /** demo builds (perf): false measures the durable search path alone */
  instantSearch: boolean;
  /** demo builds (tests): hold the legacy IndexedDB copy of a mailbox after its first batch, so a test can close the tab mid-copy */
  pauseLegacyCopy?: boolean;
}

export type PageToWorker =
  | WorkerInit
  | { type: "close" }
  | { type: "cache-status" }
  /** demo builds (perf): ingest a generated batch through the backend's sliced import, as a sync would */
  | { type: "dev-import"; threads: number; seed: number };

export type FatalCode = "SCHEMA_NEWER" | "OPEN_FAILED" | "UNAVAILABLE" | "BUILD_MISMATCH";

export type WorkerToPage =
  | { type: "progress"; message: string }
  | { type: "ready"; storage: string; reason: string; build: string; seeded: boolean; timings: Record<string, number> }
  | { type: "fatal"; code: FatalCode; message: string }
  /** every storage handle is closed: leadership may pass to another tab */
  | { type: "closed" }
  | { type: "cache-status"; status: { hit: number; miss: number; usedBytes: number; cacheBytes: number; hotBytes: number } | null }
  | { type: "dev-imported"; messages: number; ms: number };

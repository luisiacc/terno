/**
 * The renderer's diagnostics, installed before anything else (main.tsx
 * imports this first, so a module that fails to load is still caught).
 *
 * - Desktop: entries, the breadcrumb mirror and records go to main in
 *   batches (every 500 ms or 100 entries); main validates, writes, reports.
 * - Web (and the test/dev renderer without a desktop shell): a local store
 *   (IndexedDB, memory if that fails) holds them; the page itself reports
 *   (web builds with a DSN), see diag-local.ts.
 *
 * Errors from the backend arrive as RpcErrors already classified and, when
 * they were bugs, already captured there: here they are breadcrumbs only.
 */
import { breadcrumb, captureError, installDiag, log, type Channel, type Crumb, type DiagContext, type DiagEntry, type DiagSink, type ErrorRecord } from "@terno/core/diag";
import type { RpcError } from "@terno/core/rpc";

const bridge = typeof window !== "undefined" ? window.ternoDesktop?.diag : undefined;
const info = bridge?.info() ?? null;
const hasDom = typeof navigator !== "undefined";

const VERSION = info?.version ?? String(import.meta.env.VITE_BUILD_ID ?? "0.0.0").replace(/-[a-z0-9]+$/, "");
const SHA = info?.sha ?? String(import.meta.env.VITE_BUILD_SHA ?? "dev");
const CHANNEL: Channel = info?.channel ?? (import.meta.env.VITE_RENDER_PROBE ? "test" : import.meta.env.VITE_WEB_DEMO === "1" ? "demo" : import.meta.env.DEV ? "dev" : "production");
export const BUILD = { version: VERSION, sha: SHA, channel: CHANNEL, id: info?.build ?? `${VERSION}+${SHA}` };
export const WEB = import.meta.env.VITE_TARGET === "web";
export const DESKTOP_DIAG = bridge ?? null;

function context(): Partial<DiagContext> {
  if (!hasDom) return {};
  const nav = navigator as Navigator & { deviceMemory?: number };
  const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1];
  const electron = /Electron\/([\d.]+)/.exec(navigator.userAgent)?.[1];
  return {
    os: WEB ? "web" : /Mac/.test(navigator.platform) ? "darwin" : /Win/.test(navigator.platform) ? "win32" : /Linux/.test(navigator.platform) ? "linux" : "other",
    locale: navigator.language,
    runtime: electron ? `electron-${electron}` : chrome ? `chrome-${chrome}` : undefined,
    engine: WEB ? "wasm-opfs" : undefined,
    memMb: nav.deviceMemory ? Math.round(nav.deviceMemory * 1024) : undefined,
  };
}

/** To main, in batches; a flood beyond 1,000 queued entries is counted, not kept. */
class BridgeSink implements DiagSink {
  private entries: DiagEntry[] = [];
  private crumbs: Crumb[] | null = null;
  private records: ErrorRecord[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  write(e: DiagEntry): void {
    if (this.entries.length >= 1000) {
      this.dropped++;
      return;
    }
    this.entries.push(e);
    if (this.entries.length >= 100) this.flush();
    else this.schedule();
  }
  capture(r: ErrorRecord): void {
    this.records.push(r);
    this.flush();
  }
  mirror(c: Crumb[]): void {
    this.crumbs = c;
    this.schedule();
  }
  private schedule(): void {
    this.timer ??= setTimeout(() => this.flush(), 500);
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.entries.length && !this.records.length && !this.crumbs && !this.dropped) return;
    const batch = { entries: this.entries, ...(this.crumbs ? { crumbs: this.crumbs } : {}), ...(this.records.length ? { records: this.records } : {}), ...(this.dropped ? { dropped: this.dropped } : {}) };
    this.entries = [];
    this.crumbs = null;
    this.records = [];
    this.dropped = 0;
    bridge!.push(batch);
  }
}

/** Until the local store is ready (it loads lazily), entries wait here. */
class PendingSink implements DiagSink {
  readonly queue: { entries: DiagEntry[]; records: ErrorRecord[]; crumbs: Crumb[] | null } = { entries: [], records: [], crumbs: null };
  write(e: DiagEntry): void {
    if (this.queue.entries.length < 500) this.queue.entries.push(e);
  }
  capture(r: ErrorRecord): void {
    if (this.queue.records.length < 20) this.queue.records.push(r);
  }
  mirror(c: Crumb[]): void {
    this.queue.crumbs = c;
  }
}

const sink: DiagSink = bridge ? new BridgeSink() : new PendingSink();
export const pendingSink = sink instanceof PendingSink ? sink : null;

installDiag({ proc: "renderer", version: VERSION, build: BUILD.id, channel: CHANNEL, session: info?.session, sink, context });

const isRpcError = (e: unknown): e is RpcError => e instanceof Error && e.name === "RpcError";

/**
 * A renderer error with its code. An RpcError is the backend's (classified,
 * and captured there when it was a bug): a warning here, never a second record.
 */
export function captureUi(error: unknown, o: Parameters<typeof captureError>[1]): string | null {
  if (isRpcError(error)) {
    log.warn(o.code, { ...(o.fields as object), rpcCode: error.code } as never);
    return null;
  }
  return captureError(error, o);
}

// unit tests import this module in Node: no window, nothing to listen to
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("error", (e) => {
    // resource load errors (an image) bubble as plain Events: not ours to report
    if (!(e instanceof ErrorEvent)) return;
    captureUi(e.error ?? new Error(e.message || "script error"), { code: "process.uncaught", fields: { source: "renderer" } });
  });
  window.addEventListener("unhandledrejection", (e) => {
    captureUi(e.reason, { code: "process.unhandled_rejection", fields: { source: "renderer" } });
  });
  window.addEventListener("pagehide", () => (sink as { flush?: () => void }).flush?.());
}

/** The RPC client's observer: failures and slow calls become crumbs (the many fast reads would drown the trail). */
const QUIET = new Set(["threads.list", "threads.get", "threads.search", "counts.get", "drafts.list"]);
export function observeRpc(method: string, ms: number, error: unknown): void {
  const failed = error !== undefined;
  if (!failed && QUIET.has(method) && ms < 300) return;
  breadcrumb("rpc", "rpc.call", { method, durationMs: ms, ok: !failed, ...(failed && isRpcError(error) ? { rpcCode: error.code } : {}) });
}

export { breadcrumb, log };

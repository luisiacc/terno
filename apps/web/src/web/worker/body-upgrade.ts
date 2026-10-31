import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { BodyUpgradeProgress } from "@terno/db/wasm";

/** One bootstrap owner per backend lifetime; no queued body inputs and no polling. */
export class BrowserBodyUpgrades {
  private readonly abort = new AbortController();
  private active: Promise<void> | undefined;
  private quarantined: Worker | undefined;
  get signal(): AbortSignal { return this.abort.signal; }

  async run(kind: "idb" | "opfs", name: string, progress?: (value: BodyUpgradeProgress) => void | Promise<void>): Promise<void> {
    this.signal.throwIfAborted();
    if (this.active || this.quarantined) throw new RpcError("UNAVAILABLE", L("errors.mail.processingBusy"));
    const worker = new Worker(new URL("./body-upgrade.worker.ts", import.meta.url), { type: "module", name: "terno-body-upgrade" });
    let retired = false;
    const task = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>, settled = false;
      const detach = () => { clearTimeout(timer); this.signal.removeEventListener("abort", cancel); };
      const fail = () => {
        if (settled) return; settled = true;
        detach(); this.quarantined = worker; worker.terminate();
        reject(new RpcError("UNAVAILABLE", L("errors.mail.processingBusy")));
      };
      const arm = () => { clearTimeout(timer); timer = setTimeout(fail, 30000); };
      const cancel = () => worker.postMessage({ type: "cancel" });
      this.signal.addEventListener("abort", cancel, { once: true });
      worker.onerror = (event) => { event.preventDefault(); fail(); }; worker.onmessageerror = fail;
      worker.onmessage = (event: MessageEvent<{ type?: string; ok?: boolean; cancelled?: boolean; progress?: BodyUpgradeProgress }>) => {
        if (event.data.type === "retired") {
          retired = true; settled = true; detach(); worker.terminate();
          if (this.quarantined === worker) this.quarantined = undefined;
          if (this.signal.aborted) reject(this.signal.reason);
          else if (!event.data.ok) reject(new RpcError("UNAVAILABLE", L("errors.mail.processingBusy")));
          else resolve();
          return;
        }
        if (settled) return;
        if (event.data.type !== "progress" || !event.data.progress) { fail(); return; }
        arm();
        void Promise.resolve(progress?.(event.data.progress)).then(() => worker.postMessage({ type: this.signal.aborted ? "cancel" : "continue" }), fail);
      };
      arm(); worker.postMessage({ type: "upgrade", kind, name });
    });
    this.active = task;
    try { await task; }
    finally {
      if (this.active === task) this.active = undefined;
      if (retired) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; }
    }
  }

  async close(): Promise<void> {
    this.abort.abort(new DOMException("Mailbox opening cancelled", "AbortError"));
    await this.active?.catch(() => {});
    if (this.quarantined) throw new RpcError("UNAVAILABLE", L("errors.mail.processingBusy"));
  }
}

import { parentPort, Worker, workerData } from "node:worker_threads";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { nodeSqliteDriver } from "@terno/db";

if (!parentPort) throw new Error("Native opening fixture needs its owned parent");
const port = parentPort;
const mode = (workerData as { mode: string }).mode;
let releaseBackup!: () => void, releaseRetirement!: () => void;
const backup = new Promise<void>((resolve) => { releaseBackup = resolve; });
const retirement = new Promise<void>((resolve) => { releaseRetirement = resolve; });
let held: { worker: Worker; message: unknown } | undefined, disposing = false;
const actors = new Set<Worker>();
const emit = Worker.prototype.emit, terminate = Worker.prototype.terminate, post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (value, transfer) {
  if (value?.type === "legacy-upgrade") { actors.add(this); port.postMessage({ fixture: "legacy-start" }); }
  return post.call(this, value, transfer);
};
Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
  const value = args[0] as { type?: string; progress?: { phase?: string } } | undefined;
  if (!disposing && event === "message" && value?.type === "legacy-progress" && value.progress?.phase === "prepared" && !held) {
    held = { worker: this, message: value }; port.postMessage({ fixture: "prepared" }); return true;
  }
  return emit.call(this, event, ...args);
};
Worker.prototype.terminate = function () {
  const owned = actors.has(this);
  return terminate.call(this).then(async (code) => {
    if (owned) { port.postMessage({ fixture: "native-exit" }); if (!disposing) await retirement; actors.delete(this); }
    return code;
  });
};
const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const nativeBackup = sqlite.backup;
sqlite.backup = async (...args) => { const result = await nativeBackup(...args); if (mode === "backup-cancel") { port.postMessage({ fixture: "backup-held" }); await backup; } return result; };
syncBuiltinESMExports();
const open = nodeSqliteDriver.open.bind(nodeSqliteDriver);
nodeSqliteDriver.open = (path, options) => { port.postMessage({ fixture: "host-open" }); return open(path, options); };
globalThis.fetch = async () => { port.postMessage({ fixture: "unexpected-route" }); throw new Error("Unexpected native opening route"); };
Reflect.set(process, "parentPort", {
  on(_event: string, listener: (event: { data: unknown; ports: never[] }) => void) { port.on("message", (value) => { if (!value?.fixture) listener({ data: value, ports: [] }); }); },
  postMessage(value: unknown) { port.postMessage(value); },
});
port.on("message", (value) => {
  if (value?.fixture === "release-prepared" && held) { const next = held; held = undefined; emit.call(next.worker, "message", next.message); }
  if (value?.fixture === "release-retirement") releaseRetirement();
  if (value?.fixture === "release-backup") releaseBackup();
  if (value?.fixture === "barrier") port.postMessage({ fixture: "barrier" });
  if (value?.fixture === "dispose") {
    disposing = true; releaseBackup(); releaseRetirement();
    void Promise.allSettled([...actors].map((actor) => terminate.call(actor))).then(() => port.postMessage({ fixture: "disposed" }));
  }
});
void import("../backend-entry").then(() => port.postMessage({ fixture: "booted" }));

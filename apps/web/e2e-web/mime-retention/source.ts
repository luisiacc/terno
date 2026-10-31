export function qualifySource(kind: "opfs" | "idb", taskProbe = false): Promise<unknown> {
  const worker = new Worker(new URL("./source.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => { worker.onmessage = (event) => { worker.terminate(); if (event.data.ok) resolve(event.data); else reject(new Error(event.data.stack ?? event.data.message)); }; worker.onerror = () => { worker.terminate(); reject(new Error("Source fixture worker failed")); }; worker.postMessage({ kind, taskProbe }); });
}

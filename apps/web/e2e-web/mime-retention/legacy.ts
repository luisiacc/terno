export function qualifyLegacy(kind: "opfs" | "idb", cancel = false): Promise<unknown> {
  const worker = new Worker(new URL("./legacy.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => { worker.onmessage = (event) => { worker.terminate(); if (event.data.ok) resolve(event.data); else reject(new Error(event.data.message)); }; worker.onerror = () => { worker.terminate(); reject(new Error("Legacy fixture worker failed")); }; worker.postMessage({ kind, cancel }); });
}

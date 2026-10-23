import type { TestResult } from "./shim";
import type { ConformanceMessage } from "./worker";

declare global {
  interface Window {
    __conformance: { done: boolean; results: TestResult[]; error: string | null };
  }
}

const suite = new URLSearchParams(location.search).get("suite") ?? "opfs-sqlite";
window.__conformance = { done: false, results: [], error: null };
const log = document.getElementById("log")!;
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
worker.onmessage = (e: MessageEvent<ConformanceMessage>) => {
  const m = e.data;
  if (m.type === "result") {
    window.__conformance.results.push(m.result);
    log.textContent += `${m.result.state === "pass" ? "✓" : m.result.state === "skip" ? "-" : "✗"} ${m.result.name} (${m.result.ms} ms)\n`;
  } else if (m.type === "done") window.__conformance.done = true;
  else {
    window.__conformance.error = m.message;
    window.__conformance.done = true;
  }
};
worker.onerror = (e) => {
  window.__conformance.error = e.message || "worker crashed";
  window.__conformance.done = true;
};
worker.postMessage({ suite });

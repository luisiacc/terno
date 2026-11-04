import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Env = Record<string, string | undefined>;

const markerPath = (port: number, env: Env) => join(env.TERNO_AI_GUARD_DIR ?? "/tmp/terno-ai", `backend-guard-${port}.json`);

/** Says this process is a backend held to the spend ledger. Returns what takes the claim back. */
export function writeGuardMarker(port: number, env: Env = process.env): () => void {
  const path = markerPath(port, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ port, pid: process.pid }));
  return () => rmSync(path, { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why the browser proof mustn't handle real keys, or null when it may: typed into
 * a backend that isn't held to the ledger, they'd spend with no ceiling at all.
 * No value imports, since app-proof.mjs runs this directly in Node.
 */
export function refusalToTypeKeys(pageUrl: string, env: Env = process.env): string | null {
  if (env.TERNO_AI_REAL !== "1") return "Refusing to read real keys: set TERNO_AI_REAL=1 to mean it.";
  let backend: string | null;
  try {
    backend = new URL(pageUrl).searchParams.get("backend");
  } catch {
    backend = null;
  }
  const port = backend ? Number(URL.canParse(backend) ? new URL(backend).port : NaN) : NaN;
  if (!Number.isInteger(port) || port <= 0) return `Refusing to type real keys: ${pageUrl} doesn't name a backend port.`;
  const path = markerPath(port, env);
  let marker: { port?: unknown; pid?: unknown };
  try {
    marker = JSON.parse(readFileSync(path, "utf8")) as typeof marker;
  } catch {
    return `Refusing to type real keys: no guard marker at ${path}. Start the backend with TERNO_AI_REAL=1.`;
  }
  if (marker.port !== port || typeof marker.pid !== "number" || !isAlive(marker.pid)) {
    return `Refusing to type real keys: the guard marker at ${path} doesn't name a live backend on port ${port}.`;
  }
  return null;
}

/** Plan 156: what main forks: the backend's bundle, through the code cache whose path main passes. */
import { join } from "node:path";
import { runBundle } from "./code-cache";
import type { BackendToMain } from "./ipc";

const outcome = runBundle(join(__dirname, "backend.cjs"), process.argv[2]);
(process as unknown as { parentPort: { postMessage(m: BackendToMain): void } }).parentPort.postMessage({ type: "code-cache", outcome });

/** Plan 156: what main forks: the backend's bundle, through the code cache for this build (main says where, and the version). */
import { join } from "node:path";
import { runBundle } from "./code-cache";
import type { BackendToMain } from "./ipc";

const [dir, version] = process.argv.slice(2);
const outcome = runBundle(join(__dirname, "backend.cjs"), dir && version ? { dir, version } : undefined);
(process as unknown as { parentPort: { postMessage(m: BackendToMain): void } }).parentPort.postMessage({ type: "code-cache", outcome });

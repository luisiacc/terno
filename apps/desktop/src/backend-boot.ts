/** Plan 156: what main forks: the backend's bundle, through the code cache whose path main passes. */
import { join } from "node:path";
import { runBundle } from "./code-cache";

runBundle(join(__dirname, "backend.cjs"), process.argv[2]);

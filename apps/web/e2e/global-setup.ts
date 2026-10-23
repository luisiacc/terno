import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "../../backend-dev/src/server";
import { E2E_NOW, TEMPLATE_ENV } from "./constants";

/**
 * Seeds the deterministic demo mailbox once. Each test copies this database
 * into its own directory and gets a private backend (independent, parallel-safe).
 */
export default async function globalSetup() {
  const dir = mkdtempSync(join(tmpdir(), "unica-e2e-template-"));
  const server = await startDevServer({ port: 0, dataDir: dir, token: "seed", fresh: true, threads: 3000, accounts: 4, now: () => E2E_NOW, autoSync: false });
  await server.close(); // stop() truncates the WAL into the main file
  process.env[TEMPLATE_ENV] = join(dir, "unica.db");
}

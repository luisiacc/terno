import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "../../backend-dev/src/server";
import { E2E_NOW, TEMPLATE_ENV } from "./constants";

/** The unchanged consumer fixtures need a template; this development setup builds no application or worker. */
export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-account-errors-template-"));
  try {
    const server = await startDevServer({ port: 0, dataDir: dir, token: "synthetic", threads: 3000, accounts: 4, now: () => E2E_NOW, autoSync: false, iconTransport: null });
    await server.close();
    process.env[TEMPLATE_ENV] = join(dir, "terno.db");
    return () => { rmSync(dir, { recursive: true, force: true }); };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

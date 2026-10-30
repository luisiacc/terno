import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "../../backend-dev/src/server";
import { E2E_NOW, TEMPLATE_ENV } from "./constants";

export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-reply-identity-template-"));
  try {
    const server = await startDevServer({ port: 0, dataDir: dir, token: "seed", threads: 20, accounts: 2, now: () => E2E_NOW, autoSync: false });
    await server.close();
    process.env[TEMPLATE_ENV] = join(dir, "terno.db");
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return () => rmSync(dir, { recursive: true, force: true });
}

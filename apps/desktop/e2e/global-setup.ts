import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Seeding isn't the test: one small mailbox per run, cloned by whoever needs a profile with mail (`seededProfile`). */
export default function globalSetup(): () => void {
  const dir = mkdtempSync("/tmp/terno-smoke-seed-");
  const profile = join(dir, "profile");
  execFileSync("pnpm", ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", profile, "--accounts", "2", "--threads", "300"], { cwd: repo, stdio: "ignore" });
  process.env.TERNO_SMOKE_SEED = profile;
  return () => rmSync(dir, { recursive: true, force: true });
}

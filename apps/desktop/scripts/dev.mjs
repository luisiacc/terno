// One-command desktop dev: bundles main/preload/backend, starts the Vite dev
// server (renderer with HMR) and launches Electron against it.
//   pnpm dev:desktop            → your real profile (~/Library/Application Support/Terno)
//   pnpm dev:desktop --demo     → a separate dev profile seeded with the demo mailbox
//   pnpm dev:desktop --seeded   → a profile pre-seeded with 8 accounts / ~20k messages
//                                 (reused on later runs; add --reseed to start over;
//                                  TERNO_SEED_ACCOUNTS / TERNO_SEED_THREADS to tune)
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DB_FILE, LegacyProfileConflictError, LegacyProfileInUseError, migrateLegacyProfile, resolveProfile } from "../src/legacy-profile.ts";

// For one release UNICA_* variables still work (the same rule as @terno/core/legacy-env).
for (const legacy of Object.keys(process.env).filter((k) => k.startsWith("UNICA_"))) {
  const name = `TERNO_${legacy.slice("UNICA_".length)}`;
  if (process.env[name] === undefined) {
    process.env[name] = process.env[legacy];
    console.warn(`[terno] ${legacy} is deprecated: use ${name} (UNICA_* variables are read for one more release).`);
  } else console.warn(`[terno] ${legacy} is ignored: ${name} is set.`);
  delete process.env[legacy];
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");
const demo = process.argv.includes("--demo");
const seeded = process.argv.includes("--seeded");
const port = Number(process.env.TERNO_VITE_PORT ?? 5173);
const url = `http://localhost:${port}`;

/**
 * The dev profile (TERNO_USER_DATA wins, as is), with its legacy files renamed
 * before anything looks inside; only the default Terno-dev-* path takes over
 * its Unica-dev-* sibling.
 */
function devProfile(name) {
  const { path: profile, adoptSibling } = resolveProfile({ explicit: process.env.TERNO_USER_DATA, defaultPath: join(homedir(), "Library", "Application Support", name) });
  try {
    const m = migrateLegacyProfile(profile, { adoptSibling });
    if (m.movedFrom) console.log(`[dev] renamed ${m.movedFrom} → ${profile}`);
    for (const r of m.renamed) console.log(`[dev] renamed ${r}`);
    for (const c of m.conflicts) console.warn(`[dev] left alone (the Terno one exists): ${c}`);
  } catch (error) {
    if (!(error instanceof LegacyProfileInUseError || error instanceof LegacyProfileConflictError)) throw error;
    console.error(`[dev] ${error.message}`);
    process.exit(1);
  }
  return profile;
}

if (seeded) {
  const profile = (process.env.TERNO_USER_DATA = devProfile("Terno-dev-seeded"));
  if (process.argv.includes("--reseed") || !existsSync(join(profile, DB_FILE))) {
    console.log(`[dev] seeding ${profile} …`);
    const seed = spawnSync(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", profile, "--accounts", process.env.TERNO_SEED_ACCOUNTS ?? "8", "--threads", process.env.TERNO_SEED_THREADS ?? "12000"],
      { cwd: repo, stdio: "inherit" },
    );
    if (seed.status !== 0) process.exit(seed.status ?? 1);
  } else {
    console.log(`[dev] using seeded profile ${profile} (pass --reseed to regenerate)`);
  }
}

const build = spawnSync(process.execPath, [join(here, "build.mjs"), "--no-renderer"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

// Run Vite's own entry directly (not via pnpm, which doesn't forward signals), so stopping dev stops it.
const webRequire = createRequire(join(repo, "apps/web/package.json"));
const viteBin = join(dirname(webRequire.resolve("vite/package.json")), "bin", "vite.js");
const vite = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort"], {
  cwd: join(repo, "apps/web"),
  stdio: ["ignore", "inherit", "inherit"],
});
const killVite = () => vite.kill("SIGTERM");

async function waitForVite(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Vite did not start on ${url}`);
}

let electron;
const shutdown = (code = 0) => {
  electron?.kill();
  killVite();
  process.exit(code);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
vite.on("exit", (code) => {
  if (code && code !== 0) shutdown(code);
});

await waitForVite();
const require = createRequire(join(root, "package.json"));
const electronBin = require("electron"); // the electron package exports the binary path
const env = { ...process.env, TERNO_DEV_URL: url };
// Some hosts (IDEs, agent shells) export this; it makes Electron run as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
if (demo) {
  env.TERNO_DEMO = "1";
  env.TERNO_USER_DATA = devProfile("Terno-dev-demo");
}
console.log(`\n[dev] launching Electron → ${url}${demo ? " (demo profile)" : ""}\n`);
const args = [join(root, "dist/main.cjs")];
// optional: attach DevTools/Playwright over CDP (used by the dev-mode smoke check)
if (process.env.TERNO_REMOTE_DEBUGGING_PORT) args.unshift(`--remote-debugging-port=${process.env.TERNO_REMOTE_DEBUGGING_PORT}`);
electron = spawn(electronBin, args, { env, stdio: "inherit" });
electron.on("exit", (code) => shutdown(code ?? 0));

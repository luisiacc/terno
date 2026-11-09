// One-command desktop dev: bundles main/preload/backend, starts the Vite dev
// server (renderer with HMR) and launches Electron against it.
//   pnpm dev:desktop            → your real profile (~/Library/Application Support/Terno)
//   pnpm dev:desktop --demo     → a separate dev profile seeded with the demo mailbox
//   pnpm dev:desktop --seeded   → a profile pre-seeded with 8 accounts / ~20k messages
//                                 (reused on later runs; add --reseed to start over;
//                                  TERNO_SEED_ACCOUNTS / TERNO_SEED_THREADS to tune)
//   pnpm dev:desktop --demo-ai  → plan 167: its own profile with the demo mailbox and every AI feature holding something,
//                                 on real models (Dev mode); the first launch prepares it (add --fresh to start over).
//                                 docs/AI-DEMO.md
//   add --cleandb to any of these → that profile (database, settings, first-run progress)
//                                 goes to the Trash first, so the app starts as a fresh install
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { withDotEnv } from "../../../scripts/release-env.mjs";
import { dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULT_DEV_PORT, devPort, viteLocalUrl } from "../src/dev-port.ts";
import { DEMO_AI_PROFILE, demoAiArgs, demoAiClock, demoAiEnv, demoAiProfileProblem, keyFiles, MARKER_FILE, missingKeysMessage, readMarker, resolveKeys, stepsToRun } from "../src/demo-ai.ts";
import { DB_FILE, LegacyProfileConflictError, LegacyProfileInUseError, migrateLegacyProfile, profileInUse, resolveProfile } from "../src/legacy-profile.ts";

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
const cleandb = process.argv.includes("--cleandb");
const demoAi = process.argv.includes("--demo-ai");

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

/**
 * --cleandb: the profile this run uses goes to the Trash (recoverable, unlike rm),
 * never while an app has it open.
 */
function cleanProfile(profile) {
  if (!existsSync(profile)) return console.log(`[dev] --cleandb: ${profile} is already empty`);
  if (profileInUse(profile)) {
    console.error(`[dev] --cleandb: ${profile} is open in a running Terno. Quit it and try again.`);
    process.exit(1);
  }
  const trashed = spawnSync("/usr/bin/trash", [profile], { stdio: "inherit" });
  if (trashed.status !== 0) {
    // older macOS has no trash command: set it aside next to itself instead
    const aside = `${profile}.before-cleandb-${Date.now()}`;
    renameSync(profile, aside);
    return console.log(`[dev] --cleandb: moved ${profile} → ${aside}`);
  }
  console.log(`[dev] --cleandb: moved ${profile} to the Trash`);
}

/**
 * Plan 167: before anything builds, what --demo-ai needs: its arguments, its keys (this checkout's .env, then the main
 * checkout's, under the shell's), and what its profile still has to prepare. No key value is ever printed.
 */
let demoAiPlan = null;
if (demoAi) {
  let args;
  try { args = demoAiArgs(process.argv.slice(2)); } catch (error) { console.error(`[demo-ai] ${error.message}`); process.exit(1); }
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" });
  const files = keyFiles(repo, common.status === 0 ? common.stdout.trim() : null);
  const read = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
  const { keys, from, missing } = resolveKeys(process.env, files.map((path) => ({ path, text: read(path) })));
  if (missing.length) { console.error(missingKeysMessage(missing, files)); process.exit(1); }
  // checked before devProfile() opens or renames anything in the folder (a legacy profile's migration would)
  const { path: candidate } = resolveProfile({ explicit: process.env.TERNO_USER_DATA, defaultPath: join(homedir(), "Library", "Application Support", DEMO_AI_PROFILE) });
  const problem = demoAiProfileProblem({ path: candidate, entries: existsSync(candidate) ? readdirSync(candidate) : null });
  if (problem) { console.error(`[demo-ai] ${problem}`); process.exit(1); }
  const profile = devProfile(DEMO_AI_PROFILE);
  if (args.fresh) cleanProfile(profile);
  const steps = stepsToRun(readMarker(read(join(profile, MARKER_FILE))), args);
  console.log(`[demo-ai] keys: ${Object.entries(from).map(([k, f]) => `${k} (${f})`).join(", ")}`);
  console.log(steps.length ? `[demo-ai] ${profile}: preparing ${steps.join(", ")} on real models before the window opens (a few minutes, once)` : `[demo-ai] ${profile}: prepared (pnpm dev:demo-ai --fresh starts over)`);
  demoAiPlan = { profile, keys, steps, read };
} else if (cleandb) cleanProfile(seeded ? devProfile("Terno-dev-seeded") : demo ? devProfile("Terno-dev-demo") : devProfile("Terno"));

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
// Chosen after the build, as late as possible. A port picked for us is only Vite's first try: it
// moves on if another checkout took it meanwhile, and we follow the URL Vite reports, so Electron
// never loads someone else's server. TERNO_VITE_PORT is strict.
const { port, fellBack } = await devPort(process.env);
if (fellBack) console.log(`[dev] port ${DEFAULT_DEV_PORT} is in use; using ${port}`);
const vite = spawn(process.execPath, [viteBin, "--port", String(port), ...(process.env.TERNO_VITE_PORT ? ["--strictPort"] : [])], {
  cwd: join(repo, "apps/web"),
  stdio: ["ignore", "pipe", "inherit"],
});
const killVite = () => vite.kill("SIGTERM");

/** Vite's own "Local:" URL, its output passed through as it comes */
const localUrl = new Promise((resolve, reject) => {
  let seen = "";
  const timer = setTimeout(() => reject(new Error("Vite did not start in 30 s")), 30_000);
  vite.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    if (seen === null) return;
    seen += chunk;
    const found = viteLocalUrl(seen);
    if (found) {
      seen = null;
      clearTimeout(timer);
      resolve(found);
    }
  });
});

let electron;
/** plan 167: the Electron that prepares the AI demo, while it runs */
let preparing = null;
const shutdown = (code = 0) => {
  electron?.kill();
  if (preparing) { try { process.kill(preparing, "SIGTERM"); } catch { /* gone */ } }
  killVite();
  process.exit(code);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
vite.on("exit", (code) => {
  if (code && code !== 0) shutdown(code);
});

const url = await localUrl;
const require = createRequire(join(root, "package.json"));
const electronBin = require("electron"); // the electron package exports the binary path
let env = { ...process.env, TERNO_DEV_URL: url };
// Some hosts (IDEs, agent shells) export this; it makes Electron run as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
// plan 146: Dev mode's keys (DEV_AI_ENV), and nothing else of the repo's .env
const dotEnv = withDotEnv(process.env);
for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "JEV_API_KEY"]) if (dotEnv[name]) env[name] = dotEnv[name];
if (demo) {
  env.TERNO_DEMO = "1";
  env.TERNO_USER_DATA = devProfile("Terno-dev-demo");
}
if (demoAiPlan) {
  const { profile, keys, steps, read } = demoAiPlan;
  if (steps.length) {
    // plan 167: the real AI jobs once, behind your windows, then the window you use on the same profile
    const { prepare, readSpend } = await import("./demo-ai-prepare.mjs");
    const started = Date.now();
    const failed = await prepare({
      electronBin,
      main: join(root, "dist/main.cjs"),
      env: (now) => demoAiEnv({ base: process.env, profile, keys, devUrl: url, background: true, now }),
      profile,
      steps,
      // Ctrl-C while it prepares stops that Electron too, by its PID
      onPid: (pid) => (preparing = pid),
    });
    preparing = null;
    const spend = Object.entries(readSpend(profile));
    const total = spend.reduce((a, [, t]) => ({ requests: a.requests + t.requests, usd: a.usd + t.usd }), { requests: 0, usd: 0 });
    console.log(`[demo-ai] prepared in ${Math.round((Date.now() - started) / 1000)} s; the profile's AI so far (Settings → AI → usage): ${total.requests} model requests, about US$${total.usd.toFixed(2)} (${spend.map(([task, t]) => `${task} ${t.requests}`).join(", ")})`);
    if (failed.length) console.log(`[demo-ai] ${failed.join(", ")} didn't finish: they run again on the next launch (a screenshot of each is in the profile)`);
  }
  env = demoAiEnv({ base: process.env, profile, keys, devUrl: url, background: false, now: demoAiClock(readMarker(read(join(profile, MARKER_FILE)))) });
}
console.log(`\n[dev] launching Electron → ${url}${demoAiPlan ? ` (the AI demo, ${new Date(Number(env.TERNO_TEST_NOW)).toISOString().slice(0, 16).replace("T", " ")} UTC; docs/AI-DEMO.md)` : demo ? " (demo profile)" : ""}\n`);
const args = [join(root, "dist/main.cjs")];
// optional: attach DevTools/Playwright over CDP (used by the dev-mode smoke check)
if (process.env.TERNO_REMOTE_DEBUGGING_PORT) args.unshift(`--remote-debugging-port=${process.env.TERNO_REMOTE_DEBUGGING_PORT}`);
electron = spawn(electronBin, args, { env, stdio: "inherit" });
electron.on("exit", (code) => shutdown(code ?? 0));

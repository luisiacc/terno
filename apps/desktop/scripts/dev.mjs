// One-command desktop dev: bundles main/preload/backend, starts the Vite dev
// server (renderer with HMR) and launches Electron against it.
//   pnpm dev:desktop            → your real profile (~/Library/Application Support/Unica)
//   pnpm dev:desktop --demo     → a separate dev profile seeded with the demo mailbox
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");
const demo = process.argv.includes("--demo");
const port = Number(process.env.UNICA_VITE_PORT ?? 5173);
const url = `http://localhost:${port}`;

const build = spawnSync(process.execPath, [join(here, "build.mjs"), "--no-renderer"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const vite = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@unica/web", "exec", "vite", "--port", String(port), "--strictPort"], {
  cwd: repo,
  stdio: ["ignore", "inherit", "inherit"],
});

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
  vite.kill();
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
const env = { ...process.env, UNICA_DEV_URL: url };
// Some hosts (IDEs, agent shells) export this; it makes Electron run as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
if (demo) {
  env.UNICA_DEMO = "1";
  env.UNICA_USER_DATA ??= join(homedir(), "Library", "Application Support", "Unica-dev-demo");
}
console.log(`\n[dev] launching Electron → ${url}${demo ? " (demo profile)" : ""}\n`);
const args = [join(root, "dist/main.cjs")];
// optional: attach DevTools/Playwright over CDP (used by the dev-mode smoke check)
if (process.env.UNICA_REMOTE_DEBUGGING_PORT) args.unshift(`--remote-debugging-port=${process.env.UNICA_REMOTE_DEBUGGING_PORT}`);
electron = spawn(electronBin, args, { env, stdio: "inherit" });
electron.on("exit", (code) => shutdown(code ?? 0));

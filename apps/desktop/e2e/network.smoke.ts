/**
 * Plan 20 on the packaged app: main's network watcher (`scutil`, network-watch.ts) runs as a
 * child of main, comes back when it dies, and is gone after quit. Runs against the packaged app,
 * or the dev build (`pnpm build`) with TERNO_NETWORK_SMOKE_DEV=1.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const DEV = process.env.TERNO_NETWORK_SMOKE_DEV === "1";
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");

let workdir: string;
let app: ElectronApplication | null = null;
let mainPid = 0;

/** the scutil children of the app's main process (only ever processes this test launched) */
const watchers = (): number[] =>
  spawnSync("pgrep", ["-P", String(mainPid), "-x", "scutil"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);
const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(process.platform !== "darwin", "macOS only");
  test.skip(!DEV && !existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-network-smoke-"));
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: join(workdir, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  if (DEV) {
    app = await electron.launch({ executablePath: join(here, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [join(here, "../dist/main.cjs")], env });
  } else {
    const appPath = join(workdir, "Terno.app");
    execFileSync("ditto", [SOURCE_APP, appPath]);
    app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  }
  mainPid = app.process().pid!;
  const page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("the network watcher runs as one scutil child of main", async () => {
  await expect.poll(watchers, { timeout: 10_000 }).toHaveLength(1);
});

test("killed, it comes back within seconds (a new process)", async () => {
  const [first] = watchers();
  // a child of the app this test launched, by the PID just read
  process.kill(first!, "SIGKILL");
  await expect.poll(() => alive(first!), { timeout: 5000 }).toBe(false);
  await expect.poll(() => watchers().filter((p) => p !== first), { timeout: 10_000 }).toHaveLength(1);
  expect(watchers()).toHaveLength(1);
});

test("a wake reaches the backend: it reconnects (net.changed in its log, no address or host in it)", async () => {
  await app!.evaluate(({ powerMonitor }) => void powerMonitor.emit("resume"));
  const logs = join(workdir, "profile", "logs");
  const lines = () =>
    (existsSync(logs) ? readdirSync(logs) : [])
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(logs, f), "utf8").split("\n"))
      .filter((l) => l.includes('"net.changed"'));
  // the log is written in batches (seconds)
  await expect.poll(() => lines().some((l) => l.includes('"netReason":"wake"') && l.includes('"online":true')), { timeout: 30_000 }).toBe(true);
  for (const l of lines()) expect(Object.keys((JSON.parse(l) as { fields?: object }).fields ?? {}).sort()).toEqual(["netReason", "online"]);
});

test("after quit, no watcher is left behind", async () => {
  const [pid] = watchers();
  expect(pid).toBeGreaterThan(0);
  await app!.close();
  app = null;
  await expect.poll(() => alive(pid!), { timeout: 5000 }).toBe(false);
});

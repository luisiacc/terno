/**
 * The in-app update, end to end (plan 11 §8.9): two packaged test builds,
 * 0.1.0 and 0.1.1, signed with the same identity, a local generic feed, and
 * Squirrel.Mac doing the real swap and relaunch.
 *
 * - Test builds have their own bundle id and names (dev.terno.updatetest,
 *   TernoUpdateTest): a real Terno's profile, Squirrel state, caches and
 *   keychain items are never touched. Their feed and profile are baked in
 *   (env doesn't survive Squirrel's relaunch).
 * - Skipped with the reason when no stable signing identity is available
 *   (an ad-hoc build can't update: Squirrel refuses it by design).
 * - Squirrel's caches and its launchd job for the test bundle id are cleaned
 *   before and after (a stale cached download would be reused).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");
const APP_ID = "dev.terno.updatetest";
const APP_NAME = "TernoUpdateTest";
// Squirrel's state and its URL cache, electron-updater's download cache, and the URL session's storage: the test bundle id's only
const CACHES = [
  join(homedir(), "Library/Caches", `${APP_ID}.ShipIt`),
  join(homedir(), "Library/Caches", APP_ID),
  join(homedir(), "Library/HTTPStorages", APP_ID),
  join(homedir(), "Library/Caches", "terno-updatetest-updater"),
];

function signingIdentity(): string | null {
  if (process.env.TERNO_SIGN_IDENTITY) return process.env.TERNO_SIGN_IDENTITY === "-" ? null : process.env.TERNO_SIGN_IDENTITY;
  const r = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const names = [...(r.stdout ?? "").matchAll(/"((?:Developer ID Application|Apple Development):[^"]+)"/g)].map((m) => m[1]!);
  return names.find((n) => n.startsWith("Developer ID")) ?? names[0] ?? null;
}

function cleanSquirrel() {
  for (const dir of CACHES) rmSync(dir, { recursive: true, force: true });
  // only the test bundle id's job, never dev.terno.mail's
  spawnSync("launchctl", ["remove", `${APP_ID}.ShipIt`]);
}

const identity = signingIdentity();
let work: string;
let server: Server;
let feedUrl: string;
const requests: string[] = [];
// every header name the feed received (no identifier or credential may ride along)
const headerNames = new Set<string>();
let app: ElectronApplication | null = null;
let page: Page;

const root = () => join(work, "run");
const profile = () => join(root(), "profile");
const bundle = () => join(work, "Applications", "Terno.app");
const bundleVersion = () => execFileSync("defaults", ["read", join(bundle(), "Contents/Info.plist"), "CFBundleShortVersionString"], { encoding: "utf8" }).trim();

/** Two test builds of this tree, as 0.1.0 and 0.1.1, with this run's feed and profile baked in. */
function buildTwo() {
  if (!existsSync(join(repo, "apps/web/dist/index.html"))) throw new Error("apps/web/dist missing: run `pnpm build` first");
  const baked = JSON.stringify({ feed: feedUrl, userData: profile(), appData: join(root(), "appdata"), appName: APP_NAME, checkDelayMs: 3_600_000 });
  for (const version of ["0.1.0", "0.1.1"]) {
    const env = { ...process.env, TERNO_VERSION: version, TERNO_TEST_BUILD: baked, TERNO_BUILD_OUT: join(work, `dist-${version}`), TERNO_PACKAGE_OUT: join(work, `release-${version}`), TERNO_SIGN_IDENTITY: identity! };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync("node", [join(desktop, "scripts/build.mjs")], { env, stdio: "inherit" });
    execFileSync("node", [join(desktop, "scripts/package.mjs")], { env, stdio: ["ignore", "ignore", "inherit"] });
  }
}

/** A fresh 0.1.0 in a temp "Applications", a fresh profile, and the 0.1.1 feed (its zip tampered with when asked). */
function stage(o: { tamper: boolean }) {
  rmSync(root(), { recursive: true, force: true });
  rmSync(join(work, "Applications"), { recursive: true, force: true });
  rmSync(join(work, "feed"), { recursive: true, force: true });
  mkdirSync(join(work, "Applications"), { recursive: true });
  mkdirSync(join(work, "feed"), { recursive: true });
  mkdirSync(profile(), { recursive: true });
  execFileSync("ditto", [join(work, "release-0.1.0/mac-arm64/Terno.app"), bundle()]);
  const zip = "Terno-0.1.1-arm64-mac.zip";
  for (const f of ["latest-mac.yml", zip, `${zip}.blockmap`]) copyFileSync(join(work, "release-0.1.1", f), join(work, "feed", f));
  if (o.tamper) {
    // one byte in the middle: same size, a different sha512 than latest-mac.yml says
    const file = join(work, "feed", zip);
    const buf = readFileSync(file);
    const at = Math.floor(buf.length / 2);
    buf[at] = buf[at]! ^ 0xff;
    writeFileSync(file, buf);
  }
  cleanSquirrel();
  requests.length = 0;
}

async function launch(env: Record<string, string> = {}) {
  const e = { ...process.env, ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: join(bundle(), "Contents/MacOS/Terno"), env: e });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
}

const updates = <T>(fn: string) => page.evaluate(`window.ternoDesktop.updates.${fn}()`) as Promise<T>;
const state = () => updates<{ status: string; error: { stage: string; kind: string } | null; ready: { version: string } | null; localMode: boolean }>("state");

function logLines(): { code: string; fields?: Record<string, unknown>; version?: string }[] {
  const file = join(profile(), "logs/main.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const pidsOfBundle = () =>
  (spawnSync("pgrep", ["-f", join(bundle(), "Contents/MacOS/Terno")], { encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .map(Number)
    .filter((n) => n > 0);

test.describe.configure({ mode: "serial", timeout: 900_000 });

test.beforeAll(async () => {
  test.skip(!identity, "no stable signing identity (Developer ID Application or Apple Development) in the keychain: Squirrel refuses updates to ad-hoc builds, so this can't run here");
  test.skip(process.platform !== "darwin" || process.arch !== "arm64", "macOS on Apple silicon only");
  work = mkdtempSync(join("/tmp", "terno-update-e2e-"));
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    for (const name of Object.keys(req.headers)) headerNames.add(name.toLowerCase());
    const file = join(work, "feed", decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+/, ""));
    if (!file.startsWith(join(work, "feed")) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Length": statSync(file).size });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  feedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  buildTwo();
});

test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = null;
});

test.afterAll(async () => {
  // the relaunched app is ours (this test updated it): stop exactly that one
  for (const pid of work ? pidsOfBundle() : []) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  server?.close();
  if (identity) cleanSquirrel();
  if (work && !process.env.TERNO_KEEP_UPDATE_E2E) rmSync(work, { recursive: true, force: true });
});

test("a corrupted download is refused (sha512): an integrity error, and the app stays as it was", async () => {
  stage({ tamper: true });
  await launch({ TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US" });
  // a new profile is in local mode: nothing was checked on its own
  expect((await state()).localMode).toBe(true);
  expect(requests).toEqual([]);
  // the manual check is one grant, the download a second
  expect((await updates<{ status: string }>("check")).status).toBe("available");
  await updates("download");
  await expect.poll(async () => (await state()).error, { timeout: 120_000 }).toMatchObject({ stage: "download", kind: "integrity" });
  expect((await state()).ready).toBeNull();
  expect(bundleVersion()).toBe("0.1.0");
  expect(requests.some((r) => r.includes("Terno-0.1.1-arm64-mac.zip"))).toBe(true);
  // no staged-rollout id, cookie or credential went out, and no id file was made in the profile
  for (const name of ["x-user-staging-id", "cookie", "authorization"]) expect(headerNames).not.toContain(name);
  expect(existsSync(join(profile(), ".updaterId"))).toBe(false);
});

test("an update downloads, Squirrel swaps the bundle and relaunches it, the profile is intact and the new version acknowledges", async () => {
  stage({ tamper: false });
  await launch({ TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US" });
  const threads = await page.locator("[data-testid=thread-row]").count();
  expect(threads).toBeGreaterThan(5);
  expect((await updates<{ status: string }>("check")).status).toBe("available");
  // local mode: the pill offers it, and downloading is the user's second yes
  await expect(page.getByTestId("update-pill")).toHaveText("Update 0.1.1");
  await page.getByTestId("update-pill").click();
  await page.getByTestId("update-download").click();
  await page.keyboard.press("Escape");
  // ready only once Squirrel validated the bundle's signature
  await expect.poll(async () => (await state()).status, { timeout: 180_000 }).toBe("ready");
  expect((await state()).ready?.version).toBe("0.1.1");
  // the user's way: the sidebar's accent pill, then Restart Now in its popover
  await expect(page.getByTestId("update-pill")).toHaveText("Restart to Update");
  await page.getByTestId("update-pill").click();
  await expect(page.getByTestId("update-popover")).toContainText("Terno 0.1.1");
  const closed = new Promise<void>((r) => app!.once("close", () => r()));
  await page.getByTestId("update-restart").click();
  await closed;
  app = null;

  // ShipIt swaps the bundle at the same path and relaunches it (not under Playwright: we watch its traces)
  await expect.poll(() => logLines().some((l) => l.code === "update.applied"), { timeout: 120_000, intervals: [1000] }).toBe(true);
  expect(bundleVersion()).toBe("0.1.1");
  execFileSync("codesign", ["--verify", "--deep", "--strict", bundle()]);
  const applied = logLines().find((l) => l.code === "update.applied")!;
  expect(applied.fields).toEqual({ fromVersion: "0.1.0", toVersion: "0.1.1" });
  expect(applied.version).toBe("0.1.1");
  // the quit before the swap went through the coordinated shutdown: the database closed, not killed
  expect(logLines().some((l) => l.code === "shutdown.done" && l.fields?.outcome === "closed" && l.fields?.trigger === "restart")).toBe(true);
  expect(existsSync(join(profile(), "updates/pending.json"))).toBe(false);

  // a plain quit of the relaunched app (SIGTERM is a quit): drafts, backend, then a clean database
  const pids = pidsOfBundle();
  expect(pids.length).toBeGreaterThan(0);
  const main = Math.min(...pids);
  process.kill(main, "SIGTERM");
  await expect.poll(() => pidsOfBundle().length, { timeout: 60_000 }).toBe(0);
  const wal = join(profile(), "terno.db-wal");
  expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
  const db = new DatabaseSync(join(profile(), "terno.db"), { readOnly: true });
  try {
    const { n } = db.prepare("SELECT count(*) AS n FROM threads").get() as { n: number };
    expect(n).toBeGreaterThanOrEqual(threads);
  } finally {
    db.close();
  }
});

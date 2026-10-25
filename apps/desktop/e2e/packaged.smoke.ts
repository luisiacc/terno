/**
 * Smoke test of the PACKAGED arm64 app, copied outside the repo so nothing can
 * resolve from the workspace. Demo mode seeds a mock mailbox in a temp profile.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");
let workdir: string;
let app: ElectronApplication;
let page: Page;
let appPath: string;
let userData: string;
let coldStartMs = 0;

test.beforeAll(async () => {
  test.skip(!existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-smoke-"));
  appPath = join(workdir, "Terno.app");
  execFileSync("ditto", [SOURCE_APP, appPath]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath]);
  userData = join(workdir, "profile");
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
  coldStartMs = Date.now() - started;
});

test.afterAll(async () => {
  await app?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("boots from app:// with the backend in a utility process", async () => {
  expect(page.url()).toBe("app://terno/");
  const types = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => m.type));
  expect(types).toContain("Utility");
  expect(await page.locator("[data-testid=thread-row]").count()).toBeGreaterThan(5);
  expect(await page.evaluate(() => document.documentElement.classList.contains("is-desktop"))).toBe(true);
  console.log(`cold start to first rows (includes seeding 3,000 demo threads): ${coldStartMs} ms`);
});

test("the window follows the theme: native theme, vibrancy and background, remembered for the next launch", async () => {
  const file = join(userData, "appearance.json");
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  // Terno claro sits on the native vibrancy
  await expect.poll(read).toMatchObject({ themeSource: "system", vibrancy: true });
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-vibrancy"))).toBe(true);
  // a named palette renders exactly: opaque window in its own background
  await page.evaluate(() => {
    localStorage.setItem("terno:appearance", JSON.stringify({ mode: "dark", light: "terno-light", dark: "nord", motion: 75, vibrancy: { light: true, dark: false } }));
    (window as any).ternoDesktop.setAppearance({ themeSource: "dark", background: "#2e3440", vibrancy: false });
  });
  await expect.poll(read).toMatchObject({ themeSource: "dark", background: "#2e3440", vibrancy: false });
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  // put it back for the rest of the suite
  await page.evaluate(() => {
    localStorage.removeItem("terno:appearance");
    (window as any).ternoDesktop.setAppearance({ themeSource: "system", background: "#fcfcfa", vibrancy: true });
  });
  await expect.poll(read).toMatchObject({ themeSource: "system", vibrancy: true });
});

test("searches, opens and archives with the keyboard", async () => {
  await page.keyboard.press("/");
  await page.keyboard.type("factura");
  await expect(page.getByTestId("search-stats")).toContainText("results");
  await page.keyboard.press("Escape"); // leave the input, keep the query
  const first = page.locator("[data-testid=thread-row]").first();
  await first.click();
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  const id = await first.getAttribute("data-thread-id");
  // clear search, go to inbox, archive the selected thread with "e"
  await page.getByTestId("nav-inbox").click();
  const row = page.locator("[data-testid=thread-row]").first();
  const inboxId = await row.getAttribute("data-thread-id");
  await row.click();
  await page.keyboard.press("e");
  await expect(page.locator(`[data-thread-id="${inboxId}"]`)).toHaveCount(0);
  expect(id).toBeTruthy();
  await page.screenshot({ path: join(here, "../../../test-results/desktop-smoke/packaged-app.png") });
});

test("local mode (the default for a new profile): main cancels the renderer's remote requests", async () => {
  await expect(page.getByTestId("local-pill")).toHaveText("Local");
  // observe cancellations in main itself, so a failure for any other reason (offline, CSP) doesn't count
  await app.evaluate(({ session }) => {
    const g = globalThis as unknown as { blocked: string[] };
    g.blocked = [];
    session.defaultSession.webRequest.onErrorOccurred((d) => {
      if (d.error === "net::ERR_BLOCKED_BY_CLIENT") g.blocked.push(d.url);
    });
  });
  const result = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const img = new Image();
        img.onload = () => resolve("loaded");
        img.onerror = () => resolve("error");
        img.src = `https://example.com/pixel.png?smoke=${Date.now()}`;
      }),
  );
  expect(result).toBe("error");
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { blocked: string[] }).blocked)).toContainEqual(expect.stringContaining("https://example.com/pixel.png"));
});

test("the bundled terno-mcp wrapper answers MCP requests against the running app", async () => {
  const wrapper = join(appPath, "Contents/Resources/bin/terno-mcp");
  const env = { ...process.env, TERNO_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(wrapper, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  child.stdout.setEncoding("utf8").on("data", (d: string) => lines.push(...d.split("\n").filter(Boolean)));
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_accounts", arguments: {} } });
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));
  const reply = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  const payload = JSON.parse(reply.result.content[0].text);
  expect(payload.accounts).toHaveLength(4);
});

test("a release carries no test build's world: no baked feed or profile, GitHub's feed, a stable signature for Squirrel", async () => {
  // app.asar: a pickled JSON header (size at byte 12, from byte 16), then the files
  const asar = readFileSync(join(appPath, "Contents/Resources/app.asar"));
  const headerSize = asar.readUInt32LE(12);
  const header = JSON.parse(asar.subarray(16, 16 + headerSize).toString("utf8")) as { files: Record<string, { files?: Record<string, { offset: string; size: number }> }> };
  const dist = header.files.dist!.files!;
  expect(Object.keys(dist)).not.toContain("test-build.json");
  expect(Object.keys(dist)).toContain("updater.cjs");
  const base = 8 + asar.readUInt32LE(4);
  const main = dist["main.cjs"]!;
  const code = asar.subarray(base + Number(main.offset), base + Number(main.offset) + main.size).toString("utf8");
  // the define was never applied: TEST_BUILD is undefined at runtime, whatever the environment says
  expect(code).toContain("__TERNO_TEST_BUILD__");
  expect(readFileSync(join(appPath, "Contents/Resources/app-update.yml"), "utf8")).toMatch(/^owner: luisiacc\nrepo: terno\nprovider: github\n/);
  const signature = spawnSync("codesign", ["-dv", "--verbose=2", appPath], { encoding: "utf8" }).stderr;
  if (!/Signature=adhoc/.test(signature)) expect(execFileSync("codesign", ["-d", "-r-", appPath], { encoding: "utf8" })).toContain('identifier "dev.terno.mail"');
});

test("warm start: relaunching with an existing mailbox shows mail fast", async () => {
  await app.close();
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
    page = await app.firstWindow();
    await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 30_000 });
    samples.push(Date.now() - started);
    if (i < 2) await app.close();
  }
  const best = Math.min(...samples);
  console.log(`warm start to first rows: ${samples.join(" / ")} ms`);
  // includes process spawn, Chromium init, utility process + SQLite open, first query and paint
  expect(best).toBeLessThan(1500);
});

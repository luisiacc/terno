/**
 * Smoke test of the PACKAGED arm64 app, copied outside the repo so nothing can
 * resolve from the workspace. Demo mode seeds a mock mailbox in a temp profile.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { parseRaw } from "@terno/mail";
import { SMTPServer } from "smtp-server";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");
let workdir: string;
let app: ElectronApplication;
let page: Page;
let appPath: string;
let userData: string;
let coldStartMs = 0;
/** plan 16: what the demo mailbox sent, through the real SMTP path, to this test's own server */
const smtpReceived: string[] = [];
let smtp: SMTPServer | null = null;

test.beforeAll(async () => {
  test.skip(!existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-smoke-"));
  appPath = join(workdir, "Terno.app");
  execFileSync("ditto", [SOURCE_APP, appPath]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath]);
  userData = join(workdir, "profile");
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onAuth: (_a, _s, cb) => cb(null, { user: "smoke" }),
    onData(stream, _session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => (smtpReceived.push(Buffer.concat(chunks).toString("utf8")), cb()));
    },
  });
  await new Promise<void>((r) => smtp!.listen(0, "127.0.0.1", r));
  const smtpPort = (smtp.server.address() as { port: number }).port;
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: userData, TERNO_TEST_SMTP_PORT: String(smtpPort) };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
  coldStartMs = Date.now() - started;
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => (smtp ? smtp.close(() => r()) : r()));
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

test("the window follows the design and the theme: Lumen by default (opaque, its faces in the bundle), macOS on the vibrancy, remembered", async () => {
  const file = join(userData, "appearance.json");
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  // a new profile: Lumen in its own colors, painted by theme.js, its faces loaded from app:// (packed, not fetched)
  expect(await page.evaluate(() => document.documentElement.dataset.design)).toBe("lumen");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("lumen-light");
  await expect.poll(() => page.evaluate(() => document.fonts.check('700 24px "Figtree Variable"'))).toBe(true);
  expect(await page.evaluate(() => [...document.fonts].some((f) => f.family.includes("Figtree") && f.status === "loaded"))).toBe(true);
  // Lumen's paper sidebar is opaque: no native vibrancy behind it
  await expect.poll(read).toMatchObject({ themeSource: "system", vibrancy: false });
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-vibrancy"))).toBe(false);
  // macOS: Terno Light sits on the native vibrancy
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-appearance").click();
  await page.getByTestId("design-card-macos").click();
  await expect(page.locator("html")).toHaveAttribute("data-design", "macos");
  await page.keyboard.press("Escape");
  await expect.poll(read).toMatchObject({ themeSource: "system", vibrancy: true });
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-vibrancy"))).toBe(true);
  // a named palette renders exactly: opaque window in its own background
  await page.evaluate(() => (window as any).ternoDesktop.setAppearance({ themeSource: "dark", background: "#2e3440", vibrancy: false }));
  await expect.poll(read).toMatchObject({ themeSource: "dark", background: "#2e3440", vibrancy: false });
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  // put it back for the rest of the suite (macOS, light by the system)
  await page.evaluate(() => (window as any).ternoDesktop.setAppearance({ themeSource: "system", background: "#fcfcfa", vibrancy: true }));
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

test("plan 16: a formatted reply is sent as multipart/alternative through the packaged app's SMTP path", async () => {
  await page.getByTestId("nav-inbox").click();
  await page.locator("[data-testid=thread-row]").first().click();
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("r");
  const body = page.getByTestId("compose-body");
  await expect(body).toBeFocused({ timeout: 15_000 });
  await page.keyboard.type("Desde el empaquetado: ");
  await page.keyboard.press("Meta+b");
  await page.keyboard.type("negrita");
  await page.keyboard.press("Meta+b");
  await page.getByTestId("format-bulleted").click();
  await expect(body.locator("ul li b")).toHaveText("negrita");
  await page.keyboard.press("Meta+Enter");
  await expect.poll(() => smtpReceived.length, { timeout: 20_000 }).toBe(1);
  const raw = smtpReceived[0]!;
  expect(raw).toMatch(/^Content-Type: multipart\/alternative;/m);
  const mail = await parseRaw(raw);
  expect(mail.html).toContain("<b>negrita</b>");
  expect(mail.html).not.toMatch(/<style|class=/);
  expect(mail.text).toContain("• Desde el empaquetado: negrita");
});

test("plan 18: the packaged backend suggests recipients from its index", async () => {
  await page.getByTestId("nav-inbox").click();
  const sender = (await page.locator("[data-testid=thread-row] [data-testid=row-from]").first().textContent())!.trim();
  const word = sender.split(/\s+/)[0]!;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
  const to = page.getByTestId("compose-to");
  await expect(to).toBeFocused({ timeout: 15_000 });
  await page.keyboard.type(word.slice(0, 3), { delay: 40 });
  const list = page.locator("[data-testid=recipient-suggestions]");
  await expect(list).toBeVisible({ timeout: 15_000 });
  await expect(list.getByTestId("recipient-suggestion").first()).toBeVisible();
  await page.keyboard.press("Enter");
  // plan 26: the accepted recipient is a chip, the input ready for the next one
  await expect(page.getByTestId("compose-to-field").getByTestId("recipient-chip")).toHaveCount(1);
  await expect(page.getByTestId("compose-to-field").getByTestId("recipient-chip")).toHaveAttribute("data-email", /@/);
  await expect(to).toHaveValue("");
  await page.keyboard.press("Escape");
});

test("plan 22: the packaged backend can fetch website icons, and they're off in local mode until turned on (nothing is fetched here)", async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Meta+,");
  await page.getByTestId("tab-appearance").click();
  const row = page.getByTestId("site-icons-row");
  await row.scrollIntoViewIfNeeded();
  // the desktop host has the node:https transport (the switch is live, unlike the web's), and local mode keeps it off
  await expect(page.getByTestId("site-icons-switch")).toBeEnabled();
  await expect(page.getByTestId("site-icons-switch")).not.toBeChecked();
  await expect(row).toContainText("Off in local mode");
  await page.keyboard.press("Escape");
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

test("the app carries Terno's icon: the macOS 26 asset catalog and the grid-drawn .icns (plan 19)", async () => {
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(appPath, "Contents/Info.plist")], { encoding: "utf8" })) as Record<string, unknown>;
  expect(info.CFBundleIconName).toBe("Icon");
  expect(info.CFBundleIconFile).toBe("icon.icns");
  const resources = join(appPath, "Contents/Resources");
  expect(readFileSync(join(resources, "icon.icns")).equals(readFileSync(join(here, "../resources/icon.icns")))).toBe(true);
  expect(readFileSync(join(resources, "Assets.car")).equals(readFileSync(join(here, "../resources/Assets.car")))).toBe(true);
  // the catalog holds the icon named in Info.plist, in light, dark and tinted
  const renditions = execFileSync("xcrun", ["assetutil", "--info", join(resources, "Assets.car")], { encoding: "utf8" });
  for (const appearance of ["NSAppearanceNameAqua", "NSAppearanceNameDarkAqua", "ISAppearanceTintable"]) expect(renditions).toContain(appearance);
  expect(renditions).toMatch(/"Name" : "Icon"/);
});

test("plan 21: More's state and the panes' widths survive a real restart on app://; the edges are never a window drag area", async () => {
  const handle = page.getByTestId("pane-handle-sidebar");
  // the boundary's top runs through the title band (the sidebar's drag region): there it's the handle's, and no-drag
  const b = (await handle.boundingBox())!;
  expect(await page.evaluate(([x, y]) => (document.elementFromPoint(x!, y!) as HTMLElement | null)?.closest("[data-testid]")?.getAttribute("data-testid"), [b.x + b.width / 2, b.y + 10])).toBe("pane-handle-sidebar");
  expect(await handle.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region"))).toBe("no-drag");
  await handle.focus();
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "360");
  await page.getByTestId("nav-more").click();
  await expect(page.getByTestId("nav-trash")).toBeVisible();
  await app.close();
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 30_000 });
  await expect(page.getByTestId("pane-handle-sidebar")).toHaveAttribute("aria-valuenow", "360");
  expect((await page.getByTestId("sidebar").boundingBox())!.width).toBeCloseTo(360, 0);
  await expect(page.getByTestId("nav-more")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("nav-trash")).toBeVisible();
  // back to the defaults for what follows
  await page.getByTestId("pane-handle-sidebar").dblclick();
  await page.getByTestId("nav-more").click();
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

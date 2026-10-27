import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { openDatabase, SqlMailStore } from "../../../packages/db/src/index";

const here = dirname(fileURLToPath(import.meta.url)), repo = join(here, "../../..");
const DEV = process.env.TERNO_RELOAD_SMOKE_DEV === "1", source = join(here, "../release/mac-arm64/Terno.app");
const requireWeb = createRequire(join(repo, "apps/web/package.json"));
const axeSource = readFileSync(requireWeb.resolve("axe-core/axe.min.js"), "utf8");
const shots = "/tmp/terno-missing-draft-r3-shots";
let work: string, profile: string, app: ElectronApplication, page: Page, sequence = 0;
declare global { interface Window { nativeReloadProbe: { nonce: string; pagehides: number; dropCopy: boolean; copyCommitted: boolean; gateSave: boolean; reached: boolean; release?: () => void } } }

async function store<T>(run: (store: SqlMailStore) => Promise<T>): Promise<T> {
  const local = new SqlMailStore(openDatabase(join(profile, "terno.db")));
  try { return await run(local); } finally { await local.close(); }
}
async function menu(id = "native-reload") {
  await app.evaluate(({ app: a, Menu, BrowserWindow }, id) => {
    const owner = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!;
    a.focus({ steal: true }); owner.show(); owner.focus(); owner.webContents.focus(); Menu.getApplicationMenu()!.getMenuItemById(id)!.click();
  }, id);
}
async function shortcut(ignoreCache = false) {
  await app.evaluate(({ app: a, BrowserWindow }, ignoreCache) => {
    const owner = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!;
    a.focus({ steal: true }); owner.show(); owner.focus(); owner.webContents.focus();
    const modifiers = ignoreCache ? ["meta", "shift"] : ["meta"];
    owner.webContents.sendInputEvent({ type: "keyDown", keyCode: "R", modifiers });
    owner.webContents.sendInputEvent({ type: "keyUp", keyCode: "R", modifiers });
  }, ignoreCache);
}
async function axe(scope?: string) {
  await page.evaluate(axeSource);
  const violations = await page.evaluate(async (scope) => {
    const checker: { run(context: Document | Element): Promise<{ violations: unknown[] }> } = Reflect.get(window, "axe");
    return (await checker.run(scope ? document.querySelector(scope)! : document)).violations;
  }, scope);
  expect(violations).toEqual([]);
}
async function endOfBody(body: Locator) {
  await body.evaluate((el) => {
    el.focus(); const selection = getSelection(), range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
    selection!.removeAllRanges(); selection!.addRange(range); document.dispatchEvent(new Event("selectionchange"));
  });
  await body.press("ArrowLeft"); await body.press("ArrowRight");
}
test.beforeAll(() => {
  test.skip(!DEV && !existsSync(source), "run pnpm dist:mac first"); work = mkdtempSync("/tmp/terno-native-reload-"); mkdirSync(shots, { recursive: true });
  if (DEV) {
    const bundle = join(work, "Electron.app"), info = join(bundle, "Contents/Info.plist");
    execFileSync("ditto", [join(here, "../node_modules/electron/dist/Electron.app"), bundle]);
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIdentifier dev.terno.native-reload-test", info]);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements,flags", bundle]);
  } else {
    execFileSync("ditto", [source, join(work, "Terno.app")]); execFileSync("codesign", ["--verify", "--deep", "--strict", join(work, "Terno.app")]);
  }
});
test.beforeEach(async () => {
  profile = join(work, `profile-${++sequence}`);
  execFileSync("pnpm", ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", profile, "--accounts", "2", "--threads", "300"], { cwd: repo, stdio: "ignore" });
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_USER_DATA: profile, TERNO_TEST_APP_DATA: join(work, "appdata"), TERNO_TEST_APP_NAME: "TernoNativeReloadTest", TERNO_TEST_LANGUAGES: "en-US" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TERNO_DEV_URL;
  app = await electron.launch({ executablePath: DEV ? join(work, "Electron.app/Contents/MacOS/Electron") : join(work, "Terno.app/Contents/MacOS/Terno"), ...(DEV ? { args: [join(here, "../dist/main.cjs")] } : {}), env });
  console.info("captured synthetic native app PID", app.process().pid);
  page = await app.firstWindow(); await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
  await page.addInitScript(() => {
    window.nativeReloadProbe = { nonce: crypto.randomUUID(), pagehides: 0, dropCopy: false, copyCommitted: false, gateSave: false, reached: false };
    window.addEventListener("pagehide", () => { window.nativeReloadProbe.pagehides++; });
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data !== "terno:backend-port" || !event.ports[0]) return;
      const port = event.ports[0], send = port.postMessage.bind(port);
      let copy: number | null = null, save: number | null = null;
      port.postMessage = (message: unknown, options?: Transferable[] | StructuredSerializeOptions) => {
        if (message && typeof message === "object" && Reflect.get(message, "t") === "req" && Reflect.get(message, "m") === "drafts.save") {
          const p = Reflect.get(message, "p");
          if (window.nativeReloadProbe.dropCopy && !p.id) { copy = Reflect.get(message, "id"); window.nativeReloadProbe.dropCopy = false; }
          if (window.nativeReloadProbe.gateSave) { save = Reflect.get(message, "id"); window.nativeReloadProbe.gateSave = false; }
        }
        if (Array.isArray(options)) send(message, options); else send(message, options);
      };
      port.addEventListener("message", (event) => {
        const response = event.data;
        if (response?.t !== "res") return;
        if (response.id === copy) { event.stopImmediatePropagation(); copy = null; window.nativeReloadProbe.copyCommitted = response.ok === true; }
        if (response.id === save) {
          event.stopImmediatePropagation(); save = null; window.nativeReloadProbe.reached = true;
          window.nativeReloadProbe.release = () => port.dispatchEvent(new MessageEvent("message", { data: response }));
        }
      }, { capture: true });
    });
  });
  await page.reload(); await page.getByTestId("thread-row").first().waitFor(); await page.bringToFront();
});
test.afterEach(async () => { await app?.close(); });
test.afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

for (const state of ["missing", "unknown"] as const) test(`native menu and CmdR/CmdShiftR retain ${state} work, and only disclosed override discards it`, async () => {
  await page.getByTestId("compose-button").click(); const body = page.getByTestId("compose-body");
  await body.click(); await body.press("Meta+b"); await page.keyboard.type("native exact work");
  await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.test>, bob@');
  await page.getByTestId("attachment-input").setInputFiles({ name: "native.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const original = (await store((s) => s.drafts.list()))[0]!; await store((s) => s.drafts.delete(original.id, original.generation));
  await endOfBody(body); await page.keyboard.type(" latest");
  await expect(body).toHaveText("native exact work latest"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  if (state === "unknown") {
    await page.evaluate(() => { window.nativeReloadProbe.dropCopy = true; }); await page.getByTestId("draft-save-copy").click();
    await expect.poll(() => page.evaluate(() => window.nativeReloadProbe.copyCommitted)).toBe(true);
    await expect(page.getByTestId("draft-status")).toContainText("may already exist", { timeout: 35_000 });
  }
  await body.click(); await body.press("ArrowRight"); await body.press("Meta+ArrowRight"); await body.press("ArrowLeft"); await page.getByTestId("format-italic").click();
  const html = await body.innerHTML(), caret = await page.evaluate(() => ({ offset: getSelection()?.anchorOffset, text: getSelection()?.anchorNode?.textContent }));
  let navigations = 0; page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await menu(); await expect(page.getByTestId("native-reload-notice")).toBeVisible(); expect(navigations).toBe(0);
  await expect(body).toBeFocused(); expect(await body.innerHTML()).toBe(html);
  expect(await page.evaluate(() => ({ offset: getSelection()?.anchorOffset, text: getSelection()?.anchorNode?.textContent }))).toEqual(caret);
  await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("native-reload-notice").getByRole("button", { name: "Close", exact: true }).click();
  await body.focus(); await shortcut(); await expect(page.getByTestId("native-reload-notice")).toBeVisible();
  await shortcut(true); await expect(page.getByTestId("native-reload-notice")).toBeVisible(); expect(navigations).toBe(0);
  await menu("native-force-reload"); expect(navigations).toBe(0);
  for (const design of DEV && state === "missing" ? ["macos", "lumen", "atelier"] : ["macos"]) for (const theme of ["light", "dark"] as const) {
    await page.getByTestId("native-reload-notice").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByTestId("open-settings").click(); await page.getByTestId("tab-appearance").click();
    await page.getByTestId(`design-card-${design}`).click(); await page.getByTestId(`theme-card-design-${theme}`).click(); await page.getByTestId(`mode-${theme}`).click(); await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-design", design); await expect(page.locator("html")).toHaveAttribute("data-theme", `${design === "macos" ? "terno" : design}-${theme}`);
    await menu(); await expect(page.getByTestId("native-reload-notice")).toBeVisible();
    await axe('[data-testid="native-reload-notice"]'); await page.screenshot({ path: join(shots, `native-${state}-${DEV ? "source" : "packaged"}-${design}-${theme}.png`) });
  }
  await page.getByTestId("native-reload-review").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("recovery-workspace")).toContainText("Save a copy or discard it before reloading.");
  await expect(page.getByTestId("recovery-details")).toHaveText("Back to Terno"); await expect(body).toBeFocused(); expect(await body.innerHTML()).toBe(html);
  expect(await page.evaluate(() => ({ offset: getSelection()?.anchorOffset, text: getSelection()?.anchorNode?.textContent }))).toEqual(caret);
  await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
  await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 1000));
  await page.keyboard.type("X"); await body.press("Meta+z"); expect(await body.innerHTML()).toBe(html);
  const priorIds = (await store((s) => s.drafts.list())).map((d) => d.id);
  await page.getByTestId("draft-save-copy").click(); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const copy = (await store((s) => s.drafts.list())).find((d) => !priorIds.includes(d.id))!;
  expect(copy.body_text).toBe("native exact work latest"); expect(copy.body_html).toBe("<div><b>native exact work latest</b></div>");
  expect(JSON.parse(copy.to_json)).toEqual([{ name: "Pérez, Ana", email: "ana@example.test" }, { name: "", email: "bob@" }]);
  const ref = JSON.parse(copy.attachments_json)[0]; expect(await store((s) => s.attachments.read(copy.account_id, ref.assetId, 0))).toBe("AP+A");
  await menu(); await page.getByTestId("thread-row").first().waitFor(); expect(navigations).toBe(1);
  await page.getByTestId("compose-button").click(); await body.fill("explicitly discard only");
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const target = (await store((s) => s.drafts.list())).find((d) => d.body_text === "explicitly discard only")!; await store((s) => s.drafts.delete(target.id, target.generation));
  await body.click(); await body.press("ArrowRight"); await page.keyboard.type(" latest"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  await menu(); await expect(page.getByTestId("native-reload-anyway")).toHaveAccessibleName("Reload anyway and discard unsaved changes and pending files");
  await page.getByTestId("native-reload-anyway").click(); await page.getByTestId("thread-row").first().waitFor(); expect(navigations).toBe(2);
});

test("native reload holds the exact saved ACK through changed focus and document commit", async () => {
  await page.getByTestId("compose-button").click(); const body = page.getByTestId("compose-body");
  await page.evaluate(() => { window.nativeReloadProbe.gateSave = true; }); await body.fill("latest before native ACK");
  await menu(); await expect.poll(() => page.evaluate(() => window.nativeReloadProbe.reached)).toBe(true);
  await expect(page.getByTestId("draft-status")).toContainText("Draft editing is paused");
  await shortcut(); await shortcut(true);
  await body.focus(); await page.keyboard.type(" must not be admitted"); await expect(body).toHaveText("latest before native ACK");
  const other = await app.evaluate(async ({ BrowserWindow }) => {
    const other = new BrowserWindow({ show: true, webPreferences: { sandbox: true } });
    await other.loadURL("data:text/html,<title>Synthetic focus control</title>"); other.focus(); other.webContents.focus(); return other.webContents.id;
  });
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.getFocusedWebContents()?.id === id, other)).toBe(true);
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() }), page.evaluate(() => window.nativeReloadProbe.release!())]); await page.getByTestId("thread-row").first().waitFor();
  await expect.poll(() => store(async (s) => (await s.drafts.list())[0]?.body_text)).toBe("latest before native ACK");
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getOwnerBrowserWindow()?.destroy(), other);
});

test("the exact owned detached DevTools frontend reload admits its inspected page", async () => {
  await page.getByTestId("compose-button").click(); const body = page.getByTestId("compose-body");
  await body.fill("DevTools retained"); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const old = (await store((s) => s.drafts.list()))[0]!; await store((s) => s.drafts.delete(old.id, old.generation));
  await endOfBody(body); await page.keyboard.type(" latest"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  let navigations = 0; page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  const nonce = await page.evaluate(() => window.nativeReloadProbe.nonce);
  await app.evaluate(async ({ app: a, BrowserWindow }) => {
    a.focus({ steal: true }); const owner = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!;
    await new Promise<void>((resolve) => { owner.webContents.once("devtools-opened", () => resolve()); owner.webContents.openDevTools({ mode: "detach", activate: true }); });
  });
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const owner = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!;
    const trace: string[] = []; Reflect.set(owner, "nativeTrace", trace);
    const send = owner.webContents.send.bind(owner.webContents);
    owner.webContents.send = (...args: Parameters<typeof send>) => { if (trace.length < 32) trace.push(`send:${args[0]}:${args[1]}`); send(...args); };
    for (const name of ["devtools-reload-page", "did-start-navigation", "did-navigate", "did-stop-loading", "did-fail-load", "did-fail-provisional-load"] as const) owner.webContents.on(name, () => { if (trace.length < 32) trace.push(`${name}:${owner.webContents.isLoadingMainFrame()}`); });
    ipcMain.on("terno:flush-done", (_e, _id, saved) => { if (trace.length < 32) trace.push(`flush-done:${saved}`); });
  });
  await app.evaluate(async ({ BrowserWindow }) => {
    const tools = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!.webContents.devToolsWebContents!;
    await tools.executeJavaScript('InspectorFrontendHost.sendMessageToBackend(JSON.stringify({id:1000001,method:"Page.reload",params:{}}))');
  });
  try { await expect(page.getByTestId("native-reload-notice")).toBeVisible(); }
  finally { console.info("DevTools trace", await app.evaluate(({ BrowserWindow }) => Reflect.get(BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!, "nativeTrace")), "renderer", await page.evaluate(() => ({ nonce: window.nativeReloadProbe.nonce, pagehides: window.nativeReloadProbe.pagehides })), "navigations", navigations); }
  expect(navigations).toBe(0); await expect(body).toHaveText("DevTools retained latest");
  expect(await page.evaluate(() => ({ nonce: window.nativeReloadProbe.nonce, pagehides: window.nativeReloadProbe.pagehides }))).toEqual({ nonce, pagehides: 0 });
  await page.getByTestId("native-reload-review").click(); await page.getByTestId("draft-save-copy").click(); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  await app.evaluate(async ({ BrowserWindow }) => {
    const tools = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!.webContents.devToolsWebContents!;
    await tools.executeJavaScript('InspectorFrontendHost.sendMessageToBackend(JSON.stringify({id:1000002,method:"Page.reload",params:{ignoreCache:true}}))');
  });
  await page.getByTestId("thread-row").first().waitFor(); expect(navigations).toBe(1);
  await expect.poll(() => store(async (s) => (await s.drafts.list())[0]?.body_text)).toBe("DevTools retained latest");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!.webContents.closeDevTools());
});

for (const theme of ["light", "dark"] as const) test(`a real React fatal screen and an already-open recovery editor keep native warning actions reachable (${theme})`, async () => {
  test.skip(!DEV, "the render-error probe is compiled only into the source test build");
  await page.getByTestId("open-settings").click(); await page.getByTestId("tab-appearance").click(); await page.getByTestId(`mode-${theme}`).click(); await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", `lumen-${theme}`);
  await page.getByTestId("compose-button").click(); const body = page.getByTestId("compose-body"); await body.fill("fatal retained");
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved"); const old = (await store((s) => s.drafts.list()))[0]!; await store((s) => s.drafts.delete(old.id, old.generation));
  await body.click(); await body.press("ArrowRight"); await page.keyboard.type(" latest"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  await page.evaluate("window.__terno.throwIn('app')"); await expect(page.getByTestId("app-boundary")).toBeVisible(); await menu();
  await expect(page.getByTestId("native-reload-notice")).toBeVisible(); await axe(); await page.screenshot({ path: join(shots, `native-fatal-${theme}.png`) });
  await page.getByTestId("native-reload-review").click(); await expect(page.getByTestId("recovery-workspace")).toBeVisible(); await menu();
  await expect(page.getByTestId("native-reload-notice")).toBeVisible(); await axe(); await page.screenshot({ path: join(shots, `native-workspace-${theme}.png`) });
});

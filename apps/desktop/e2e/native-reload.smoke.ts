import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { blockExternal, cleanupOwned, closePackaged } from "./packaged-fixture";
import { openDatabase, SqlMailStore } from "../../../packages/db/src/index";

const here = dirname(fileURLToPath(import.meta.url)), repo = join(here, "../../..");
const DEV = process.env.TERNO_RELOAD_SMOKE_DEV === "1", source = join(here, "../release/mac-arm64/Terno.app");
const requireWeb = createRequire(join(repo, "apps/web/package.json"));
const axeSource = readFileSync(requireWeb.resolve("axe-core/axe.min.js"), "utf8");
const shots = process.env.TERNO_RELOAD_SMOKE_SHOTS ?? mkdtempSync("/tmp/terno-native-reload-shots-");
let work: string, profile: string, app: ElectronApplication, page: Page, sequence = 0;
declare global { interface Window { nativeReloadProbe: { nonce: string; pagehides: number; dropCopy: boolean; copyCommitted: boolean; copyIdentity?: { id: number; generation: string; revision: number }; gateSave: boolean; reached: boolean; release?: () => void } } }

async function store<T>(run: (store: SqlMailStore) => Promise<T>): Promise<T> {
  const local = new SqlMailStore(openDatabase(join(profile, "terno.db")));
  try { return await run(local); } finally { await local.close(); }
}
async function committedCopy() {
  await expect.poll(() => page.evaluate(() => window.nativeReloadProbe.copyCommitted)).toBe(true);
  const identity = await page.evaluate(() => window.nativeReloadProbe.copyIdentity!);
  const saved = (await store((s) => s.drafts.list())).find((draft) => draft.id === identity.id);
  expect(saved).toMatchObject({ id: identity.id, generation: identity.generation, revision: identity.revision });
}
async function menu(id = "native-reload") {
  await app.evaluate(({ app: a, Menu, BrowserWindow }, id) => {
    const owner = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!;
    a.focus({ steal: true }); owner.show(); owner.focus(); owner.webContents.focus(); const item = Menu.getApplicationMenu()!.getMenuItemById(id)!;
    // Electron supplies this window when the OS invokes the menu callback.
    item.click(item, owner, undefined);
  }, id);
}
async function shortcut(ignoreCache = false) {
  await app.evaluate(({ app: a, BrowserWindow }, ignoreCache) => {
    const owner = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === "app://terno/")!;
    a.focus({ steal: true }); owner.show(); owner.focus(); owner.webContents.focus();
    const modifiers: ("meta" | "shift")[] = ignoreCache ? ["meta", "shift"] : ["meta"];
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
  console.info("native reload screenshot directory", shots);
  if (DEV) {
    const bundle = join(work, "Electron.app"), info = join(bundle, "Contents/Info.plist");
    execFileSync("ditto", [join(here, "../node_modules/electron/dist/Electron.app"), bundle]);
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIdentifier dev.terno.native-reload-test", info]);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements,flags", bundle]);
  } else {
    execFileSync("ditto", [source, join(work, "Terno.app")]); execFileSync("codesign", ["--verify", "--deep", "--strict", join(work, "Terno.app")]);
  }
});

const stoppedCases: [string, "missing" | "unknown"][] = DEV ? [["macos", "missing"], ["lumen", "missing"], ["atelier", "missing"], ["lumen", "unknown"]] : [["lumen", "missing"], ["lumen", "unknown"]];
for (const [design, state] of stoppedCases) test(`real stopped-engine modal permits keyboard Review of ${state} work (${design})`, async () => {
  await page.getByTestId("open-settings").click(); await page.getByTestId("tab-appearance").click();
  await page.getByTestId(`design-card-${design}`).click(); await page.getByTestId("mode-system").click(); await page.keyboard.press("Escape");
  await page.getByTestId("compose-button").click(); const body = page.getByTestId("compose-body");
  await body.click(); await body.press("Meta+b"); await page.keyboard.type("stopped exact work");
  await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.test>, bob@');
  await page.getByTestId("attachment-input").setInputFiles({ name: "stopped.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const original = (await store((s) => s.drafts.list()))[0]!; await store((s) => s.drafts.delete(original.id, original.generation));
  await endOfBody(body); await page.keyboard.type(" latest"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  if (state === "unknown") {
    await page.evaluate(() => { window.nativeReloadProbe.dropCopy = true; }); await page.getByTestId("draft-save-copy").click();
    await committedCopy();
    await expect(page.getByTestId("draft-status")).toContainText("may already exist", { timeout: 35_000 });
  }
  await endOfBody(body); await body.press("ArrowLeft"); await page.getByTestId("format-italic").click();
  const html = await body.innerHTML(), caret = await page.evaluate(() => ({ offset: getSelection()?.anchorOffset, text: getSelection()?.anchorNode?.textContent }));
  await page.getByTestId("open-settings").click(); await page.getByTestId("tab-general").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  const backendPid = () => app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => m.type === "Utility" && m.name === "Terno Mail Engine")?.pid ?? null);
  const killed: number[] = [];
  for (let i = 0; i < 6 && !(await page.getByTestId("engine-stopped").isVisible()); i++) {
    await expect.poll(backendPid, { timeout: 20_000 }).not.toBeNull(); const pid = (await backendPid())!;
    const birth = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    console.info("captured own backend PID/birth", pid, birth); killed.push(pid);
    if (birth && execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() === birth) process.kill(pid, "SIGKILL");
    await expect.poll(async () => (await backendPid()) !== pid || await page.getByTestId("engine-stopped").isVisible(), { timeout: 20_000 }).toBe(true);
    if (!(await page.getByTestId("engine-stopped").isVisible())) await expect.poll(async () => (await backendPid()) !== null || await page.getByTestId("engine-stopped").isVisible(), { timeout: 20_000 }).toBe(true);
  }
  await expect(page.getByTestId("engine-stopped")).toBeVisible(); expect(await backendPid()).toBeNull();
  console.info("stopped-policy owned PIDs", killed);
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  const dialog = page.getByTestId("engine-stopped"); await expect(page.locator("#root")).toHaveJSProperty("inert", true);
  let navigations = 0; page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });
  await menu(); await shortcut(); await shortcut(true);
  await expect(dialog.getByTestId("native-reload-notice")).toBeVisible();
  await expect(page.getByTestId("native-reload-notice")).toHaveCount(1); expect(navigations).toBe(0);
  for (const command of [() => menu(), () => shortcut(), () => shortcut(true)]) {
    await dialog.getByTestId("native-reload-close").click(); await command();
    await expect(dialog.getByTestId("native-reload-notice")).toBeVisible(); expect(navigations).toBe(0);
  }
  await page.getByTestId("engine-retry").focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await expect(page.getByTestId("native-reload-review")).toBeFocused();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", `${design === "macos" ? "terno" : design}-${theme}`);
    await axe(); await page.screenshot({ path: join(shots, `stopped-${DEV ? "source" : "packaged"}-${design}-${state}-${theme}.png`) });
  }
  await page.keyboard.press("Enter"); await expect(page.getByTestId("recovery-workspace")).toBeVisible();
  await expect(dialog).toHaveCount(0); await expect(page.locator("#root")).toHaveJSProperty("inert", false);
  await expect(body).toHaveCount(1); await expect(body).toBeFocused(); expect(await body.innerHTML()).toBe(html);
  expect(await page.evaluate(() => ({ offset: getSelection()?.anchorOffset, text: getSelection()?.anchorNode?.textContent }))).toEqual(caret);
  await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("recovery-workspace")).toContainText("Pérez, Ana"); await expect(page.getByTestId("recovery-workspace")).toContainText("bob@");
  await expect(page.getByTestId("recovery-workspace")).toContainText("stopped.bin"); expect(await backendPid()).toBeNull();
  await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 1000)); await page.keyboard.type("X"); await body.press("Meta+z"); expect(await body.innerHTML()).toBe(html);
  const ref = JSON.parse(original.attachments_json)[0]; expect(await store((s) => s.attachments.read(original.account_id, ref.assetId, 0))).toBe("AP+A");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", `${design === "macos" ? "terno" : design}-${theme}`);
    await axe(); await page.screenshot({ path: join(shots, `stopped-review-${DEV ? "source" : "packaged"}-${design}-${state}-${theme}.png`) });
  }
  await page.getByTestId("recovery-details").click(); await expect(dialog).toBeVisible(); expect(await backendPid()).toBeNull();
  await menu(); await expect(dialog.getByTestId("native-reload-anyway")).toHaveAccessibleName("Reload anyway and discard unsaved changes and pending files");
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() }), dialog.getByTestId("native-reload-anyway").click()]);
  expect(navigations).toBe(1);
});
test.beforeEach(async () => {
  profile = join(work, `profile-${++sequence}`);
  execFileSync("pnpm", ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", profile, "--accounts", "2", "--threads", "300"], { cwd: repo, stdio: "ignore" });
  const env: Record<string, string> = { ...process.env, TERNO_DEMO: "1", TERNO_USER_DATA: profile, TERNO_TEST_APP_DATA: join(work, "appdata"), TERNO_TEST_APP_NAME: "TernoNativeReloadTest", TERNO_TEST_LANGUAGES: "en-US" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TERNO_DEV_URL; delete env.TERNO_SMOKE_SCREENSHOT;
  app = await electron.launch({ executablePath: DEV ? join(work, "Electron.app/Contents/MacOS/Electron") : join(work, "Terno.app/Contents/MacOS/Terno"), ...(DEV ? { args: [join(here, "../dist/main.cjs")] } : {}), env });
  console.info("captured synthetic native app PID", app.process().pid);
  await blockExternal(app);
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
        if (response.id === copy) { event.stopImmediatePropagation(); copy = null; const saved = response.r;
          window.nativeReloadProbe.copyCommitted = response.ok === true && Number.isSafeInteger(saved?.id) && typeof saved?.generation === "string" && saved?.revision === 1;
          if (window.nativeReloadProbe.copyCommitted) window.nativeReloadProbe.copyIdentity = { id: saved.id, generation: saved.generation, revision: saved.revision }; }
        if (response.id === save) {
          event.stopImmediatePropagation(); save = null; window.nativeReloadProbe.reached = true;
          window.nativeReloadProbe.release = () => port.dispatchEvent(new MessageEvent("message", { data: response }));
        }
      }, { capture: true });
    });
  });
  await page.reload(); await page.getByTestId("thread-row").first().waitFor(); await page.bringToFront();
});
test.afterEach(async () => { await closePackaged(app); });
test.afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

for (const dialog of ["settings", "shortcuts"] as const) for (const state of ["missing", "unknown"] as const) test(`healthy ${dialog} exposes native ${state} Review and preserves intent`, async () => {
  await page.getByTestId("compose-button").click(); const body = page.getByTestId("compose-body");
  await body.click(); await body.press("Meta+b"); await page.keyboard.type("healthy exact work");
  await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.test>, bob@');
  await page.getByTestId("attachment-input").setInputFiles({ name: "healthy.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const original = (await store((s) => s.drafts.list()))[0]!; await store((s) => s.drafts.delete(original.id, original.generation));
  await endOfBody(body); await page.keyboard.type(" latest"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  if (state === "unknown") {
    await page.evaluate(() => { window.nativeReloadProbe.dropCopy = true; }); await page.getByTestId("draft-save-copy").click();
    await committedCopy();
    await expect(page.getByTestId("draft-status")).toContainText("may already exist", { timeout: 35_000 });
  }
  await endOfBody(body); await body.press("ArrowLeft"); await page.getByTestId("format-italic").click();
  const html = await body.innerHTML(), caret = await page.evaluate(() => ({ offset: getSelection()?.anchorOffset, text: getSelection()?.anchorNode?.textContent }));
  await page.getByTestId("open-settings").click(); await page.getByTestId("tab-general").click();
  if (dialog === "shortcuts") await page.getByTestId("open-shortcuts").click();
  const modal = page.getByTestId(`${dialog}-dialog`); await expect(modal).toBeVisible();
  let navigations = 0; page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await menu(); await shortcut(); await shortcut(true);
  const notice = modal.getByTestId("native-reload-notice"); await expect(notice).toBeVisible();
  expect(await notice.evaluate((el) => Boolean(el.closest('[aria-hidden="true"], [inert]')))).toBe(false);
  expect(navigations).toBe(0); await expect(page.getByTestId("native-reload-notice")).toHaveCount(1);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme }); await axe();
    await page.screenshot({ path: join(shots, `healthy-${dialog}-${state}-${theme}.png`) });
  }
  await notice.getByTestId("native-reload-review").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("recovery-workspace")).toBeVisible(); await expect(modal).toHaveCount(0);
  await expect(body).toHaveCount(1); await expect(body).toBeFocused(); expect(await body.innerHTML()).toBe(html);
  expect(await page.evaluate(() => ({ offset: getSelection()?.anchorOffset, text: getSelection()?.anchorNode?.textContent }))).toEqual(caret);
  await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("recovery-workspace")).toContainText("Pérez, Ana");
  await expect(page.getByTestId("recovery-workspace")).toContainText("bob@");
  await expect(page.getByTestId("recovery-workspace")).toContainText("healthy.bin");
  const ref = JSON.parse(original.attachments_json)[0]; expect(await store((s) => s.attachments.read(original.account_id, ref.assetId, 0))).toBe("AP+A");
  await page.getByTestId("recovery-details").click(); await expect(modal).toBeVisible(); expect(navigations).toBe(0);
});

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
    await committedCopy();
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
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() }), menu()]); await page.getByTestId("thread-row").first().waitFor(); expect(navigations).toBe(1);
  await page.getByTestId("compose-button").click(); await body.fill("explicitly discard only");
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const target = (await store((s) => s.drafts.list())).find((d) => d.body_text === "explicitly discard only")!; await store((s) => s.drafts.delete(target.id, target.generation));
  await body.click(); await body.press("ArrowRight"); await page.keyboard.type(" latest"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  await menu(); await expect(page.getByTestId("native-reload-anyway")).toHaveAccessibleName("Reload anyway and discard unsaved changes and pending files");
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() }), page.getByTestId("native-reload-anyway").click()]); await page.getByTestId("thread-row").first().waitFor(); expect(navigations).toBe(2);
});

test("native reload holds the exact saved ACK through changed focus and document commit", async () => {
  await page.getByTestId("compose-button").click(); const body = page.getByTestId("compose-body");
  await page.evaluate(() => { window.nativeReloadProbe.gateSave = true; }); await body.fill("latest before native ACK");
  await menu(); await expect(page.getByTestId("draft-status")).toContainText("Draft editing is paused");
  await expect.poll(() => page.evaluate(() => window.nativeReloadProbe.reached)).toBe(true);
  await shortcut(); await shortcut(true);
  await body.focus(); await page.keyboard.type(" must not be admitted"); await expect(body).toHaveText("latest before native ACK");
  const nonce = await page.evaluate(() => window.nativeReloadProbe.nonce);
  let other: number | undefined;
  try {
    other = await app.evaluate(async ({ app: a, BrowserWindow }) => {
      const other = new BrowserWindow({ show: true, webPreferences: { sandbox: true } });
      await other.loadURL("data:text/html,<title>Synthetic focus control</title>"); a.focus({ steal: true }); other.show(); other.focus(); other.webContents.focus(); return other.webContents.id;
    });
    await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.getFocusedWebContents()?.id === id, other)).toBe(true);
    await Promise.all([page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() }), page.evaluate(() => window.nativeReloadProbe.release!())]); await page.getByTestId("thread-row").first().waitFor();
    await expect.poll(() => store(async (s) => (await s.drafts.list())[0]?.body_text)).toBe("latest before native ACK");
  } finally {
    await cleanupOwned([
      () => page.evaluate((nonce) => { if (window.nativeReloadProbe.nonce === nonce) { window.nativeReloadProbe.release?.(); window.nativeReloadProbe.release = undefined; } }, nonce),
      async () => { if (other !== undefined) await app.evaluate(({ webContents, BrowserWindow }, id) => { const contents = webContents.fromId(id); if (contents) BrowserWindow.fromWebContents(contents)?.destroy(); }, other); },
    ]);
  }
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
    const events: NodeJS.EventEmitter = owner.webContents;
    for (const name of ["devtools-reload-page", "did-start-navigation", "did-navigate", "did-stop-loading", "did-fail-load", "did-fail-provisional-load"] as const) events.on(name, () => { if (trace.length < 32) trace.push(`${name}:${owner.webContents.isLoadingMainFrame()}`); });
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

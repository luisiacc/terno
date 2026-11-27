/**
 * Plan 248 on the desktop: Settings → Appearance → Font lists this Mac's installed families (Chromium's
 * queryLocalFonts, which the app's window gets with no prompt), a typed name finds one, it shows at once and is kept.
 * Runs against the packaged app, or the dev build with TERNO_FONTS_SMOKE_DEV=1.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { closePackaged, copyTree, seededProfile } from "./packaged-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const DEV = process.env.TERNO_FONTS_SMOKE_DEV === "1";
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");

let workdir: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  test.skip(!DEV && !existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-fonts-smoke-"));
  const profile = join(workdir, "profile");
  seededProfile(profile);
  const appPath = join(workdir, "Terno.app");
  if (!DEV) copyTree(SOURCE_APP, appPath);
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_USER_DATA: profile, TERNO_TEST_LANGUAGES: "en-US", TERNO_TEST_BACKGROUND: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  app = DEV
    ? await electron.launch({ executablePath: join(here, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [join(here, "../dist/main.cjs")], env })
    : await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await closePackaged(app);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("the font field lists this Mac's families; Helvetica, typed, shows at once and is kept", async () => {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-appearance").click();
  const field = page.getByTestId("font-field");
  await field.click();
  // more than Terno's five: the Mac's own, A–Z after them
  await expect.poll(() => page.locator('[data-testid=font-option][data-font-option^="local:"]').count(), { timeout: 10_000 }).toBeGreaterThan(5);
  await page.keyboard.type("Helvetica");
  await expect(page.locator('[data-font-option="local:Helvetica"]')).toBeVisible();
  // plan 248 (1bb84904f): typing moves the highlight and nothing else; the app changes font once one is chosen
  await expect(page.locator("html")).not.toHaveAttribute("data-font", "local");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-font", "local");
  await expect(field).toHaveValue("Helvetica");
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Helvetica"?,/);
});

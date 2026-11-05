/**
 * Plan 12 on the desktop: Ver → Filter by Unread reaches the renderer and
 * toggles once per click; ⌘L is no longer the filter's (it is the composer's
 * link, plan 93), so a ⌘L press leaves the list as it is. Runs against the dev build
 * (`pnpm build`) with TERNO_UNREAD_SMOKE_DEV=1, or the packaged app.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { copyTree, seededProfile, closePackaged } from "./packaged-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const DEV = process.env.TERNO_UNREAD_SMOKE_DEV === "1";
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");

let workdir: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(!DEV && !existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-unread-smoke-"));
  const profile = join(workdir, "profile");
  seededProfile(profile);
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  if (DEV) {
    app = await electron.launch({ executablePath: join(here, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [join(here, "../dist/main.cjs")], env });
  } else {
    const appPath = join(workdir, "Terno.app");
    copyTree(SOURCE_APP, appPath);
    app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  }
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
  // count what the menu channel delivers, beside the app's own listener
  await page.evaluate(() => {
    const w = window as unknown as { __menuCommands: string[]; ternoDesktop: { onCommand(l: (c: string) => void): void } };
    w.__menuCommands = [];
    w.ternoDesktop.onCommand((c) => w.__menuCommands.push(c));
  });
});

test.afterAll(async () => {
  await closePackaged(app);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/** "true" while the list shows the unread filter: read from the list's key, the same in every design (Lumen has chips, not the header button) */
const pressed = () => page.getByTestId("thread-list").evaluate((el) => String((JSON.parse(el.getAttribute("data-results-for") ?? "[]") as unknown[])[4] === "unread"));
const delivered = () => page.evaluate(() => (window as unknown as { __menuCommands: string[] }).__menuCommands.length);

test("the Ver menu item toggles once per click; ⌘L toggles nothing", async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Meta+l");
  await page.waitForTimeout(500);
  expect(await pressed()).toBe("false");
  expect(await delivered()).toBe(0);

  const click = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("unread-filter")!.click());
  await click();
  await expect.poll(pressed).toBe("true");
  // two clicks close together are two toggles (no key to echo any more)
  await click();
  await click();
  await page.waitForTimeout(500);
  expect(await pressed()).toBe("true");
  expect(await delivered()).toBe(3);
});

/**
 * Plan 12 on the desktop: ⌘L and Ver → Filter by Unread reach the renderer
 * through one dispatcher, and one press toggles once (the menu's echo of a
 * key the page handled is dropped). Runs against the dev build
 * (`pnpm build`) with TERNO_UNREAD_SMOKE_DEV=1, or the packaged app.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
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
  execFileSync("pnpm", ["--filter", "@terno/backend-dev", "exec", "tsx", "src/seed.ts", "--out", profile, "--accounts", "2", "--threads", "300"], { cwd: repo, stdio: "ignore" });
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  if (DEV) {
    app = await electron.launch({ executablePath: join(here, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [join(here, "../dist/main.cjs")], env });
  } else {
    const appPath = join(workdir, "Terno.app");
    execFileSync("ditto", [SOURCE_APP, appPath]);
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
  await app?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/** "true" while the list shows the unread filter: read from the list's key, the same in every design (Lumen has chips, not the header button) */
const pressed = () => page.getByTestId("thread-list").evaluate((el) => String((JSON.parse(el.getAttribute("data-results-for") ?? "[]") as unknown[])[4] === "unread"));
const delivered = () => page.evaluate(() => (window as unknown as { __menuCommands: string[] }).__menuCommands.length);

test("⌘L toggles once per press; the Ver menu item toggles too, and its echo of a key is dropped", async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Meta+l");
  await expect.poll(pressed).toBe("true");
  await page.waitForTimeout(500);
  expect(await pressed()).toBe("true");
  const echoes = await delivered();
  console.log(`menu commands delivered for one ⌘L press: ${echoes}`);

  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("unread-filter")!.click());
  await expect.poll(pressed).toBe("false");
  expect(await delivered()).toBe(echoes + 1);

  // a key and the menu's echo of it within the same moment: one toggle
  await page.keyboard.press("Meta+l");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("unread-filter")!.click());
  await page.waitForTimeout(500);
  expect(await pressed()).toBe("true");
});

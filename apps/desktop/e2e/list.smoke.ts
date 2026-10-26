/**
 * Plan 24 on the desktop: in the List layout, View → Back / Forward and ⌘[
 * reach the renderer through one dispatcher (one press, one step: the menu's
 * echo of a key the page handled is dropped), the mouse's back and forward
 * buttons work (Electron doesn't navigate on them by itself on macOS), and a
 * reload on a conversation comes back to it over app:// (an in-page history
 * entry: no reconnect storm, no blocked navigation). Runs against the dev
 * build (`pnpm build`) with TERNO_LIST_SMOKE_DEV=1, or the packaged app.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const DEV = process.env.TERNO_LIST_SMOKE_DEV === "1";
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");

let workdir: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(!DEV && !existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  workdir = mkdtempSync(join("/tmp", "terno-list-smoke-"));
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
  // Settings → General → Layout: List, like a user would
  await page.keyboard.press("Meta+,");
  await page.getByTestId("layout-list").click();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "list");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
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

const listPage = () => page.getByTestId("list-page");
const clickMenu = (id: string) => app.evaluate(({ Menu }, item) => Menu.getApplicationMenu()!.getMenuItemById(item)!.click(), id);
const open = async (n: number) => {
  await page.locator("[data-testid=thread-row]").nth(n).click();
  await expect(listPage()).toBeVisible();
};

test("View → Back and Forward step once each; ⌘[ with the menu's echo is still one step", async () => {
  await open(1);
  await clickMenu("nav-back");
  await expect(listPage()).toHaveCount(0);
  await clickMenu("nav-forward");
  await expect(listPage()).toBeVisible();
  // the key, and the menu's echo of it within the same moment: one step back (Forward still reopens: we didn't go past the list)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Meta+BracketLeft");
  await clickMenu("nav-back");
  await expect(listPage()).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(page.locator("[data-testid=thread-row]").first()).toBeVisible();
  await clickMenu("nav-forward");
  await expect(listPage()).toBeVisible();
  await clickMenu("nav-back");
  await expect(listPage()).toHaveCount(0);
});

test("the mouse's back and forward buttons", async () => {
  await open(2);
  const cdp = await page.context().newCDPSession(page);
  const click = async (button: "back" | "forward") => {
    for (const type of ["mousePressed", "mouseReleased"] as const) await cdp.send("Input.dispatchMouseEvent", { type, x: 700, y: 400, button, clickCount: 1 });
  };
  await click("back");
  await expect(listPage()).toHaveCount(0);
  await click("forward");
  await expect(listPage()).toBeVisible();
  await click("back");
  await expect(listPage()).toHaveCount(0);
});

// found along the way: the port for a reloaded window went out when the navigation started, to the old document,
// and the new one waited for it forever (any reload, ⌘R or View → Reload, not only List's)
test("a reload (View → Reload) gets the window a working backend port", async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload());
  await page.locator("[data-ready]").waitFor({ timeout: 30_000 });
  await expect(page.locator("[data-testid=thread-row]").first()).toBeVisible();
});

test("a reload on a conversation comes back to it, connected once", async () => {
  await open(3);
  const id = await page.locator("[data-testid=thread-row][data-cursor]").getAttribute("data-thread-id");
  expect(page.url()).toMatch(new RegExp(`^app://.*#/thread/${id}$`));
  await page.reload();
  await page.locator("[data-ready]").waitFor({ timeout: 60_000 });
  await expect(listPage()).toBeVisible();
  await expect(page.locator("[data-testid=thread-row][data-cursor]")).toHaveAttribute("data-thread-id", id!);
  // the backend answers (the port reconnected): the conversation loads
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(listPage()).toHaveCount(0);
});

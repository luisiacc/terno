// The real Electron build on a throwaway demo profile, behind the user's windows (plan 158). Nothing here touches a real
// profile, and the renderer's outside requests are refused, so no mail image or icon leaves the machine.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** A round runs from its own frozen copy (rate.mjs), so neither a later edit nor the checkout's path can reach a rater. */
const RUNTIME = process.env.UI_RATING_RUNTIME;
const { _electron: electron } = RUNTIME ? createRequire(join(RUNTIME, "app/package.json"))("playwright-core") : createRequire(join(repo, "apps/desktop/package.json"))("@playwright/test");
const ELECTRON = RUNTIME ? join(RUNTIME, "Electron.app/Contents/MacOS/Electron") : join(repo, "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const BUILD = RUNTIME ? join(RUNTIME, "app/dist") : join(repo, "apps/desktop/dist");

export async function resize(app, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
}

/** Settings → General → Layout, as a user would. */
export async function setLayout(page, layout) {
  await page.keyboard.press("Meta+,");
  await page.getByTestId(`layout-${layout}`).click();
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
}

/** Settings → Appearance → the style, in its own colors. */
export async function setDesign(page, design) {
  await page.keyboard.press("Meta+,");
  await page.getByRole("tab", { name: /appearance/i }).click();
  await page.getByTestId(`design-card-${design}`).click();
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
  await page.waitForFunction((d) => document.documentElement.dataset.design === d, design);
}

/** A window as a person has it on a laptop: 1440x900 by default, light unless told otherwise. */
export async function launch({ design = "lumen", dark = false, width = 1440, height = 900, layout } = {}) {
  if (!existsSync(join(BUILD, "main.cjs"))) throw new Error(`no build at ${BUILD}: run node apps/desktop/scripts/build.mjs`);
  const work = mkdtempSync("/tmp/ui-rating-");
  const profile = join(work, "profile");
  // the window's first paint reads the design from the profile (vibrancy can't change later), so the style's first launch sets it and the second is what's rated
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_BACKGROUND: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "JEV_API_KEY"]) delete env[k];

  const open = async () => {
    const app = await electron.launch({ executablePath: ELECTRON, args: [join(BUILD, "main.cjs")], env });
    await app.context().route(/^https?:\/\//, (route) => {
      const host = new URL(route.request().url()).hostname;
      return ["127.0.0.1", "localhost", "[::1]"].includes(host) ? route.continue() : route.abort("blockedbyclient");
    });
    const page = await app.firstWindow();
    await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source; }, dark ? "dark" : "light");
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    await (await page.context().newCDPSession(page)).send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await resize(app, width, height);
    await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
    return { app, page };
  };
  const quit = async (app) => {
    const pid = app.process().pid;
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))]);
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  };

  let opened = await open();
  if (design !== "lumen") {
    await setDesign(opened.page, design);
    await quit(opened.app);
    opened = await open();
  }
  const { app, page } = opened;
  if (layout) await setLayout(page, layout);
  const close = async () => { await quit(app); rmSync(work, { recursive: true, force: true }); };
  return { app, page, profile, close };
}

// the macOS style's window is translucent: flattened on its own background, so a viewer can't show those pixels as black
export const shot = (page, name, dir) => page.screenshot({ path: join(dir, `${name}.png`), style: "html { background: var(--background) !important; }" });

// The real Electron build on a throwaway demo profile, behind the user's windows (plan 158). Nothing here touches a real
// profile, and the renderer's outside requests are refused, so no mail image or icon leaves the machine.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL, startModelStub } from "./model-stub.mjs";

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

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
/**
 * The AI set's instant (plan 161): half an hour after the demo mailbox's newest mail (seedDemo, 22 October 15:30 UTC),
 * so its mail is as fresh to the AI jobs in every round. The backend's clock starts here (TERNO_TEST_NOW, the demo
 * mailbox only) and the window's zone is UTC, so a day is the same day on any Mac.
 */
export const AI_NOW = Date.UTC(2026, 9, 22, 16, 0);

const switchOn = async (page, testId, on = true) => {
  const control = page.getByTestId(testId);
  await control.waitFor();
  if ((await control.getAttribute("aria-checked")) !== String(on)) await control.click();
  await page.waitForFunction(([id, want]) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-checked") === want, [testId, String(on)]);
};
const openTab = async (page, name) => {
  await page.getByTestId(`tab-${name}`).click();
};

/**
 * Plan 161: AI on, as a person sets it up in Settings (each control calls the backend's own settings.update): Ollama at
 * the stub, its model, a passing Test, the four background switches, and sender icons and automatic updates off so
 * nothing but the stub is reached. Follow-ups' offer to read old sent mail is declined: what the screens show comes from
 * mail sent in the window.
 */
export async function setUpAi(page, url) {
  await page.keyboard.press("Meta+,");
  await openTab(page, "ai");
  await page.getByTestId("ai-provider").click();
  await page.getByTestId("ai-choice-ollama").click();
  await page.getByTestId("ai-endpoint").fill(`${url}/v1`);
  const option = page.getByTestId("ai-model-option").filter({ hasText: MODEL });
  await option.waitFor({ timeout: 20_000 });
  await option.click();
  await page.waitForFunction((m) => document.querySelector('[data-testid="ai-model"]')?.value === m, MODEL);
  await page.getByTestId("ai-test").click();
  await page.getByTestId("ai-test-result").filter({ hasText: /Connected/ }).waitFor({ timeout: 30_000 });
  await switchOn(page, "ai-summaries-switch");
  await switchOn(page, "ai-followups-switch");
  const notNow = page.getByTestId("ai-followups-notnow");
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await switchOn(page, "replies-switch");
  await switchOn(page, "ai-digest-switch");
  await openTab(page, "appearance");
  await switchOn(page, "site-icons-switch", false);
  await openTab(page, "general");
  const updates = page.getByTestId("updates-auto-switch");
  if ((await updates.count()) && (await updates.isEnabled())) await switchOn(page, "updates-auto-switch", false);
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
}

/** After the relaunch: what setUpAi saved is what the app now reads, or the round would rate AI off. */
export async function checkAi(page, url) {
  await page.keyboard.press("Meta+,");
  await openTab(page, "ai");
  const problems = [];
  if (!/Ollama/.test(await page.getByTestId("ai-provider").innerText())) problems.push("the provider isn't Ollama");
  if ((await page.getByTestId("ai-endpoint").inputValue()) !== `${url}/v1`) problems.push("the endpoint isn't the stub's");
  if ((await page.getByTestId("ai-model").inputValue()) !== MODEL) problems.push(`the model isn't ${MODEL}`);
  for (const id of ["ai-summaries-switch", "ai-followups-switch", "replies-switch", "ai-digest-switch"]) if ((await page.getByTestId(id).getAttribute("aria-checked")) !== "true") problems.push(`${id} is off`);
  await openTab(page, "appearance");
  if ((await page.getByTestId("site-icons-switch").getAttribute("aria-checked")) !== "false") problems.push("sender icons are on");
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
  if (problems.length) throw new Error(`AI settings didn't survive the relaunch: ${problems.join("; ")}`);
}

/**
 * Where the rated launch's requests went (revision 10): every backend decision from the policy's log, and every
 * request the window's fence refused. Anything but loopback, or an AI request anywhere but the stub, is a problem.
 */
export function netProblems({ log, blocked, stubPort }) {
  const problems = blocked.map((u) => `the window asked for ${u}`);
  // no log is no proof: the backend always reaches the stub at least once (the digest), so an empty run is a broken seam
  if (!existsSync(log)) return { problems: [...problems, "the backend's network log is missing"], decisions: 0, ai: 0 };
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (lines.some((d) => d.overflow)) problems.push("the network log hit its bound: what came after it is unseen");
  for (const d of lines) {
    if (d.overflow) continue;
    const url = new URL(d.url);
    if (!d.allowed) continue;
    if (!LOOPBACK.includes(url.hostname)) problems.push(`the backend reached ${url.host} (${d.purpose})`);
    else if (d.purpose === "ai" && Number(url.port) !== stubPort) problems.push(`an AI request went to ${url.host}, not the stub`);
  }
  return { problems, decisions: lines.length, ai: lines.filter((d) => d.purpose === "ai").length };
}

/**
 * A window as a person has it on a laptop: 1440x900 by default, light unless told otherwise. `ai`: with the model stub
 * set up (plan 161), the clock at AI_NOW, and every request the backend makes logged and checked.
 */
export async function launch({ design = "lumen", dark = false, width = 1440, height = 900, layout, ai = false } = {}) {
  if (!existsSync(join(BUILD, "main.cjs"))) throw new Error(`no build at ${BUILD}: run node apps/desktop/scripts/build.mjs`);
  const work = mkdtempSync("/tmp/ui-rating-");
  const profile = join(work, "profile");
  // the window's first paint reads the design from the profile (vibrancy can't change later), so the style's first launch sets it and the second is what's rated
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_TEST_BACKGROUND: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "JEV_API_KEY"]) delete env[k];
  for (const k of ["TERNO_TEST_NOW", "TERNO_TEST_NET_LOG"]) delete env[k];
  const stub = ai ? await startModelStub({ paceMs: 20 }) : null;
  const log = join(work, "net.log");
  const blocked = [];
  if (ai) Object.assign(env, { TERNO_TEST_NOW: String(AI_NOW), TERNO_TEST_NET_LOG: log, TZ: "UTC" });

  const open = async () => {
    const app = await electron.launch({ executablePath: ELECTRON, args: [join(BUILD, "main.cjs")], env });
    await app.context().route(/^https?:\/\//, (route) => {
      const host = new URL(route.request().url()).hostname;
      if (LOOPBACK.includes(host)) return route.continue();
      blocked.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    const page = await app.firstWindow();
    // the window reads the same instant as the backend (e2e does the same): a line like "hasn't replied in 1 day" can't drift between rounds
    if (ai) await page.clock.setFixedTime(AI_NOW);
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

  let opened;
  try {
    opened = await open();
    if (design !== "lumen" || ai) {
      if (design !== "lumen") await setDesign(opened.page, design);
      if (ai) await setUpAi(opened.page, stub.url);
      await quit(opened.app);
      // what the first launch did is setup: the rated launch is judged on its own requests (a new log, written as they come)
      if (ai) rmSync(log, { force: true });
      blocked.length = 0;
      opened = await open();
    }
    if (ai) await checkAi(opened.page, stub.url);
  } catch (error) {
    if (opened) await quit(opened.app);
    await stub?.close();
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
  const { app, page } = opened;
  if (layout) await setLayout(page, layout);
  const close = async () => { await quit(app); await stub?.close(); rmSync(work, { recursive: true, force: true }); };
  const network = () => netProblems({ log, blocked, stubPort: stub?.port ?? 0 });
  return { app, page, profile, close, stub, network };
}

// the macOS style's window is translucent: flattened on its own background, so a viewer can't show those pixels as black
export const shot = (page, name, dir) => page.screenshot({ path: join(dir, `${name}.png`), style: "html { background: var(--background) !important; }" });

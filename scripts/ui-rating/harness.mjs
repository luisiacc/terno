// The real Electron build on a throwaway demo profile, behind the user's windows (plan 158). Nothing here touches a real
// profile, and the renderer's outside requests are refused, so no mail image or icon leaves the machine.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { envFile, filesHoldingKeys, guardOutput, readKeys } from "./keys.mjs";
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

/** Sender icons and automatic updates off: nothing leaves the machine but what the AI needs. */
async function quietNetwork(page) {
  await openTab(page, "appearance");
  await switchOn(page, "site-icons-switch", false);
  await openTab(page, "general");
  const updates = page.getByTestId("updates-auto-switch");
  if ((await updates.count()) && (await updates.isEnabled())) await switchOn(page, "updates-auto-switch", false);
}

/** The four background switches the AI screens need (Summarize new mail, follow-ups, Prepare a reply, the digest). */
async function backgroundSwitches(page) {
  await openTab(page, "ai");
  await switchOn(page, "ai-summaries-switch");
  await switchOn(page, "ai-followups-switch");
  const notNow = page.getByTestId("ai-followups-notnow");
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await switchOn(page, "replies-switch");
  await switchOn(page, "ai-digest-switch");
}

/**
 * Plan 161: AI on, as a person sets it up in Settings (each control calls the backend's own settings.update), and
 * sender icons and automatic updates off. Real models: icons and updates go off first, `quiet()` runs (the harness
 * starts the net log afresh: what came before had no key to carry), then Settings → Dev mode → Pro AI, Pro's routing on
 * the keys this launch was given (plan 146). The stub: Ollama at its URL, its model and a passing Test. Either way the
 * four background switches; follow-ups' offer to read old sent mail is declined, since the screens come from mail sent
 * in the window.
 */
export async function setUpAi(page, mode, url, quiet = () => {}) {
  await page.keyboard.press("Meta+,");
  if (mode === "real") {
    await quietNetwork(page);
    quiet();
    await openTab(page, "dev");
    await switchOn(page, "dev-ai-switch");
  } else {
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
  }
  await backgroundSwitches(page);
  if (mode !== "real") await quietNetwork(page);
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
}

/** After the relaunch: what setUpAi saved is what the app now reads, or the round would rate AI off. */
export async function checkAi(page, mode, url) {
  await page.keyboard.press("Meta+,");
  const problems = [];
  if (mode === "real") {
    await openTab(page, "dev");
    if ((await page.getByTestId("dev-ai-switch").getAttribute("aria-checked")) !== "true") problems.push("Dev mode's Pro AI is off");
    await openTab(page, "ai");
  } else {
    await openTab(page, "ai");
    if (!/Ollama/.test(await page.getByTestId("ai-provider").innerText())) problems.push("the provider isn't Ollama");
    if ((await page.getByTestId("ai-endpoint").inputValue()) !== `${url}/v1`) problems.push("the endpoint isn't the stub's");
    if ((await page.getByTestId("ai-model").inputValue()) !== MODEL) problems.push(`the model isn't ${MODEL}`);
  }
  for (const id of ["ai-summaries-switch", "ai-followups-switch", "replies-switch", "ai-digest-switch"]) if ((await page.getByTestId(id).getAttribute("aria-checked")) !== "true") problems.push(`${id} is off`);
  await openTab(page, "appearance");
  if ((await page.getByTestId("site-icons-switch").getAttribute("aria-checked")) !== "false") problems.push("sender icons are on");
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
  if (problems.length) throw new Error(`AI settings didn't survive the relaunch: ${problems.join("; ")}`);
}

/**
 * Where the rated launch's requests went (revision 10): every backend decision from the policy's log, and every
 * request the window's fence refused. On the stub, anything but loopback, or an AI request anywhere but the stub, is a
 * problem. On real models (`aiHosts`), an AI request may go only to the hosts of the providers this launch has keys
 * for, over https; anything else off loopback is still a problem (icons and updates are off).
 */
export function netProblems({ log, blocked, stubPort = 0, aiHosts = null }) {
  const problems = blocked.map((u) => `the window asked for ${u}`);
  // no log is no proof: the backend always reaches the model at least once (the digest), so an empty run is a broken seam
  if (!existsSync(log)) return { problems: [...problems, "the backend's network log is missing"], decisions: 0, ai: 0, hosts: [] };
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (lines.some((d) => d.overflow)) problems.push("the network log hit its bound: what came after it is unseen");
  const hosts = new Set();
  for (const d of lines) {
    if (d.overflow || !d.allowed) continue;
    const url = new URL(d.url);
    const loopback = LOOPBACK.includes(url.hostname);
    if (aiHosts) {
      if (d.purpose === "ai" && url.protocol === "https:" && aiHosts.includes(url.hostname)) hosts.add(url.hostname);
      else if (d.purpose === "ai") problems.push(`an AI request went to ${url.host}, not a provider in use`);
      else if (!loopback) problems.push(`the backend reached ${url.host} (${d.purpose})`);
    } else if (!loopback) problems.push(`the backend reached ${url.host} (${d.purpose})`);
    else if (d.purpose === "ai" && Number(url.port) !== stubPort) problems.push(`an AI request went to ${url.host}, not the stub`);
  }
  return { problems, decisions: lines.length, ai: lines.filter((d) => d.purpose === "ai").length, hosts: [...hosts].sort() };
}

/** `ai`: true or "real" for Pro's real models (the rating's default), "stub" for the local stand-in, false for none. */
export function aiMode(ai) {
  if (ai === true || ai === "real") return "real";
  if (ai === "stub") return "stub";
  if (!ai) return null;
  throw new Error(`ai takes true, "real", "stub" or false, not ${ai}`);
}

/**
 * One capture pass's line in round.json (plan 161): the style, light or dark, who ran, the hosts reached, the model each
 * surface says wrote it, and what the app counted it spent. Never a key: nothing here has one.
 */
export function runRecord({ design, mode, models, net, seen, usage }) {
  return { design, mode, ai: models.ai, providers: models.providers, hosts: models.hosts, reached: net.hosts, requests: net.ai, seen, usage };
}

/**
 * What the app spent, as it counted it (its usage book, plan 131): requests, the providers' reported tokens and US
 * dollars, by task, since the profile began. Read-only, while the app runs.
 */
export function readUsage(profile) {
  const db = new DatabaseSync(join(profile, "terno.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'ai:usage'").get();
    const book = row ? JSON.parse(row.value_json) : {};
    const byTask = {};
    for (const day of Object.values(book)) for (const [task, t] of Object.entries(day)) {
      const sum = (byTask[task] ??= { requests: 0, inputTokens: 0, outputTokens: 0, usd: 0, estimated: 0 });
      for (const k of Object.keys(sum)) sum[k] += t[k] ?? 0;
    }
    const total = Object.values(byTask).reduce((a, t) => ({ requests: a.requests + t.requests, inputTokens: a.inputTokens + t.inputTokens, outputTokens: a.outputTokens + t.outputTokens, usd: a.usd + t.usd, estimated: a.estimated + t.estimated }), { requests: 0, inputTokens: 0, outputTokens: 0, usd: 0, estimated: 0 });
    return { byTask, total };
  } finally { db.close(); }
}

/** Every name a key or the switch could arrive by: none reaches Electron from the caller's environment. */
const KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "JEV_API_KEY", "GROQ_API_KEY", "TERNO_TEST_DEV_AI", "TERNO_RATING_ENV"];

/**
 * The Electron process's environment: the caller's, without any key, plus the demo profile, and for `ai` the clock and
 * the net log. Real models add the keys read from the .env file (keys.mjs) and Dev mode's switch: those exist only in
 * the env handed to Electron, never in this process's.
 */
export function electronEnv({ base = process.env, profile, log, mode, keys }) {
  const env = { ...base, TERNO_DEMO: "1", TERNO_TEST_BACKGROUND: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERNO_DEV_URL;
  for (const k of [...KEY_VARS, "TERNO_TEST_NOW", "TERNO_TEST_NET_LOG"]) delete env[k];
  if (mode) Object.assign(env, { TERNO_TEST_NOW: String(AI_NOW), TERNO_TEST_NET_LOG: log, TZ: "UTC" });
  if (mode === "real") Object.assign(env, keys.env, { TERNO_TEST_DEV_AI: "1" });
  return env;
}

/**
 * A window as a person has it on a laptop: 1440x900 by default, light unless told otherwise. `ai` (plan 161): AI on, the
 * clock at AI_NOW, and every request the backend makes logged and checked. `true` runs Pro's real models on the keys in
 * the owner's .env (keys.mjs); `"stub"` the local stand-in.
 */
export async function launch({ design = "lumen", dark = false, width = 1440, height = 900, layout, ai = false } = {}) {
  const mode = aiMode(ai);
  // read before anything starts: a missing key fails here, and from now on this process's output can't carry one
  const keys = mode === "real" ? readKeys(envFile()) : null;
  if (keys) guardOutput(keys.secrets);
  if (!existsSync(join(BUILD, "main.cjs"))) throw new Error(`no build at ${BUILD}: run node apps/desktop/scripts/build.mjs`);
  const work = mkdtempSync("/tmp/ui-rating-");
  const profile = join(work, "profile");
  const log = join(work, "net.log");
  // the window's first paint reads the design from the profile (vibrancy can't change later), so the style's first launch sets it and the second is what's rated
  const env = electronEnv({ profile, log, mode, keys });
  const stub = mode === "stub" ? await startModelStub({ paceMs: 20 }) : null;
  const blocked = [];

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
    if (mode) await page.clock.setFixedTime(AI_NOW);
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

  /**
   * The throwaway profile goes, and with it anything the app wrote. First, the proof that none of it held a key (its
   * logs, its database, the net log): a key there fails the run, though the files are deleted either way.
   */
  const discard = () => {
    const leaked = keys && existsSync(work) ? filesHoldingKeys(work, keys.secrets).length : 0;
    rmSync(work, { recursive: true, force: true });
    if (leaked) throw new Error(`${leaked} file(s) the app wrote in its throwaway profile held a key (deleted)`);
  };

  let opened;
  try {
    opened = await open();
    if (design !== "lumen" || mode) {
      if (design !== "lumen") await setDesign(opened.page, design);
      // the window's first paint asks for sender icons before they're turned off; on real models the log starts once
      // they are, before Pro AI (and its keys) is on
      if (mode) await setUpAi(opened.page, mode, stub?.url, () => rmSync(log, { force: true }));
      await quit(opened.app);
      // on the stub, what the first launch did is setup and the rated launch is judged on its own requests (a new log);
      // real models' setup requests after Pro AI went on carried the keys, so they stay in the log and are judged too
      if (mode === "stub") rmSync(log, { force: true });
      blocked.length = 0;
      opened = await open();
    }
    if (mode) await checkAi(opened.page, mode, stub?.url);
  } catch (error) {
    if (opened) await quit(opened.app);
    await stub?.close();
    discard();
    throw error;
  }
  const { app, page } = opened;
  if (layout) await setLayout(page, layout);
  const close = async () => { await quit(app); await stub?.close(); discard(); };
  const network = () => netProblems({ log, blocked, stubPort: stub?.port ?? 0, aiHosts: keys?.hosts ?? null });
  /** Real models: who ran, never with what key (round.json records it). `ai`, not `mode`: a run's mode is light or dark. */
  const models = keys ? { ai: mode, providers: keys.providers, hosts: keys.hosts } : mode ? { ai: mode } : null;
  const usage = () => readUsage(profile);
  return { app, page, profile, close, stub, network, models, usage };
}

// the macOS style's window is translucent: flattened on its own background, so a viewer can't show those pixels as black
export const shot = (page, name, dir) => page.screenshot({ path: join(dir, `${name}.png`), style: "html { background: var(--background) !important; }" });

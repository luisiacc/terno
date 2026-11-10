/**
 * `pnpm --filter @terno/site shots:ai` (plan 97): the site's AI pictures, on real models. The owner's rule: every AI
 * picture comes from Pro's real routing, never the stub or canned text, and nothing in them is edited by hand.
 *
 * The real backend on a temp profile seeded with the showcase mailbox and its AI conversations (`showcaseDataset({ ai:
 * true })`), Dev mode's Pro AI on the keys in the owner's .env: read through scripts/ui-rating/keys.mjs, held in this
 * process's memory and handed to the backend in memory (plan 146's `devAi`), never printed, written or committed (this
 * process's output is redacted besides, and the profile is checked for them before it's deleted). The page reaches
 * nothing but the two local servers; the backend reaches only the providers. AI is turned on in Settings as a person
 * does, and every state comes from the app's own jobs, clicked through. Each state is shot light, then dark, on the same
 * page, so both show the same words.
 *
 * The clock starts at SHOWCASE_NOW and runs (a job's waits and retries need it to); the window's clock agrees. Writes
 * WebP (1× and 2×) into public/shots/ and their sizes into src/shots.json; prints what the app's usage book counted.
 * `--only=<name,…>` keeps the pictures of a few (every state still runs: they build on each other). `--debug=<dir>`
 * also writes each state's whole window there, to frame the crops.
 *
 * Where the words decide whether a picture is good, each state checks them (its "bar") and asks again as a person would,
 * a few times at most; a state that can't be asked again in place and falls short keeps the previous run's picture
 * (.shots-raw-ai/ is kept between runs; `--fresh` starts it empty).
 */
process.env.TZ = "America/Los_Angeles";

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Locator, type Page } from "@playwright/test";
import { startDevServer } from "@terno/backend-dev/src/server";
import { devAiKeys } from "@terno/core";
import { filesHoldingKeys, guardOutput, readKeys, redact } from "../../../scripts/ui-rating/keys.mjs";
import { ctx, dispose, encode, fencedPage, openApp, out, pictureSettings, seedProfile, serveWeb, site, VIEWPORT } from "./lib";
import { SHOWCASE_NOW } from "./showcase";

const raw = join(site, ".shots-raw-ai");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const debug = process.argv.find((a) => a.startsWith("--debug="))?.slice(8);
const fresh = process.argv.includes("--fresh");

/** A model's answer can take a while; a background job (the digest, the sent-mail scan) longer. */
const MODEL_MS = 180_000;
const JOB_MS = 300_000;

/** What the pictures ask, in the user's words. */
export const AI_INPUTS = {
  draft: "say yes, I’ll bring the sourdough, and ask if my sister Alex can come too",
  ask: "What did Isabella say about the payment?",
  action: "Archive shipping notices older than a month",
  rule: "Archive ride receipts from Hopper",
};

type Mode = "light" | "dark";
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The union of these elements' boxes, `pad` around, held inside the window. `below` extends it down. */
async function around(targets: Locator[], o: { pad?: number; below?: number; x?: [number, number] } = {}): Promise<Box> {
  const pad = o.pad ?? 24;
  const boxes = (await Promise.all(targets.map((t) => t.boundingBox()))).filter((b): b is Box => b !== null);
  if (!boxes.length) throw new Error("nothing to frame");
  const left = Math.max(0, (o.x?.[0] ?? Math.min(...boxes.map((b) => b.x))) - pad);
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(VIEWPORT.width, (o.x?.[1] ?? Math.max(...boxes.map((b) => b.x + b.width))) + pad);
  const bottom = Math.min(VIEWPORT.height, Math.max(...boxes.map((b) => b.y + b.height)) + (o.below ?? 0) + pad);
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

async function main() {
  // read before anything starts: a missing key fails here, and from now on this process's output can't carry one
  const keys = readKeys();
  guardOutput(keys.secrets);
  // kept between runs unless --fresh: a state whose words fall below the bar keeps an earlier run's picture (`both`)
  if (fresh) rmSync(raw, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  mkdirSync(out, { recursive: true });
  if (debug) mkdirSync(debug, { recursive: true });

  const cleanup: (() => unknown)[] = [];
  const blocked = new Set<string>();
  const profile = mkdtempSync(join(tmpdir(), "terno-shots-ai-"));
  // the proof, before the profile goes, that nothing the app wrote holds a key (its database, its logs)
  cleanup.push(() => {
    const leaked = filesHoldingKeys(profile, keys.secrets).length;
    rmSync(profile, { recursive: true, force: true });
    if (leaked) throw new Error(`${leaked} file(s) the app wrote in its throwaway profile held a key (deleted)`);
  });
  try {
    await seedProfile(profile, { ai: true });
    const webPort = await serveWeb(cleanup);
    const started = Date.now();
    const now = () => SHOWCASE_NOW + (Date.now() - started);
    const server = await startDevServer({ port: 0, dataDir: profile, token: "shots", autoSync: false, now, devAi: devAiKeys(keys.env) });
    cleanup.push(() => server.close());
    // the system's appearance, which the page's emulated color scheme flips: a setting changed behind the page isn't pushed to it
    await server.backend.server.invoke("settings.update", { ...pictureSettings("light"), theme: "system" } as never, ctx);
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const page = await fencedPage(browser, { webPort, backendUrl: server.url, mode: "light", blocked });
    await page.clock.install({ time: now() });
    await openApp(page, webPort, server.url, "shots");
    await page.addStyleTag({ content: "*{caret-color:transparent!important}" });
    await shoot(page).catch(async (error: unknown) => {
      // what the window showed when a state wasn't reached, for whoever reads the failure
      if (debug) await page.screenshot({ path: join(debug, "FAILED.png") }).catch(() => {});
      throw error;
    });
    const spent = usage(profile);
    const total = Object.values(spent).reduce((a, t) => ({ requests: a.requests + t.requests, usd: a.usd + t.usd }), { requests: 0, usd: 0 });
    console.log(`AI spend (the app's usage book): ${total.requests} requests, US$${total.usd.toFixed(4)}`);
    for (const [task, t] of Object.entries(spent)) console.log(`  ${task}: ${t.requests} requests, US$${t.usd.toFixed(4)}`);
  } finally {
    await dispose(cleanup);
  }
  if (blocked.size) console.log(`(aborted requests to: ${[...blocked].join(", ")})`);
  encode(raw);
}

/** What the app counted (its usage book, plan 131): requests and US dollars by task. Read-only. */
function usage(profile: string) {
  const db = new DatabaseSync(join(profile, "terno.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'ai:usage'").get() as { value_json: string } | undefined;
    const byTask: Record<string, { requests: number; usd: number }> = {};
    for (const day of Object.values(row ? (JSON.parse(row.value_json) as Record<string, Record<string, { requests?: number; usd?: number }>>) : {}))
      for (const [task, t] of Object.entries(day)) {
        const sum = (byTask[task] ??= { requests: 0, usd: 0 });
        sum.requests += t.requests ?? 0;
        sum.usd += t.usd ?? 0;
      }
    return byTask;
  } finally {
    db.close();
  }
}

async function shoot(page: Page) {
  const rows = page.getByTestId("thread-row");
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const visible = (testId: string, timeout = MODEL_MS) => page.getByTestId(testId).first().waitFor({ timeout });
  const open = async (subject: string) => {
    await rows.filter({ has: page.getByTestId("row-subject").filter({ hasText: subject }) }).first().click();
    await page.getByTestId("reader-subject").filter({ hasText: subject }).waitFor();
  };
  const go = async (view: string) => {
    await page.getByTestId(`nav-${view}`).click();
    await page.waitForTimeout(300);
  };
  const setMode = async (mode: Mode) => {
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, mode === "dark");
  };
  /** nothing moving, no pointer over anything: what's on screen is the state */
  const still = async () => {
    const size = page.viewportSize() ?? VIEWPORT;
    await page.mouse.move(size.width - 1, size.height - 1);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || !(Number(a.effect?.getComputedTiming().endTime) <= 1000)));
    await page.waitForTimeout(250);
  };
  /** the state, light then dark on the same page (the same words in both), framed by `frame` (the window when none) */
  const both = async (name: string, frame?: () => Promise<Box>, good = true) => {
    // a model's words below the bar (see each state's check): an earlier run's picture of it stays, if there is one
    const keep = !good && existsSync(join(raw, `${name}-light.png`)) && existsSync(join(raw, `${name}-dark.png`));
    if (!good) console.log(`  ${name}: below the bar${keep ? ", keeping the earlier picture" : ", the only picture so far"}`);
    for (const mode of ["light", "dark"] as const) {
      await setMode(mode);
      await still();
      if (debug) await page.screenshot({ path: join(debug, `${name}-${mode}.png`) });
      if ((only && !only.includes(name)) || keep) continue;
      const clip = frame ? await frame() : undefined;
      await page.screenshot({ path: join(raw, `${name}-${mode}.png`), ...(clip && { clip }) });
    }
    await setMode("light");
    console.log(`✓ ${name}`);
  };
  const closeSnacks = async () => {
    for (const close of await page.getByTestId("snack-close").all()) if (await close.isVisible()) await close.click({ timeout: 2000 }).catch(() => {});
    await page.getByTestId("snack").first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  };
  const say = async (what: string, locator: Locator) => console.log(`  ${what}: ${redact((await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim())}`);

  // --- AI on, as a person turns it on: Settings → Dev mode → Pro AI, then Settings → AI ---
  const switchOn = async (testId: string) => {
    const control = page.getByTestId(testId);
    await control.waitFor();
    if ((await control.getAttribute("aria-checked")) !== "true") await control.click();
    await page.waitForFunction((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-checked") === "true", testId);
  };
  await blur();
  await page.keyboard.press("Meta+,");
  await page.getByTestId("tab-dev").click();
  await switchOn("dev-ai-switch");
  await page.getByTestId("tab-ai").click();
  await switchOn("ai-summaries-switch");
  await switchOn("ai-ask-switch");
  await switchOn("ai-followups-switch");
  // the offer to read the last 30 days of sent mail: taken, so the promise and the unanswered question are found
  const offer = page.getByTestId("ai-followups-offer");
  if (await offer.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
    await say("follow-ups offer", offer);
    await page.getByTestId("ai-followups-check").click();
  }
  await switchOn("replies-switch");
  await switchOn("ai-digest-switch");
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-dialog").waitFor({ state: "detached" });

  // --- a summary with its To do, on a scope decision that waits for Sam ---
  await go("inbox");
  await open("Phase two: scope and timeline");
  await page.getByTestId("action-summarize").click();
  await page.locator("[data-testid=summary-block][data-state=ready]").waitFor({ timeout: MODEL_MS });
  await visible("summary-item");
  await say("summary", page.getByTestId("summary-block"));
  // the card under its conversation's title, and the first lines of the message it summarizes
  // the bar: two lines or so, and a To do
  const summaryGood = (await page.getByTestId("summary-text").first().innerText()).length <= 200 && (await page.getByTestId("summary-item-reply").count()) > 0;
  await both(
    "ai-summary",
    async () => {
      const box = await around([page.getByTestId("reader-subject"), page.getByTestId("summary-block")], { pad: 28, below: 200 });
      // closer above the title: the toolbar's buttons end just over it
      return { ...box, y: box.y + 12, height: box.height - 12 };
    },
    summaryGood,
  );

  // --- Reply ready: Isabella moves the walkthrough and asks for the address; the drafted reply under her message ---
  await open("Thursday’s walkthrough");
  await page.locator("[data-testid=reply-ready][data-phase=ready]").waitFor({ timeout: MODEL_MS });
  await visible("reply-ready-use");
  await say("reply ready", page.getByTestId("reply-ready"));
  // the bar: one gap, and it reads as a blank to fill (a few words), not a question to the user
  const gaps = await page.getByTestId("reply-ready-gap").allInnerTexts();
  const replyGood = gaps.length === 1 && gaps[0]!.length <= 26 && !gaps[0]!.includes("?");
  // the whole draft, sign-off included: there's room for it under her message
  if (await page.getByTestId("reply-ready-all").isVisible().catch(() => false)) await page.getByTestId("reply-ready-all").click();
  await both("ai-reply", undefined, replyGood);

  // --- ⌘J: the reply opened for AI with a rough instruction, then the draft written in its place ---
  await open("Dinner Saturday?");
  await blur();
  await page.keyboard.press("Meta+j");
  await page.locator("[data-testid=compose-body]:focus").waitFor();
  await page.keyboard.type(AI_INPUTS.draft);
  await page.locator("[data-testid=compose-ai][data-ready]").waitFor();
  await both("ai-generate");
  await page.keyboard.press("Meta+j");
  await visible("ai-strip");
  await page.waitForFunction(() => (document.querySelector("[data-testid=compose-body]")?.textContent ?? "").trim().length > 40, null, { timeout: MODEL_MS });
  await page.locator("[data-testid=ai-writing], [data-testid=ai-rewriting]").first().waitFor({ state: "detached", timeout: MODEL_MS }).catch(() => {});
  await say("draft", page.getByTestId("compose-body"));
  await blur();
  await both("ai-generated");
  await page.getByTestId("compose-discard").click();
  await page.getByTestId("composer").waitFor({ state: "detached" });
  await page.getByTestId("snack").first().waitFor({ timeout: 5000 }).catch(() => {});
  await closeSnacks();

  // --- Ask your mail: the answer with its numbered sources and the follow-up field ---
  await blur();
  await page.keyboard.press("Meta+Shift+k");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  // the bar: an answer, every sentence cited, from both of her messages, and short; asked anew (New question) up to three times
  let askGood = false;
  for (let n = 0; n < 3 && !askGood; n++) {
    if (n) await page.getByTestId("ask-new").click();
    await page.keyboard.type(AI_INPUTS.ask);
    await page.keyboard.press("Enter");
    await page.locator("[data-testid=ask-turn]:not([data-status=running])").last().waitFor({ timeout: MODEL_MS });
    const status = await page.locator("[data-testid=ask-turn]").last().getAttribute("data-status");
    if (!["answered", "partial"].includes(status ?? "") || !(await page.getByTestId("ask-source").count())) throw new Error(`Ask: ${status}, no sources`);
    await say(`ask (${n + 1})`, page.getByTestId("ask-answer").first());
    const answer = (await page.getByTestId("ask-answer").first().innerText()).length;
    askGood = status === "answered" && !(await page.getByTestId("ask-unlinked-mark").count()) && (await page.getByTestId("ask-source").count()) >= 2 && answer <= 360;
  }
  await blur();
  // the panel over the dimmed app, a margin of it around (its rounded corners show what's behind them)
  await both("ai-ask", () => around([dialog], { pad: 20 }), askGood);

  // --- an action in plain English: its preview, before anything is done ---
  await page.getByTestId("ask-new").click();
  await page.keyboard.type(AI_INPUTS.action);
  await page.keyboard.press("Enter");
  await page.locator("[data-testid=action-preview], [data-testid=ask-command-notice]").first().waitFor({ timeout: MODEL_MS });
  if (!(await page.getByTestId("action-preview").isVisible())) throw new Error(`the action found nothing: ${await page.getByTestId("ask-command-notice").innerText()}`);
  await page.waitForFunction(() => !document.querySelector("[data-testid=action-finding], [data-testid=action-checking]") && (document.querySelector("[data-testid=action-apply]") as HTMLButtonElement | null)?.disabled === false, null, { timeout: MODEL_MS });
  await say("action", page.getByTestId("action-preview"));
  await blur();
  // the preview is a page of its own: the matches in the list and how Terno read it beside them, down to its buttons
  await both("ai-action", async () => {
    const list = (await page.getByTestId("thread-list").boundingBox())!;
    const ends = await Promise.all([rows.last(), page.getByTestId("action-apply")].map(async (l) => ((b) => b.y + b.height)((await l.boundingBox())!)));
    return { x: Math.round(list.x), y: 0, width: Math.round(VIEWPORT.width - list.x), height: Math.round(Math.min(VIEWPORT.height, Math.max(...ends) + 32)) };
  });
  await page.getByTestId("action-cancel").click();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" }).catch(() => {});

  // --- a rule made with AI from a sentence, with its match count, before saving ---
  const closeRules = async () => {
    await page.keyboard.press("Escape");
    const discard = page.getByTestId("filter-unsaved-discard");
    if (await discard.waitFor({ timeout: 2000 }).then(() => true, () => false)) await discard.click();
    await page.getByTestId("filters-dialog").waitFor({ state: "detached" });
  };
  await go("inbox");
  // the bar: the rule matches mail (a model that guessed a word the subjects don't have matches none). Asked again
  // afresh, as a person would: Rules closed without saving and opened again, up to three times
  let ruleGood = false;
  for (let n = 0; n < 3 && !ruleGood; n++) {
    if (n) await closeRules();
    await page.getByTestId("open-filters").click();
    await page.getByTestId("ai-prompt").fill(AI_INPUTS.rule);
    await page.getByTestId("ai-generate").click();
    // written: the request folds into its card, and the rule's matches are counted
    await page.getByTestId("ai-prompt").waitFor({ state: "detached", timeout: MODEL_MS });
    await visible("ai-explanation");
    await page.locator("[data-testid=filter-preview][data-ready]").first().waitFor({ timeout: MODEL_MS });
    const preview = await page.getByTestId("filter-preview").first().innerText();
    console.log(`  rule (${n + 1}): ${redact((await page.getByTestId("ai-explanation").first().innerText()).replace(/\s+/g, " "))} · ${preview.split("\n")[0]}`);
    ruleGood = /Matches [1-9]/.test(preview);
  }
  await blur();
  await both("ai-rule", () => around([page.getByTestId("filters-dialog")], { pad: 20 }), ruleGood);
  await closeRules();

  // --- Today: the sent-mail scan's promise and unanswered question beside what waits for a reply ---
  for (const until = Date.now() + JOB_MS; ; await page.waitForTimeout(10_000)) {
    await go("today");
    await page.getByTestId("today-heading").waitFor();
    const text = await page.locator("main, body").first().innerText();
    if (/You said/.test(text) && /No reply/.test(text)) break;
    if (Date.now() > until) throw new Error("Today has no promise and no unanswered question after 5 minutes");
  }
  // the bar: the digest's row, once prepared, counts its newsletters. A model that put every issue under "other" leaves
  // none: the digest is turned off and on in Settings, as a person would (which prepares today's again), once. Short of
  // it, Today and the digest keep the previous run's pictures, and what the digest's page says is printed.
  const digestRow = page.getByTestId("digest-row").first();
  let digestGood = false;
  for (let n = 0; n < 2 && !digestGood; n++) {
    await page.waitForFunction(() => !/Preparing/.test(document.querySelector("[data-testid=digest-row]")?.textContent ?? "Preparing"), null, { timeout: JOB_MS });
    digestGood = /\d+ newsletters? · today/.test(await digestRow.innerText());
    if (digestGood) break;
    await say("digest row", digestRow);
    await digestRow.click();
    await say("digest page", page.getByTestId("digest-page"));
    await go("today");
    if (n) break;
    await blur();
    await page.keyboard.press("Meta+,");
    await page.getByTestId("tab-ai").click();
    await page.getByTestId("ai-digest-switch").click();
    await page.waitForFunction(() => document.querySelector("[data-testid=ai-digest-switch]")?.getAttribute("aria-checked") === "false");
    await switchOn("ai-digest-switch");
    await page.keyboard.press("Escape");
    await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
    await go("today");
  }
  await say("today", page.getByTestId("thread-list"));
  // the list's column, down to its last row
  await both(
    "ai-today",
    async () => {
      const list = (await page.getByTestId("thread-list").boundingBox())!;
      const last = (await rows.last().boundingBox())!;
      return { x: Math.round(list.x), y: Math.round(list.y), width: Math.round(list.width), height: Math.round(last.y + last.height + 24 - list.y) };
    },
    digestGood,
  );

  // --- the digest page ---
  if (digestGood) {
    await digestRow.click();
    await visible("digest-page");
    await page.getByTestId("digest-item").first().waitFor({ timeout: JOB_MS });
    await page.getByTestId("digest-preparing").waitFor({ state: "detached", timeout: JOB_MS }).catch(() => {});
    await say("digest", page.getByTestId("digest-page"));
    // a shorter window, so the page's foot (Untick all, Archive) sits under its lines rather than a screen below them
    const lines = (await page.getByTestId("digest-item").last().boundingBox())!;
    await page.setViewportSize({ width: VIEWPORT.width, height: Math.min(VIEWPORT.height, Math.round(lines.y + lines.height + 140)) });
    await both("ai-digest", () => around([page.getByTestId("digest-page")], { pad: 0 }));
    await page.setViewportSize(VIEWPORT);
  } else console.log("  ai-digest: below the bar, keeping the earlier picture");

  // --- Follow-ups: the list, and the unanswered question open with its card ---
  await go("followups");
  await rows.first().waitFor({ timeout: 30_000 });
  await open("Raw files from the workshop shoot");
  await visible("followup-line", 30_000);
  if (await page.getByTestId("tip-done").isVisible().catch(() => false)) await page.getByTestId("tip-done").click();
  await say("follow-up", page.getByTestId("followup-line"));
  // the list and the conversation: the sidebar marks All Mail beside Follow-ups while a conversation outside the Inbox is open
  await both("ai-followups", async () => {
    const list = (await page.getByTestId("thread-list").boundingBox())!;
    return { x: Math.round(list.x), y: 0, width: Math.round(VIEWPORT.width - list.x), height: VIEWPORT.height };
  });

}

await main().catch((error: unknown) => {
  console.error(redact((error as Error)?.stack ?? error));
  process.exit(1);
});

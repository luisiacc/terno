// Plan 167: the first launch of `pnpm dev:demo-ai` prepares the profile once, behind your windows. The app is driven
// through its own UI, as a person would (the rating's harness does the same), so every word comes from the real models
// through the code a user's click runs: nothing is written into the database by hand. Each step logs a line and is
// recorded in the profile's marker, so one that fails runs again on the next launch and the others are kept.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { askFinished, conversationDone, DEMO_AI_STEPS, demoAiClock, MARKER_FILE, MARKER_VERSION, partialVerdict, readMarker } from "../src/demo-ai.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { _electron: electron } = createRequire(join(root, "package.json"))("@playwright/test");

/** A model's answer can take a while; a job (the digest, follow-ups) runs in the background after its switch. */
const MODEL_MS = 180_000;
const JOB_MS = 300_000;
/** The Inbox's top conversations opened for a summary (and Reply ready where it applies), and Today's rows after them. */
const TOP = 6;
const TODAY_ROWS = 4;

/** Questions about the demo mailbox's own mail; the first gets a follow-up question. */
export const ASK_QUESTIONS = [
  { q: "What did Isabella say about the payment?", followUp: "When did she write about it?" },
  { q: "What's blocking the sistema de diseño work?" },
  { q: "Who asked me for a call this week, and when?" },
  { q: "Which newsletters came in this week, and what were they about?" },
];
/** Sent only if reading the last month's sent mail found nothing to follow up (the fallback, so the line still shows). */
export const FOLLOWUP = { to: "Arjun Ramírez", subject: "The flat on Saturday", body: "Hi Arjun,\n\nCould you send me the address of the flat before Friday? I'd like to see it on Saturday.\n\nThanks,\nLuis" };
export const RULE_REQUEST = "archive receipts from uber.com";

const now = () => new Date().toISOString();
/** Whether it shows within `timeout` (Playwright's isVisible doesn't wait). */
const shows = (locator, timeout) => locator.first().waitFor({ timeout }).then(() => true, () => false);

export function writeMarker(profile, marker) {
  writeFileSync(join(profile, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
}

export function loadMarker(profile) {
  let text = null;
  try { text = readFileSync(join(profile, MARKER_FILE), "utf8"); } catch { /* none yet */ }
  return readMarker(text) ?? { version: MARKER_VERSION, done: {} };
}

/** What the app counted it spent (its usage book, plan 131), as the rating reads it: requests and US dollars by task. */
export function readSpend(profile) {
  const db = new DatabaseSync(join(profile, "terno.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'ai:usage'").get();
    const byTask = {};
    for (const day of Object.values(row ? JSON.parse(row.value_json) : {})) for (const [task, t] of Object.entries(day)) {
      const sum = (byTask[task] ??= { requests: 0, usd: 0 });
      sum.requests += t.requests ?? 0;
      sum.usd += t.usd ?? 0;
    }
    return byTask;
  } finally { db.close(); }
}

// ─── driving the window ─────────────────────────────────────────────────────

function driver(page, log) {
  const d = { page };
  d.isVisible = (sel) => page.locator(sel).first().isVisible().catch(() => false);
  d.blur = () => page.evaluate(() => document.activeElement?.blur());
  d.rows = page.getByTestId("thread-row");
  d.escapeAll = async () => {
    for (let i = 0; i < 6 && (await d.isVisible("[role=dialog], [role=menu], [data-testid=settings-dialog], [data-testid=filters-dialog]")); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
    }
  };
  d.go = async (view) => {
    await d.escapeAll();
    await page.getByTestId(`nav-${view}`).click();
    await d.rows.first().waitFor({ timeout: 30_000 }).catch(() => {});
  };
  d.settings = async (tab) => {
    if (!(await d.isVisible("[data-testid=settings-dialog]"))) await page.keyboard.press("Meta+,");
    await page.getByTestId(`tab-${tab}`).click();
  };
  d.closeSettings = async () => {
    await page.keyboard.press("Escape");
    await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
  };
  d.switchOn = async (testId) => {
    const control = page.getByTestId(testId);
    await control.waitFor();
    if ((await control.getAttribute("aria-checked")) !== "true") await control.click();
    await page.waitForFunction((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-checked") === "true", testId);
  };
  d.log = log;
  return d;
}

const STEPS = {
  /** Settings → Dev mode → Pro AI, then the four background switches in Settings → AI. */
  async "ai-on"(d) {
    const { page } = d;
    await d.settings("dev");
    await d.switchOn("dev-ai-switch");
    await d.settings("ai");
    await d.switchOn("ai-summaries-switch");
    await d.switchOn("ai-followups-switch");
    // the offer to read the last 30 days of sent mail (the app's bound: 300 messages, one small request each): taken, so
    // follow-ups are found in the demo's own mail, and the old ones are already due in Today
    const offer = page.getByTestId("ai-followups-offer");
    if (await shows(offer, 5000)) {
      d.log(`  follow-ups: ${(await offer.locator("span").first().innerText()).replace(/\s+/g, " ").trim()} Yes.`);
      await page.getByTestId("ai-followups-check").click();
    }
    await d.switchOn("replies-switch");
    await d.switchOn("ai-digest-switch");
    await d.closeSettings();
  },

  /**
   * Turning the digest on at 16:00 prepares today's at once (its time is 08:00): its page, until its lines show. A
   * failure is tried again once with the page's own Try again, as a person would.
   */
  async digest(d) {
    const { page } = d;
    await d.go("today");
    await page.getByTestId("today-heading").waitFor({ timeout: 30_000 });
    const row = page.getByTestId("digest-row").first();
    await row.waitFor({ timeout: JOB_MS });
    await row.click();
    await page.getByTestId("digest-page").waitFor({ timeout: 30_000 });
    const until = Date.now() + JOB_MS;
    let retried = false;
    for (;;) {
      const preparing = await page.getByTestId("digest-preparing").first().isVisible().catch(() => false);
      if (!preparing && (await page.getByTestId("digest-item").first().isVisible().catch(() => false))) break;
      if (await page.getByTestId("digest-failed").first().isVisible().catch(() => false)) {
        if (retried) throw new Error("the digest failed twice: its page says why");
        retried = true;
        d.log("  the digest failed; trying again");
        await page.getByTestId("digest-retry").click();
      }
      if (Date.now() > until) throw new Error("the digest wasn't ready in 5 minutes");
      await page.waitForTimeout(1000);
    }
    d.log(`  ${await page.getByTestId("digest-item").count()} newsletters in today's digest: ${(await row.innerText()).replace(/\s+/g, " ").trim()}`);
  },

  /**
   * The Inbox's top conversations, then the ones Today says need you: each opened, so Reply ready prepares where it
   * applies (a conversation waiting for your reply), and summarized. Both are kept and show again on the next open.
   */
  async conversations(d, progress) {
    const { page } = d;
    const opened = new Set();
    const counts = { summaries: 0, replies: 0 };
    const missing = [];
    const visit = async (row, where) => {
      await row.click();
      await page.getByTestId("reader-subject").waitFor();
      const title = (await page.getByTestId("reader-subject").innerText()).trim();
      if (opened.has(title)) return d.log(`  ${where}: ${title}, opened above`);
      opened.add(title);
      // done on an earlier launch: both are kept, opening it again shows them
      if (progress.has(title)) return d.log(`  ${where}: ${title}, done earlier`);
      // Reply ready starts as a conversation that waits for your reply opens; the summary is asked for meanwhile
      let summary = "none";
      const summarize = page.getByTestId("action-summarize");
      if (await summarize.isVisible().catch(() => false)) {
        await summarize.click();
        await page.getByTestId("summary-block").first().waitFor({ timeout: 15_000 });
        summary = await page.waitForFunction(() => {
          const s = document.querySelector("[data-testid=summary-block]")?.getAttribute("data-state");
          return s === "ready" || s === "error" ? s : null;
        }, null, { timeout: MODEL_MS }).then((h) => h.jsonValue(), () => "timeout");
        if (summary === "ready") counts.summaries++;
      }
      // the card shows once the model said a reply is wanted; when it decides none is, it never shows
      let reply = "none";
      if (await shows(page.getByTestId("reply-ready"), 20_000)) {
        reply = (await shows(page.locator("[data-testid=reply-ready][data-phase=ready]"), MODEL_MS)) ? "ready" : "unfinished";
        if (reply === "ready") counts.replies++;
      }
      if (conversationDone({ summary, reply })) progress.add(title);
      else missing.push(title);
      d.log(`  ${where}: ${title}${summary === "none" ? "" : summary === "ready" ? ", summary" : `, summary ${summary}`}${reply === "ready" ? ", Reply ready" : reply === "unfinished" ? ", Reply ready didn't finish" : ""}`);
    };
    await d.go("inbox");
    for (let i = 0; i < TOP; i++) await visit(d.rows.nth(i), `Inbox #${i + 1}`);
    await d.go("today");
    const todayRows = page.locator("[data-testid=thread-row]");
    const n = Math.min(TODAY_ROWS, await todayRows.count());
    for (let i = 0; i < n; i++) {
      await d.go("today");
      await visit(todayRows.nth(i), `Today #${i + 1}`);
    }
    d.log(`  ${counts.summaries} summaries, ${counts.replies} prepared replies this launch`);
    return missing;
  },

  /**
   * What the old sent mail is waiting for (the scan the first step said yes to runs in the background): the Follow-ups
   * list, until it has a row. If the month's sent mail had nothing, one message is sent so the line still shows.
   */
  async followups(d, progress) {
    const { page } = d;
    const list = async () => {
      await d.escapeAll();
      await d.blur();
      await page.keyboard.press("Meta+k");
      await page.getByTestId("palette-input").fill("Follow-ups");
      await page.getByTestId("palette-go-followups").click();
    };
    const until = Date.now() + JOB_MS;
    for (;;) {
      await list();
      const count = await d.rows.first().waitFor({ timeout: 10_000 }).then(() => d.rows.count(), () => 0);
      if (count) return d.log(`  ${count} conversation${count === 1 ? "" : "s"} waiting for a reply (Follow-ups)`);
      if (Date.now() > until) break;
      await page.waitForTimeout(10_000);
    }
    if (!progress.has(FOLLOWUP.subject)) {
      await d.go("inbox");
      await d.blur();
      await page.keyboard.press("c");
      await page.getByTestId("compose-to").waitFor();
      await page.keyboard.type(FOLLOWUP.to);
      await page.getByTestId("recipient-suggestion").first().click();
      await page.getByTestId("recipient-chip").first().waitFor();
      await page.getByTestId("compose-subject").fill(FOLLOWUP.subject);
      await page.getByTestId("compose-body").click();
      await page.keyboard.type(FOLLOWUP.body);
      await page.keyboard.press("Meta+Enter");
      await page.getByTestId("composer").waitFor({ state: "detached" });
      progress.add(FOLLOWUP.subject);
      d.log(`  nothing in the month's sent mail: sent "${FOLLOWUP.subject}" to ${FOLLOWUP.to}`);
    }
    await d.blur();
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    const sent = d.rows.filter({ hasText: FOLLOWUP.subject }).first();
    await sent.waitFor({ timeout: 30_000 });
    await sent.click();
    await page.getByTestId("reader-subject").waitFor();
    if (!(await shows(page.getByTestId("followup-line"), JOB_MS))) throw new Error("no follow-up line on the sent message in 5 minutes");
    d.log(`  the follow-up line is on "${FOLLOWUP.subject}"`);
  },

  /** Four questions, one with a follow-up: Ask's history (⇧⌘K) has four conversations. */
  async ask(d, progress) {
    const { page } = d;
    const open = async () => {
      for (let i = 0; !(await d.isVisible("[data-testid=palette-input]")); i++) {
        if (i === 4) throw new Error("Ask (⇧⌘K) didn't open");
        if (await d.isVisible("[data-testid=ask-new]")) { await page.getByTestId("ask-new").click(); await page.getByTestId("palette-input").waitFor({ timeout: 5000 }).catch(() => {}); continue; }
        if (i) await d.escapeAll();
        await d.blur();
        await page.keyboard.press("Meta+Shift+k");
        await page.locator("[data-testid=palette-input], [data-testid=ask-new]").first().waitFor({ timeout: 5000 }).catch(() => {});
      }
    };
    const finished = (min) => page.waitForFunction((n) => {
      const turns = document.querySelectorAll("[data-testid=ask-turn]");
      return turns.length >= n && ["answered", "partial", "not_found", "stopped", "failed"].includes(turns[turns.length - 1].getAttribute("data-status") ?? "");
    }, min, { timeout: MODEL_MS });
    const missing = [];
    for (const { q, followUp } of ASK_QUESTIONS) {
      // asked on an earlier launch whose step didn't finish: in the history already
      if (progress.has(q)) continue;
      await d.go("inbox");
      await open();
      await page.getByTestId("palette-input").fill(q);
      await page.getByTestId("ask-submit").waitFor();
      await page.keyboard.press("Enter");
      await finished(1);
      const statuses = [await page.locator("[data-testid=ask-turn]").last().getAttribute("data-status")];
      if (followUp && askFinished(statuses)) {
        await page.getByTestId("ask-follow-up").fill(followUp);
        await page.getByTestId("ask-follow-up").press("Enter");
        await finished(2);
        statuses.push(await page.locator("[data-testid=ask-turn]").last().getAttribute("data-status"));
      }
      // only a question whose turns all finished counts: a failed one is asked again next launch
      if (askFinished(statuses) && statuses.length === (followUp ? 2 : 1)) progress.add(q);
      else missing.push(q);
      d.log(`  "${q}": ${statuses.join(" + ")}`);
      await d.escapeAll();
    }
    return missing;
  },

  /** Filters → Create with AI → saved, for future mail only: the Inbox stays as it is. */
  async rule(d, progress) {
    const { page } = d;
    if (progress.has(RULE_REQUEST)) return d.log("  saved on an earlier launch");
    await d.go("inbox");
    await page.getByTestId("open-filters").click();
    // the list says "AI · applied N times" under a rule made with AI
    const aiRule = () => page.getByTestId("filter-item").filter({ hasText: /uber/i }).filter({ hasText: /AI ·/ }).first();
    // saved on a launch that stopped before recording it: kept, not made twice
    if (await shows(aiRule(), 3000)) {
      progress.add(RULE_REQUEST);
      d.log(`  already saved: ${(await aiRule().innerText()).split("\n")[0]}`);
      return d.escapeAll();
    }
    await page.getByTestId("ai-prompt").fill(RULE_REQUEST);
    await page.getByTestId("ai-generate").click();
    await page.getByTestId("ai-explanation").first().waitFor({ timeout: MODEL_MS });
    await page.locator("[data-testid=filter-preview][data-ready]").first().waitFor({ timeout: MODEL_MS }).catch(() => {});
    const name = (await page.getByTestId("filter-name").first().inputValue().catch(() => "")).trim();
    await page.getByTestId("filter-save").click();
    // saved is the rule in the list, marked AI, and nothing left unsaved: only then is it recorded
    await aiRule().waitFor({ timeout: 15_000 });
    await page.getByTestId("filter-unsaved").waitFor({ state: "detached", timeout: 15_000 });
    progress.add(RULE_REQUEST);
    d.log(`  "${RULE_REQUEST}" → ${name || "a rule"}`);
    await d.escapeAll();
  },

  /** Learned on this machine from the sent mail, no model: waited for a minute, or left to finish on its own. */
  async style(d) {
    const { page } = d;
    await d.settings("ai");
    await page.getByTestId("ai-drafting-style-open").click();
    await page.getByTestId("writing-style").waitFor();
    const learned = await shows(page.getByTestId("style-status").filter({ hasText: /Learned from|Aprendido/ }), 60_000);
    d.log(learned ? `  ${(await page.getByTestId("style-status").first().innerText()).replace(/\s+/g, " ").trim()}` : "  still learning: it finishes on its own (Settings → AI → Writing style)");
    await d.escapeAll();
  },
};

/**
 * Runs `steps` on the profile behind your windows and records each in the marker. Returns the steps that failed.
 * `env(now)` is demoAiEnv's with `background: true`, the clock starting at `now`.
 */
export async function prepare({ electronBin, main, env, profile, steps, onPid = () => {}, log = console.log }) {
  const marker = loadMarker(profile);
  if (steps.length === DEMO_AI_STEPS.length) Object.assign(marker, { done: {}, progress: {}, attempts: {} });
  marker.failed = {};
  marker.progress ??= {};
  marker.attempts ??= {};
  // the marker first: the profile is this demo's from its first moment, even if this launch stops early
  mkdirSync(profile, { recursive: true });
  writeMarker(profile, marker);
  const startsAt = demoAiClock(marker);
  const launched = Date.now();
  // the demo's clock goes into every checkpoint: a launch stopped by Ctrl-C never leaves the next one behind it
  const save = () => { marker.clock = startsAt + (Date.now() - launched) + 60_000; writeMarker(profile, marker); };
  const app = await electron.launch({ executablePath: electronBin, args: [main], env: env(startsAt) });
  const pid = app.process().pid;
  onPid(pid);
  const failed = [];
  try {
    const page = await app.firstWindow();
    // keys and shortcuts work in a window that never takes focus (the rating's way)
    await (await page.context().newCDPSession(page)).send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await page.getByTestId("thread-row").first().waitFor({ timeout: 120_000 });
    // the window's clock agrees with the backend's (plan 167): the demo's 22 October
    const windowNow = await page.evaluate(() => Date.now());
    if (Math.abs(windowNow - startsAt - (Date.now() - launched)) > 60_000) log(`[demo-ai] note: the window's clock reads ${new Date(windowNow).toISOString()}, not the demo's`);
    const d = driver(page, log);
    for (const [i, step] of steps.entries()) {
      log(`[demo-ai] ${i + 1}/${steps.length} ${step} …`);
      const started = Date.now();
      const items = new Set(marker.progress[step] ?? []);
      // each item is on disk as soon as it's made: a step run again never makes it twice
      const progress = { has: (k) => items.has(k), add: (k) => { items.add(k); marker.progress[step] = [...items]; save(); } };
      const attempt = (marker.attempts[step] = (marker.attempts[step] ?? 0) + 1);
      try {
        const missing = (await STEPS[step](d, progress)) ?? [];
        const verdict = partialVerdict(missing, attempt);
        if (verdict === "again") throw new Error(`${missing.length} not finished: ${missing.join("; ")}`);
        if (verdict === "keep") log(`[demo-ai] ${step}: ${missing.join("; ")} still not finished after ${attempt} launches; keeping what's there`);
        marker.done[step] = now();
        log(`[demo-ai] ${step} done in ${Math.round((Date.now() - started) / 1000)} s`);
      } catch (error) {
        const why = String(error?.message ?? error).split("\n")[0];
        marker.failed[step] = why;
        failed.push(step);
        log(`[demo-ai] ${step} didn't finish (${why}); it runs again on the next launch`);
        await page.screenshot({ path: join(profile, `demo-ai-${step}-failed.png`) }).catch(() => {});
        await d.escapeAll().catch(() => {});
      }
      save();
    }
  } finally {
    // a clean quit, so what was written is on disk before the window you use opens the same profile
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 20_000))]);
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    // later launches start just after this one ended, so nothing it made is ahead of their clock
    save();
  }
  return failed;
}

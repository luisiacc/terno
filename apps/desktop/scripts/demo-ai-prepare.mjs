// Plan 167: the first launch of `pnpm dev:demo-ai` prepares the profile once, behind your windows. The app is driven
// through its own UI, as a person would (the rating's harness does the same), so every word comes from the real models
// through the code a user's click runs: nothing is written into the database by hand. Each step logs a line and is
// recorded in the profile's marker, so one that fails runs again on the next launch and the others are kept.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { askFinished, conversationDone, replyOutcome, replyStillComing, DEMO_AI_STEPS, DEMO_SINCE_SUBJECTS, demoAiClock, MARKER_FILE, MARKER_VERSION, partialVerdict, readMarker } from "../src/demo-ai.ts";

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
/** What the app stored, read while it runs (never written): a thread's Reply ready row, its wait, the AI rules. */
export function readStored(profile, run) {
  const db = new DatabaseSync(join(profile, "terno.db"), { readOnly: true });
  try { return run(db); } finally { db.close(); }
}
const replyStored = (profile, threadId) => readStored(profile, (db) => ({
  stored: db.prepare("SELECT state FROM ai_prepared_replies WHERE thread_id = ?").get(threadId)?.state ?? null,
  waitingSince: db.prepare("SELECT waiting_since FROM threads WHERE id = ?").get(threadId)?.waiting_since ?? null,
}));
const summaryStored = (profile, threadId) => readStored(profile, (db) => db.prepare("SELECT state FROM ai_summaries WHERE thread_id = ?").get(threadId)?.state === "ready");
const aiRules = (profile) => readStored(profile, (db) => db.prepare("SELECT name FROM filters WHERE source = 'ai'").all().map((r) => r.name));

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

/**
 * The conversations step's second half: each conversation it left with work underway, settled. Replies first, from what
 * the app stored (a reply that was writing has the model's time; one that wasn't is read once); by then most summaries are
 * stored too, and only one that isn't is opened again, where its block says running, ready or failed.
 */
async function settleConversations(d, progress, started) {
  const { page } = d;
  const counts = { summaries: 0, replies: 0 };
  const missing = [];
  const from = Date.now();
  for (const c of started) {
    if (c.note) continue;
    for (;; await page.waitForTimeout(500)) {
      const stored = replyStored(d.profile, c.threadId);
      c.reply = replyOutcome({ cardReady: false, ...stored, now: await page.evaluate(() => Date.now()) });
      if (!replyStillComing({ reply: c.reply, stored: stored.stored, writing: c.writing, waited: Date.now() - from, limit: MODEL_MS })) break;
    }
  }
  for (const c of started) {
    if (c.note) { d.log(`  ${c.where}: ${c.title}, ${c.note}`); continue; }
    c.summary = !c.summarized ? "none" : summaryStored(d.profile, c.threadId) ? "ready" : await summaryShown(d, c);
    if (c.summary === "ready") counts.summaries++;
    if (c.reply === "ready") counts.replies++;
    if (conversationDone(c)) progress.add(c.title);
    else missing.push(c.title);
    d.log(`  ${c.where}: ${c.title}${c.summary === "none" ? "" : c.summary === "ready" ? ", summary" : `, summary ${c.summary}`}${c.reply === "ready" ? ", Reply ready" : c.reply === "unfinished" ? ", Reply ready didn't finish" : ""}`);
  }
  d.log(`  ${counts.summaries} summaries, ${counts.replies} prepared replies this launch`);
  return missing;
}

/** A summary not stored yet: its conversation opened again, and its block waited for (the window keeps its state). */
async function summaryShown(d, c) {
  const { page } = d;
  await d.go(c.view);
  const row = page.locator(`[data-testid=thread-row][data-thread-id="${c.threadId}"]`).first();
  if (!(await shows(row, 10_000))) return "timeout";
  await row.click();
  // its own block, not the one of the conversation open before it
  return page.waitForFunction((title) => {
    if (document.querySelector("[data-testid=reader-subject]")?.innerText?.trim() !== title) return null;
    const s = document.querySelector("[data-testid=summary-block]")?.getAttribute("data-state");
    return s === "ready" || s === "error" ? s : null;
  }, c.title, { timeout: MODEL_MS }).then((h) => h.jsonValue(), () => "timeout");
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
    // plan 247: the digest is What matters' (Once a day)
    await d.settings("whatMatters");
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
    await page.getByTestId("wm-heading").first().waitFor({ timeout: 30_000 });
    const row = page.locator("[data-testid=wm-item][data-digest]").first();
    await row.waitFor({ timeout: JOB_MS });
    await row.click();
    await page.getByTestId("digest-page").waitFor({ timeout: 30_000 });
    const until = Date.now() + JOB_MS;
    let retried = false;
    for (;;) {
      // a failure first: a digest whose later batch failed keeps the lines of the earlier ones
      if (await page.getByTestId("digest-failed").first().isVisible().catch(() => false)) {
        if (retried) throw new Error("the digest failed twice: its page says why");
        retried = true;
        d.log("  the digest failed; trying again");
        await page.getByTestId("digest-retry").click();
        await page.waitForTimeout(1000);
        continue;
      }
      const preparing = await page.getByTestId("digest-preparing").first().isVisible().catch(() => false);
      if (!preparing && (await page.getByTestId("digest-item").first().isVisible().catch(() => false))) break;
      if (Date.now() > until) throw new Error("the digest wasn't ready in 5 minutes");
      await page.waitForTimeout(1000);
    }
    d.log(`  ${await page.getByTestId("digest-item").count()} newsletters in today's digest: ${(await row.innerText()).replace(/\s+/g, " ").trim()}`);
  },

  /**
   * The Inbox's top conversations, then the ones Today says need you: each opened, so Reply ready prepares where it
   * applies (a conversation waiting for your reply), and summarized. Both are kept and show again on the next open.
   *
   * The model's work overlaps: a conversation is left as soon as both are underway for good (a summary goes on without
   * its reader; a reply does once its first words are in, before that leaving stops it), and every one is settled at
   * the end. A conversation that owes no reply moves on at once, with no wait for a card that never comes.
   */
  async conversations(d, progress) {
    const { page } = d;
    const opened = new Set();
    const started = [];
    const visit = async (row, where, view) => {
      const threadId = Number(await row.getAttribute("data-thread-id"));
      await row.click();
      await page.getByTestId("reader-subject").waitFor();
      const title = (await page.getByTestId("reader-subject").innerText()).trim();
      // logged in its place once everything is settled
      if (opened.has(title)) return started.push({ where, title, note: "opened above" });
      opened.add(title);
      // done on an earlier launch: both are kept, opening it again shows them
      if (progress.has(title)) return started.push({ where, title, note: "done earlier" });
      // Reply ready starts as a conversation that waits for your reply opens; the summary is asked for meanwhile
      const summarize = page.getByTestId("action-summarize");
      const summarized = await summarize.isVisible().catch(() => false);
      if (summarized) {
        await summarize.click();
        await page.getByTestId("summary-block").first().waitFor({ timeout: 15_000 });
      }
      // stay until the reply is settled or writing (its first words in); what the app stored settles it (replyOutcome)
      // a model still deciding has a minute, as before; its card (the model said yes) gives it the model's time
      let writing = false;
      for (const since = Date.now(); ; await page.waitForTimeout(250)) {
        if ((writing = await d.isVisible("[data-testid=reply-ready-text]"))) break;
        const stored = replyStored(d.profile, threadId);
        const reply = replyOutcome({ cardReady: false, ...stored, now: await page.evaluate(() => Date.now()) });
        if (reply !== "unfinished" || stored.stored === "failed") break;
        if (Date.now() - since > ((await d.isVisible("[data-testid=reply-ready]")) ? MODEL_MS : 60_000)) break;
      }
      started.push({ threadId, title, where, view, summarized, writing });
    };
    await d.go("inbox");
    for (let i = 0; i < TOP; i++) await visit(d.rows.nth(i), `Inbox #${i + 1}`, "inbox");
    await d.go("today");
    const todayRows = page.locator("[data-testid=thread-row]");
    const n = Math.min(TODAY_ROWS, await todayRows.count());
    for (let i = 0; i < n; i++) {
      await d.go("today");
      await visit(todayRows.nth(i), `Today #${i + 1}`, "today");
    }
    return settleConversations(d, progress, started);
  },

  /**
   * Plan 279: the conversations with new mail since you read, each opened as a person would (the reader keeps what it
   * drew unread, the dwell then reads it) and summarized with the toolbar's button, so the card opens on what's new. The
   * last changes nothing ("¡Gracias, recibida!"): its card is the whole summary alone. Returns what didn't finish.
   */
  async since(d, progress) {
    const { page } = d;
    const missing = [];
    for (const subject of DEMO_SINCE_SUBJECTS) {
      if (progress.has(subject)) { d.log(`  ${subject}: done earlier`); continue; }
      await d.go("inbox");
      const row = d.rows.filter({ hasText: subject }).first();
      if (!(await shows(row, 15_000))) { missing.push(`${subject} isn't in the Inbox`); continue; }
      await row.click();
      await page.getByTestId("reader-subject").waitFor();
      await page.getByTestId("message").first().waitFor();
      await page.getByTestId("action-summarize").click();
      const block = page.locator("[data-testid=summary-block][data-state=ready]");
      if (!(await shows(block, MODEL_MS))) { missing.push(`${subject}: no summary`); continue; }
      const view = await d.isVisible("[data-testid=summary-view]");
      const text = (await page.getByTestId("summary-text").innerText()).replace(/\s+/g, " ").trim();
      d.log(`  ${subject}: ${view ? `since: "${text}"` : `whole summary only: "${text}"`}`);
      progress.add(subject);
    }
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
    // the demo mailbox has no rule made with AI: one there is ours, saved by a launch that stopped before recording
    // it, and kept rather than made twice
    const before = aiRules(d.profile);
    if (before.length) {
      progress.add(RULE_REQUEST);
      d.log(`  already saved: ${before.join(", ")}`);
      return d.escapeAll();
    }
    await page.getByTestId("ai-prompt").fill(RULE_REQUEST);
    await page.getByTestId("ai-generate").click();
    await page.getByTestId("ai-explanation").first().waitFor({ timeout: MODEL_MS });
    await page.locator("[data-testid=filter-preview][data-ready]").first().waitFor({ timeout: MODEL_MS }).catch(() => {});
    const name = (await page.getByTestId("filter-name").first().inputValue().catch(() => "")).trim();
    await page.getByTestId("filter-save").click();
    // saved is a rule made with AI in the store: only then is it recorded
    for (const until = Date.now() + 15_000; !aiRules(d.profile).length; await page.waitForTimeout(250)) if (Date.now() > until) throw new Error("the rule wasn't saved");
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

  /**
   * Plan 281: People reads what the steps before made (What matters' items, the replies owed to you), so it only waits for
   * Open to settle. One thing no step makes is something put off: one person whose only item is a conversation waiting on
   * your reply (the mailbox's, not a model's) has it put off to Later's furthest preset, so Open ends with them, uncounted.
   */
  async people(d, progress) {
    const { page } = d;
    if (progress.has("later")) return d.log("  put off on an earlier launch");
    await d.escapeAll();
    // People sits under the Inbox whenever the AI features are on (never in More)
    if (!(await shows(page.getByTestId("nav-people"), 10_000))) return ["People isn't in the sidebar (are the AI features on?)"];
    await page.getByTestId("nav-people").click();
    await page.getByTestId("people").waitFor();
    const list = page.getByTestId("people-rows");
    const line = async () => (await page.getByTestId("people-line").textContent())?.trim() ?? "";
    // settled: Open's line holds for 10 s (What matters' readers may still be at it)
    const end = Date.now() + 180_000;
    for (let last = "", since = Date.now(); Date.now() < end; await page.waitForTimeout(1000)) {
      const now = await line();
      if (now !== last) [last, since] = [now, Date.now()];
      else if (Date.now() - since > 10_000) break;
    }
    d.log(`  People: ${await line()}`);
    /**
     * One person tried: their page holds one item, a conversation waiting on your reply (its id, never the words: the
     * language may be Spanish), put off to Later's last preset. Recorded before the click, so a launch stopped after it
     * finds that item put off and doesn't put off someone else.
     */
    // never a conversation an earlier step showed off (a summary, Reply ready, what's new): those stay in What matters
    const shown = [...(loadMarker(d.profile).progress?.conversations ?? []), ...DEMO_SINCE_SUBJECTS];
    const tryPerson = async (key) => {
      await list.locator(`[data-testid=person-row][data-key="${key}"]`).click();
      const items = page.getByTestId("person-page").getByTestId("person-item");
      await items.first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      if ((await items.count()) !== 1) return false;
      const id = await items.first().getAttribute("data-item");
      if (!id?.startsWith("waiting:")) return false;
      const text = await items.first().innerText();
      if (shown.some((subject) => text.includes(subject))) return false;
      const item = page.getByTestId("person-page").locator(`[data-testid=person-item][data-item="${id}"]`);
      const name = (await page.getByTestId("person-name").innerText()).trim();
      if (progress.has(`person:${key}`) && (await item.getAttribute("data-later")) !== null) {
        progress.add("later");
        d.log(`  ${name}: put off on an earlier launch`);
        return true;
      }
      if ((await item.getAttribute("data-later")) !== null) return false;
      await item.hover();
      await item.getByTestId("person-item-later").click();
      const menu = page.getByTestId("person-item-later-menu");
      await menu.waitFor();
      const presets = menu.locator("[role=menuitem]:not([data-testid=person-item-later-pick])");
      if (!(await presets.count())) { await page.keyboard.press("Escape"); return false; }
      const choice = (await presets.last().innerText()).replace(/\s+/g, " ").trim();
      progress.add(`person:${key}`);
      await presets.last().click();
      await page.getByTestId("person-page").locator(`[data-testid=person-item][data-item="${id}"][data-later]`).waitFor({ timeout: 15_000 });
      progress.add("later");
      d.log(`  ${name}: their only item put off (${choice}); Open lists them last, uncounted`);
      return true;
    };
    // a launch stopped mid-way: the person it chose, first (they may sit at Open's end by now)
    const chosen = progress.list().filter((k) => k.startsWith("person:")).map((k) => k.slice(7));
    // Open, top to bottom through the virtual list: each row drawn above Everyone's heading, with nothing else open (no +N)
    // (a first pass over Open for the person a stopped launch chose, when there's one: anyone else only after)
    for (let pass = chosen.length ? 0 : 1; ; pass++) {
      const tried = new Set();
      await list.evaluate((el) => (el.scrollTop = 0));
      for (let bottom = false; !bottom; ) {
        const rows = await list.locator("[data-testid=person-row]").evaluateAll((els) => {
          const everyone = document.querySelector("[data-testid=people-heading][data-kind=everyone]");
          return els.filter((r) => !everyone || r.compareDocumentPosition(everyone) & Node.DOCUMENT_POSITION_FOLLOWING).map((r) => ({ key: r.dataset.key, more: !!r.querySelector("[data-slot=badge]") }));
        });
        for (const r of rows) {
          if (r.more || tried.has(r.key) || (pass === 0 && !chosen.includes(r.key))) continue;
          tried.add(r.key);
          if (await tryPerson(r.key)) return d.go("inbox");
        }
        // Open ends where Everyone's heading is drawn
        bottom = (await list.locator("[data-testid=people-heading][data-kind=everyone]").count()) > 0 || (await list.evaluate((el) => {
          const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
          el.scrollTop += el.clientHeight * 0.8;
          return end;
        }));
        if (!bottom) await page.waitForTimeout(150);
      }
      if (pass === 0) continue;
      // nobody yet: What matters may still be reading; looked at again until the step's three minutes are up
      if (Date.now() > end) return ["no one in Open whose only item waits on your reply, to put off with Later"];
      await page.waitForTimeout(10_000);
    }
  },
};

/**
 * Runs `steps` on the profile behind your windows and records each in the marker. Returns the steps that failed, and
 * `closed` when you closed its window or quit it: a stop, as Ctrl-C is, so nothing opens after it and the step it was on
 * isn't counted as a try. `env(now)` is demoAiEnv's with `background: true`, the clock starting at `now`.
 */
export async function prepare({ electronBin, main, env, profile, steps, onPid = () => {}, onSave = () => {}, log = console.log }) {
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
  // and once more as Ctrl-C stops it, so a long step's work is never ahead of the next launch's clock
  onSave(save);
  const app = await electron.launch({ executablePath: electronBin, args: [main], env: env(startsAt) });
  const pid = app.process().pid;
  onPid(pid);
  const failed = [];
  // You closing its window or quitting it is a stop, not a failure. Its main process notes either the moment it
  // happens (Playwright's close events and the errors they cause arrive in no set order, and a step may swallow those
  // errors); asked only before our own close, so that one never counts.
  const exited = new Promise((r) => app.process().once("exit", (code) => r(code)));
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const note = (why) => () => (globalThis.demoAiStopped ??= why);
    electronApp.once("before-quit", note("quit"));
    for (const w of BrowserWindow.getAllWindows()) w.once("close", note("close"));
    electronApp.on("browser-window-created", (_e, w) => w.once("close", note("close")));
  }).catch(() => {});
  let closed = false;
  const youStopped = async () => {
    if (closed) return true;
    const said = await app.evaluate(() => globalThis.demoAiStopped ?? false).catch(() => null);
    // gone before it could say: a quit ends with 0, a crash doesn't (and is a failure)
    closed = !!(said ?? (await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000).unref())])) === 0);
    return closed;
  };
  let page = null;
  try {
    page = await app.firstWindow();
    // keys and shortcuts work in a window that never takes focus (the rating's way)
    await (await page.context().newCDPSession(page)).send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await page.getByTestId("thread-row").first().waitFor({ timeout: 120_000 });
    // the window's clock agrees with the backend's (plan 167): the demo's 22 October
    const windowNow = await page.evaluate(() => Date.now());
    if (Math.abs(windowNow - startsAt - (Date.now() - launched)) > 60_000) log(`[demo-ai] note: the window's clock reads ${new Date(windowNow).toISOString()}, not the demo's`);
    const d = driver(page, log);
    d.profile = profile;
    for (const [i, step] of steps.entries()) {
      log(`[demo-ai] ${i + 1}/${steps.length} ${step} …`);
      const started = Date.now();
      const items = new Set(marker.progress[step] ?? []);
      // each item is on disk as soon as it's made: a step run again never makes it twice
      const progress = { has: (k) => items.has(k), list: () => [...items], add: (k) => { items.add(k); marker.progress[step] = [...items]; save(); } };
      const attempt = (marker.attempts[step] = (marker.attempts[step] ?? 0) + 1);
      try {
        const missing = (await STEPS[step](d, progress)) ?? [];
        if (await youStopped()) throw new Error("stopped");
        const verdict = partialVerdict(missing, attempt);
        if (verdict === "again") throw new Error(`${missing.length} not finished: ${missing.join("; ")}`);
        if (verdict === "keep") log(`[demo-ai] ${step}: ${missing.join("; ")} still not finished after ${attempt} launches; keeping what's there`);
        marker.done[step] = now();
        log(`[demo-ai] ${step} done in ${Math.round((Date.now() - started) / 1000)} s`);
      } catch (error) {
        if (await youStopped()) {
          marker.attempts[step] = attempt - 1;
          log(`[demo-ai] ${step} stopped: its window was closed`);
          break;
        }
        const why = String(error?.message ?? error).split("\n")[0];
        marker.failed[step] = why;
        failed.push(step);
        log(`[demo-ai] ${step} didn't finish (${why}); it runs again on the next launch`);
        await page.screenshot({ path: join(profile, `demo-ai-${step}-failed.png`) }).catch(() => {});
        await d.escapeAll().catch(() => {});
      }
      save();
    }
  } catch (error) {
    // closed before the first step began (the window still loading)
    if (!(await youStopped())) throw error;
  } finally {
    // the last word before our own close: a quit you began as the last step ended counts
    await youStopped();
    // a clean quit, so what was written is on disk before the window you use opens the same profile
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 20_000))]);
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    // later launches start just after this one ended, so nothing it made is ahead of their clock
    save();
  }
  return { failed, closed };
}

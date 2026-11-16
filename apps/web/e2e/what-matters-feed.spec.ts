/**
 * Plan 210: What matters as a feed with its history. The open part on top, the automated section, then "Earlier": each
 * conversation's newest closing, newest first, paged in as the feed is scrolled; Done moves a line from the open part to
 * the history and Undo moves it back; a new item arrives while the feed is on screen; virtualized; axe in light and dark.
 */
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, expect, fresh, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };
const HOUR = 3_600_000;
/** more than the first page (40) holds, so the history pages */
const CLOSED = 60;

function message(server: DevServerFixture, key: string, from: { name: string; email: string }, subject: string, text: string, date = E2E_NOW, over: Partial<IncomingMessage> = {}): IncomingMessage {
  const db = sqlDb(server.backend.store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  return { accountId: acct.id, providerMsgId: key, providerThreadId: key, rfcMessageId: `<${key}@e2e.test>`, inReplyTo: null, references: [], from, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject, date, snippet: text, bodyText: text, bodyHtml: null, bodyState: "full", listId: null, isRead: true, isStarred: false, inInbox: false, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200, ...over } as unknown as IncomingMessage;
}

/** a dated item on its own conversation, written as the reader writes one; closed at `closedAt`, or left open (due today 1 PM) */
async function item(server: DevServerFixture, key: string, text: string, closedAt: number | null, inbox = false) {
  const store = server.backend.store;
  const db = sqlDb(store);
  await store.sync.ingest([message(server, key, { name: "Billing", email: `${key}@bills.test` }, `${text} (${key})`, `${text}. Due today.`, closedAt === null ? E2E_NOW : closedAt - HOUR, closedAt === null ? { isRead: false, inInbox: true } : { inInbox: inbox })], { applyFilters: false, now: E2E_NOW, classifier: null });
  const m = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = ?", key)!;
  await store.dated.marks.queueScan([m.id], E2E_NOW);
  const due = new Date(E2E_NOW);
  due.setHours(13, 0, 0, 0);
  const day = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  await store.dated.finish({ messageId: m.id, threadId: m.thread_id, fromScan: true, rows: [{ kind: "pay", item: 0, text, quote: "Due today.", dueDay: day, dueAt: due.getTime(), timed: true, dated: true, actAt: E2E_NOW - 86_400_000 }], settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
  if (closedAt !== null) {
    const [row] = await store.dated.ofThread(m.thread_id);
    await store.dated.update(row!.id, row!.revision, { state: "done", closedReason: "user", closedAt });
  }
  return m.thread_id;
}

/** plan 210 (iteration 1): one conversation with several of the reader's items today: a kind, its words, its hour (or none) */
async function items(server: DevServerFixture, key: string, rows: { kind: "pay" | "event" | "delivery"; text: string; hour: number | null }[]) {
  const store = server.backend.store;
  const db = sqlDb(store);
  const text = rows.map((r) => `${r.text}.`).join(" ");
  await store.sync.ingest([message(server, key, { name: "Lumen", email: `${key}@lumen.test` }, `About ${key}`, text, E2E_NOW, { isRead: false, inInbox: true })], { applyFilters: false, now: E2E_NOW, classifier: null });
  const m = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = ?", key)!;
  await store.dated.marks.queueScan([m.id], E2E_NOW);
  const day0 = new Date(E2E_NOW);
  const day = `${day0.getFullYear()}-${String(day0.getMonth() + 1).padStart(2, "0")}-${String(day0.getDate()).padStart(2, "0")}`;
  const moment = (hour: number | null) => {
    const d = new Date(E2E_NOW);
    d.setHours(hour ?? 23, hour === null ? 59 : 0, 0, 0);
    return d.getTime();
  };
  await store.dated.finish({ messageId: m.id, threadId: m.thread_id, fromScan: true, rows: rows.map((r, i) => ({ kind: r.kind, item: i, text: r.text, quote: `${r.text}.`, dueDay: day, dueAt: moment(r.hour), timed: r.hour !== null, dated: true, actAt: E2E_NOW - 86_400_000 })), settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
  return m.thread_id;
}

const feed = (page: Page) => page.getByTestId("wm-feed");
const line = (page: Page, text: string) => feed(page).locator("[data-thread-id]").filter({ hasText: text });
const scroller = (page: Page) => feed(page).locator('[data-keep-scroll="list"]');
/** an open item (never its history line) */
const openLine = (page: Page, text: string) => feed(page).locator("[data-thread-id]:not([data-history])").filter({ hasText: text });

/** Down from the top until a line is drawn (the feed draws only what's near the view), pages coming in on the way. */
async function reach(page: Page, text: string): Promise<void> {
  await scroller(page).evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(100);
  for (let i = 0; i < 120 && !(await line(page, text).count()); i++) {
    await scroller(page).evaluate((el) => (el.scrollTop += el.clientHeight * 0.7));
    await page.waitForTimeout(80);
  }
  await expect(line(page, text)).toBeVisible();
}

/** Every row of the feed in order, scrolling from its top to its end; and the most rows ever drawn at once. */
async function walk(page: Page): Promise<{ rows: { kind: string; text: string }[]; mostDrawn: number }> {
  const seen = new Map<number, { kind: string; text: string }>();
  let mostDrawn = 0;
  let still = 0;
  await scroller(page).evaluate((el) => (el.scrollTop = 0));
  for (let i = 0; i < 300 && still < 3; i++) {
    const rows = await feed(page).locator("[data-index]").evaluateAll((els) =>
      els.map((e) => {
        const it = e.querySelector('[data-testid="wm-item"], [data-testid="wm-heading"]');
        const kind = !it ? "?" : it.getAttribute("data-testid") === "wm-heading" ? `#${it.getAttribute("data-kind")}` : it.hasAttribute("data-history") ? "history" : it.hasAttribute("data-thread-id") ? "open" : "auto";
        return { index: Number(e.getAttribute("data-index")), kind, text: it?.querySelector('[data-testid="wm-sentence"]')?.textContent ?? "" };
      }),
    );
    for (const r of rows) seen.set(r.index, { kind: r.kind, text: r.text });
    mostDrawn = Math.max(mostDrawn, await feed(page).locator("[data-thread-id]").count());
    const end = await scroller(page).evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
    still = end ? still + 1 : 0;
    await scroller(page).evaluate((el) => (el.scrollTop += el.clientHeight * 0.7));
    await page.waitForTimeout(end ? 300 : 60);
  }
  return { rows: [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r), mostDrawn };
}

test("the open part, the automated section and the history under Earlier, paged as it's scrolled; Done to the history and Undo back; a new item live; virtualized; axe", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
  await item(server, "payroll", "Wire payroll", null);
  // the history: closings an hour apart, the newest an hour ago (Bill 59), the oldest 60 hours ago (Bill 0)
  // every other one still in the Inbox: the Inbox's rows and the history's are the same conversations
  for (let i = 0; i < CLOSED; i++) await item(server, `bill-${i}`, `Pay bill ${i}`, E2E_NOW - (CLOSED - i) * HOUR, i % 2 === 0);
  // automated mail: the section between the open part and the history
  await server.backend.store.sync.ingest([message(server, "news-1", { name: "Weekly News", email: "news@weekly.test" }, "Weekly issue", "This week's issue.", E2E_NOW - HOUR, { isRead: false, inInbox: true, listId: "weekly-1" })], { applyFilters: false, now: E2E_NOW, classifier: null });
  sqlDb(server.backend.store).run("UPDATE threads SET person = 0 WHERE subject = 'Weekly issue'");
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(feed(page)).toBeVisible();
  await expect(page.getByTestId("list-title")).toHaveText("What matters");

  await scenario("the open part first, then the automated section, then Earlier, newest first, every line once, paged in as it's scrolled; only what's near the view is drawn", async () => {
    await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
    await expect(line(page, "Wire payroll")).not.toHaveAttribute("data-history");
    await axeBothModes(page, '[data-testid="wm-feed"]');
    const { rows, mostDrawn } = await walk(page);
    const kinds = rows.map((r) => r.kind);
    expect(kinds[0]).toBe("#today");
    expect(kinds.lastIndexOf("open")).toBeLessThan(kinds.indexOf("auto"));
    expect(kinds.indexOf("auto")).toBeLessThan(kinds.indexOf("#history"));
    const history = rows.filter((r) => r.kind === "history").map((r) => Number(/bill (\d+)/.exec(r.text)?.[1]));
    // all sixty, the second page's too, newest first, none twice
    expect(history).toEqual(Array.from({ length: CLOSED }, (_, i) => CLOSED - 1 - i));
    // virtualized: of the 40-odd open lines and 60 history lines, only those near the view were ever in the page
    expect(mostDrawn).toBeLessThan(40);
    await reach(page, "Pay bill 59");
    const newest = line(page, "Pay bill 59");
    await expect(newest).toHaveAttribute("data-history", "true");
    await expect(newest.getByTestId("wm-when")).toHaveText("Done today");
    // nothing to act on in a history line
    await expect(newest.getByTestId("wm-done")).toHaveCount(0);
    await axeBothModes(page, '[data-testid="wm-feed"]');
  });

  await scenario("Codex code review: back from the Inbox to a deep line, the history comes back whole, the Inbox's conversations too", async () => {
    await reach(page, "Pay bill 2.");
    await line(page, "Pay bill 2.").getByTestId("wm-item-open").click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("thread-list")).toBeVisible();
    await page.getByTestId("nav-today").click();
    await expect(line(page, "Pay bill 2.")).toHaveAttribute("data-open", "true", { timeout: 15_000 });
    const history = (await walk(page)).rows.filter((r) => r.kind === "history").map((r) => Number(/bill (\d+)/.exec(r.text)?.[1]));
    expect(history).toEqual(Array.from({ length: CLOSED }, (_, i) => CLOSED - 1 - i));
    await page.keyboard.press("Escape");
  });

  await scenario("Codex code review, round 2: scrolled deep with nothing open, the Inbox and back, the feed is where it was", async () => {
    await reach(page, "Pay bill 3.");
    // the line at the top of the view, past the history's first page
    await line(page, "Pay bill 3.").evaluate((el) => {
      const sc = el.closest('[data-keep-scroll="list"]')!;
      sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    });
    await page.waitForTimeout(300);
    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("thread-list")).toBeVisible();
    await page.getByTestId("nav-today").click();
    await expect(line(page, "Pay bill 3.")).toBeInViewport({ timeout: 15_000 });
  });

  await scenario("Done moves a line to the top of the history, quiet and saying so; Undo puts it back in the open part", async () => {
    await reach(page, "Wire payroll");
    await line(page, "Wire payroll").getByTestId("wm-item-open").click();
    await page.keyboard.press("d");
    await expect(page.getByTestId("snack")).toContainText("Done: Wire payroll");
    await page.keyboard.press("Escape");
    await reach(page, "Wire payroll");
    const done = line(page, "Wire payroll");
    await expect(done).toHaveAttribute("data-history", "true");
    await expect(done.getByTestId("wm-when")).toHaveText("Done today");
    // at the history's top: the line before it is the history's heading
    const above = await done.evaluate((el) => {
      const row = el.closest("[data-index]")!;
      const prev = [...row.parentElement!.children].find((c) => Number(c.getAttribute("data-index")) === Number(row.getAttribute("data-index")) - 1);
      return prev?.querySelector("[data-testid=wm-heading]")?.getAttribute("data-kind") ?? null;
    });
    expect(above).toBe("history");
    await page.keyboard.press("z");
    await reach(page, "Wire payroll");
    await expect(line(page, "Wire payroll")).not.toHaveAttribute("data-history");
    await expect(feed(page).locator("[data-history]").filter({ hasText: "Wire payroll" })).toHaveCount(0);
  });

  await scenario("Codex code review: the skip link brings the keys back to the item put away, scrolled out of view meanwhile", async () => {
    await reach(page, "Wire payroll");
    await openLine(page, "Wire payroll").getByTestId("wm-item-open").click();
    await page.keyboard.press("Escape");
    await reach(page, "Pay bill 0.");
    await expect(openLine(page, "Wire payroll")).toHaveCount(0);
    await page.getByTestId("skip-to-list").focus();
    await page.keyboard.press("Enter");
    const back = openLine(page, "Wire payroll").getByTestId("wm-item-open");
    await expect(back).toBeFocused();
    await expect(back).toBeInViewport();
  });

  await scenario("a new item arrives while the feed is on screen", async () => {
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await item(server, "rent", "Pay the rent", null);
    server.backend.today.changed();
    await expect(line(page, "Pay the rent")).toBeVisible({ timeout: 15_000 });
    await expect(line(page, "Pay the rent")).not.toHaveAttribute("data-history");
  });
});

test("an item: one sentence, when in its column, who under it; its conversation beside the feed, put away by Esc, the reader's Close or a second click; D and z; axe in light and dark", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
  await item(server, "payroll", "Wire payroll", null);
  await item(server, "rent", "Pay the rent", null);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  const it = line(page, "Wire payroll");
  const open = it.getByTestId("wm-item-open");

  await scenario("one plain sentence under its group; nothing opens by itself, so the feed has the reader's room", async () => {
    await expect(it).toContainText("Wire payroll.", { timeout: 15_000 });
    // after the UI panel: when in a column of its own, the list's words, the accent for today; who under the sentence,
    // never the email's date
    await expect(it.getByTestId("wm-when")).toHaveText(/^1:00\sPM$/);
    await expect(it).toHaveAttribute("data-tone", "today");
    await expect(it.getByTestId("wm-meta")).toHaveText("Billing");
    // Done and Later in words, out of sight (and out of the pointer's way) until the item is hovered, focused or open
    const controls = it.getByTestId("wm-controls");
    await expect(controls).toHaveCSS("opacity", "0");
    await it.hover();
    await expect(controls).toHaveCSS("opacity", "1");
    await expect(it.getByTestId("wm-done")).toHaveAccessibleName("Done");
    await expect(it.getByTestId("wm-done")).toHaveAccessibleDescription("Wire payroll.");
    await expect(it.getByTestId("wm-later")).toHaveAccessibleName("Later");
    await page.mouse.move(0, 0);
    await expect(feed(page).getByTestId("wm-heading").first()).toBeVisible();
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await axeBothModes(page, '[data-testid="wm-feed"]');
  });

  await scenario("its conversation opens beside the feed, and Esc puts it away, the keys back on the item", async () => {
    await open.click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(page.locator("#reader-subject")).toHaveText("Wire payroll (payroll)");
    await expect(it).toHaveAttribute("data-open");
    await expect(feed(page)).toBeVisible();
    await expect(it.getByTestId("wm-controls")).toHaveCSS("opacity", "1");
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await expect(it).not.toHaveAttribute("data-open");
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await expect(open).toBeFocused();
  });

  await scenario("the reader's Close (after Forward) and a click on the open item put it away too; only beside the feed", async () => {
    await open.click();
    const close = page.getByTestId("reader-close");
    await expect(close).toHaveAccessibleName("Close email");
    await axeBothModes(page, "[data-reader-toolbar]");
    // the toolbar's last control, after Reply and Forward, on their line
    const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
    const [forward, x] = [await box("action-forward"), await close.boundingBox()];
    expect(x!.x).toBeGreaterThan(forward.x + forward.width);
    expect(Math.abs(x!.y + x!.height / 2 - (forward.y + forward.height / 2))).toBeLessThanOrEqual(1);
    await close.click();
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(open).toHaveAttribute("aria-expanded", "false");
    // the place is kept: j/k go on from the item it was opened from
    await expect(it).toHaveAttribute("data-cursor");
    const at = await feed(page).locator("[data-thread-id]").evaluateAll((els, id) => els.findIndex((e) => e.getAttribute("data-thread-id") === id), await it.getAttribute("data-thread-id"));
    await page.keyboard.press(at > 0 ? "k" : "j");
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(feed(page).locator("[data-thread-id]").nth(at > 0 ? at - 1 : at + 1)).toHaveAttribute("data-open");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("reader")).toHaveCount(0);
    // the same item again: open, then closed by a second click
    await open.click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await open.click();
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await expect(it).not.toHaveAttribute("data-open");
    // the Inbox's reader has no Close
    await page.getByTestId("nav-inbox").click();
    await page.getByTestId("thread-row").first().click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(page.getByTestId("reader-close")).toHaveCount(0);
    await page.getByTestId("nav-today").click();
    await expect(feed(page)).toBeVisible();
  });

  await scenario("D on the open item is its Done, and z brings it back", async () => {
    if (await page.getByTestId("reader").count()) await page.keyboard.press("Escape");
    await open.click();
    await expect(it).toHaveAttribute("data-open");
    await page.keyboard.press("d");
    await expect(page.getByTestId("snack")).toContainText("Done: Wire payroll");
    await expect(feed(page).locator("[data-thread-id]:not([data-history])").filter({ hasText: "Wire payroll" })).toHaveCount(0);
    await page.keyboard.press("z");
    await expect(feed(page).locator("[data-thread-id]:not([data-history])").filter({ hasText: "Wire payroll" })).toBeVisible();
    await expect(page.locator("[data-testid=snack-dock][data-undoing]")).toHaveCount(0);
  });

  await scenario("Codex code review: the wide feed is the page's main landmark; D finishes the item the keyboard is on; j takes the keys with the item it opens", async () => {
    if (await page.getByTestId("reader").count()) await page.keyboard.press("Escape");
    await expect(page.getByTestId("reader")).toHaveCount(0);
    // the feed alone: its pane is the page's main content (as List's one pane is)
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("main").getByTestId("wm-feed")).toHaveCount(1);
    await openLine(page, "Wire payroll").getByTestId("wm-item-open").click();
    // the reader beside it is the main content then, alone
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("main").getByTestId("wm-feed")).toHaveCount(0);
    // the keyboard on the other item: D is that one's, the open one stays
    await openLine(page, "Pay the rent").getByTestId("wm-item-open").focus();
    await page.keyboard.press("d");
    await expect(page.getByTestId("snack")).toContainText("Done: Pay the rent");
    await expect(openLine(page, "Wire payroll")).toHaveAttribute("data-open", "true");
    // round 2: the keys go on to another item, never nowhere (a second D would have been the open one's)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("wm-item-open");
    await page.keyboard.press("z");
    await expect(openLine(page, "Pay the rent")).toBeVisible();
    // the Undo landed whole (the row back is only its first part; what it puts back follows), before the next keys
    await expect(page.locator("[data-testid=snack-dock][data-undoing]")).toHaveCount(0);
    // j opens the next item and the keys go with it: Enter and D are that one's
    await page.keyboard.press("Escape");
    await openLine(page, "Wire payroll").getByTestId("wm-item-open").focus();
    await page.keyboard.press("k");
    await page.keyboard.press("j");
    // (the focused element's item is the open one)
    await expect.poll(() => page.evaluate(() => { const item = document.activeElement?.closest("[data-testid=wm-item]"); return !!item?.hasAttribute("data-open") && document.activeElement?.getAttribute("data-testid"); })).toBe("wm-item-open");
    await page.keyboard.press("Escape");
  });

  await scenario("Codex code review: Tab to an item, Enter opens it, Esc puts it away: back on the item with no ring (plan 54)", async () => {
    const button = openLine(page, "Wire payroll").getByTestId("wm-item-open");
    await button.focus();
    // the ring on, as a Tab leaves it (focus-ring.spec's way)
    await button.focus();
    await page.evaluate(() => document.documentElement.toggleAttribute("data-focus-ring", true));
    await expect(button).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-focus-ring"))).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("reader")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-focus-ring"))).toBe(false);
  });

  await scenario("Codex code review: / from What matters searches, in the list's field, everywhere", async () => {
    await openLine(page, "Wire payroll").getByTestId("wm-item-open").focus();
    await page.keyboard.press("/");
    await expect(page.getByTestId("search-input")).toBeFocused();
    await page.keyboard.type("Wire payroll");
    await expect(page.getByTestId("thread-row").filter({ hasText: "Wire payroll" }).first()).toBeVisible({ timeout: 15_000 });
  });
});

test("the owner's inbox-zero setting: the gear on What matters' title row hides the finished items and shows them again; Settings has the same switch, and More settings opens it", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
  await item(server, "payroll", "Wire payroll", null);
  await item(server, "closed-1", "Pay the old bill", E2E_NOW - HOUR);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
  const earlier = feed(page).locator('[data-testid="wm-heading"][data-kind="history"]');
  const gear = page.getByTestId("wm-options");
  const toggle = page.getByTestId("wm-options-finished");

  await scenario("the gear: on the title's row, named; its switch hides the history at once, and shows it again", async () => {
    await expect(gear).toHaveAccessibleName("What matters options");
    const mid = async (id: string) => page.getByTestId(id).evaluate((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
    expect(Math.abs((await mid("wm-options")) - (await mid("list-title")))).toBeLessThanOrEqual(2);
    await reach(page, "Pay the old bill");
    await gear.click();
    await expect(page.getByTestId("wm-options-panel")).toBeVisible();
    await expect(toggle).toHaveAccessibleName("Show finished items");
    // plan 210 (iteration 1): who reads the mail for it, where its options are
    await expect(page.getByTestId("wm-options-privacy")).toHaveText(/^To find bills, trips and requests, Terno reads each new message with .+ on this Mac; nothing leaves your Mac for them\.$/);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await axeBothModes(page, '[data-testid="wm-options-panel"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(earlier).toHaveCount(0);
    await expect(feed(page).locator("[data-history]")).toHaveCount(0);
    await expect.poll(async () => ((await server.backend.server.invoke("app.bootstrap", {}, dev)) as { settings: { today: { finished?: boolean } } }).settings.today.finished).toBe(false);
    // Done still takes a line off the top, with its Undo
    await page.keyboard.press("Escape");
    await reach(page, "Wire payroll");
    await line(page, "Wire payroll").getByTestId("wm-item-open").click();
    await page.keyboard.press("d");
    await expect(line(page, "Wire payroll")).toHaveCount(0);
    await expect(page.getByTestId("snack")).toContainText("Done: Wire payroll");
    await page.keyboard.press("z");
    await expect(line(page, "Wire payroll")).toBeVisible();
    await page.keyboard.press("Escape");
    // shown again: the history comes back
    await gear.click();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await reach(page, "Pay the old bill");
    await expect(line(page, "Pay the old bill")).toHaveAttribute("data-history", "true");
  });

  await scenario("Codex code review: with the options open, the mail's keys don't reach the mail behind them", async () => {
    await reach(page, "Wire payroll");
    await line(page, "Wire payroll").getByTestId("wm-item-open").click();
    await expect(line(page, "Wire payroll")).toHaveAttribute("data-open");
    await gear.click();
    await toggle.focus();
    for (const key of ["d", "j", "k", "e"]) await page.keyboard.press(key);
    await expect(line(page, "Wire payroll")).toHaveAttribute("data-open");
    await expect(page.getByTestId("snack")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("wm-options-panel")).toHaveCount(0);
    await expect(line(page, "Wire payroll")).toHaveAttribute("data-open");
    await page.keyboard.press("Escape");
  });

  await scenario("More settings opens Settings at the same switch, which changes it too", async () => {
    await gear.click();
    await page.getByTestId("wm-options-more").click();
    const row = page.getByTestId("today-finished");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("today-privacy")).toContainText("To find bills, trips and requests, Terno reads each new message with");
    await expect(row).toBeInViewport();
    await expect(row).toHaveAttribute("aria-checked", "true");
    await row.click();
    await expect(row).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(earlier).toHaveCount(0);
    await gear.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});


test("plan 210 (iteration 1): inside a day, tasks before plans; iteration 2: a conversation with both is two rows; the item's keys in its tooltips", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
  // a breakfast at 9:00 and a parcel today, then the payroll at 1:00 PM; one conversation with a dinner at 8:00 and a deposit
  await items(server, "breakfast", [{ kind: "event", text: "Team breakfast", hour: 9 }]);
  await items(server, "parcel", [{ kind: "delivery", text: "Your parcel arrives", hour: null }]);
  await item(server, "payroll", "Wire payroll", null);
  await items(server, "mixed", [
    { kind: "event", text: "Dinner at Lumen", hour: 8 },
    { kind: "pay", text: "Pay the deposit", hour: null },
  ]);
  // written behind the reader's back: What matters reads its items again
  server.backend.today.changed();
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });

  await scenario("the deposit (a task), then the parcel (a plan, quieter), then the dinner, the breakfast and the payroll by their time; the deposit's conversation is two rows, its dinner its own", async () => {
    const order = (await walk(page)).rows.filter((r) => r.kind === "open").map((r) => r.text);
    const today = order.filter((t) => /payroll|deposit|breakfast|parcel|Dinner/.test(t));
    // (iteration 4, revision 8: Today's whole-day rows first, tasks before plans; then the timed by their time whatever their kind)
    expect(today).toEqual(["Pay the deposit.", "Your parcel arrives.", "Dinner at Lumen.", "Team breakfast.", "Wire payroll."]);
    await reach(page, "Pay the deposit");
    const deposit = openLine(page, "Pay the deposit");
    await expect(deposit.getByTestId("wm-meta")).not.toContainText("Dinner at Lumen");
    await expect(deposit).toHaveAttribute("data-tone", "today");
    const conversation = (await deposit.getAttribute("data-thread-id"))!;
    await reach(page, "Dinner at Lumen");
    await expect(openLine(page, "Dinner at Lumen")).toHaveAttribute("data-thread-id", conversation);
    await reach(page, "Team breakfast");
    await expect(openLine(page, "Team breakfast")).toHaveAttribute("data-tone", "later");
    await reach(page, "Pay the deposit");
    // D on it is the deposit's
    await deposit.getByTestId("wm-item-open").focus();
    await page.keyboard.press("d");
    await expect(page.getByTestId("snack")).toContainText("Done: Pay the deposit");
    await page.keyboard.press("z");
    await expect(openLine(page, "Pay the deposit")).toBeVisible();
  });

  await scenario("the second line (who, and the conversation's next item) ends before Done and Later, never under them: wide, beside the open email, in Spanish", async () => {
    const clear = async () => {
      const deposit = openLine(page, "Pay the deposit");
      // where its words end: the content box (an ellipsis ends it there)
      const meta = await deposit.getByTestId("wm-meta").evaluate((el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight));
      const controls = (await deposit.getByTestId("wm-done").boundingBox())!;
      expect(meta).toBeLessThanOrEqual(controls.x);
    };
    for (const language of ["en", "es"] as const) {
      await server.backend.server.invoke("settings.update", { language }, dev);
      await fresh(page);
      await page.getByTestId("nav-today").click();
      await expect(page.getByTestId("list-title")).toHaveText(language === "en" ? "What matters" : "Lo importante");
      await reach(page, "Pay the deposit");
      await openLine(page, "Pay the deposit").hover();
      await clear();
      // (Codex code review) its Later menu open, the pointer on it: still clear
      await openLine(page, "Pay the deposit").getByTestId("wm-later").click();
      await page.getByTestId("wm-later-menu").hover();
      await clear();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("wm-later-menu")).toHaveCount(0);
      await openLine(page, "Pay the deposit").getByTestId("wm-item-open").click();
      await expect(page.getByTestId("reader")).toBeVisible();
      await clear();
      await page.keyboard.press("Escape");
      await page.mouse.move(0, 0);
    }
    await server.backend.server.invoke("settings.update", { language: "en" }, dev);
    await fresh(page);
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("list-title")).toHaveText("What matters");
  });

  await scenario("Codex code review: the palette's Later opens the item's Later menu, which stays open once the palette has gone", async () => {
    await reach(page, "Wire payroll");
    await openLine(page, "Wire payroll").getByTestId("wm-item-open").click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-dated-later").click();
    const menu = page.getByTestId("wm-later-menu");
    await expect(menu).toBeVisible();
    await page.waitForTimeout(400);
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(openLine(page, "Wire payroll")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  await scenario("Done's and Later's tooltips say their keys", async () => {
    await reach(page, "Wire payroll");
    const it = openLine(page, "Wire payroll");
    await it.hover();
    await expect(it.getByTestId("wm-done")).toHaveAttribute("aria-keyshortcuts", "d");
    await expect(it.getByTestId("wm-later")).toHaveAttribute("aria-keyshortcuts", "b");
    await it.getByTestId("wm-later").hover();
    await expect(page.locator("[data-slot=tooltip-content]")).toContainText("Later");
    await expect(page.locator("[data-slot=tooltip-content]")).toContainText("B");
    await page.mouse.move(0, 0);
  });
});

/** plan 210 (iteration 3): any dated item on a conversation of its own, by its day from today and its kind */
async function dated(server: DevServerFixture, key: string, from: string, row: { kind: "pay" | "respond" | "ask" | "event"; text: string; days: number; hour?: number; early?: boolean }) {
  const store = server.backend.store;
  const db = sqlDb(store);
  const arrived = E2E_NOW - HOUR;
  await store.sync.ingest([message(server, key, { name: from, email: `${key}@people.test` }, `About ${key}`, `${row.text}.`, arrived, { isRead: false, inInbox: true })], { applyFilters: false, now: E2E_NOW, classifier: null });
  const m = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = ?", key)!;
  await store.dated.marks.queueScan([m.id], E2E_NOW);
  const at = new Date(E2E_NOW);
  at.setDate(at.getDate() + row.days);
  at.setHours(row.hour ?? 9, 0, 0, 0);
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  const ask = row.kind === "ask";
  const act = row.days > 7 ? at.getTime() - 7 * 86_400_000 : arrived;
  await store.dated.finish({ messageId: m.id, threadId: m.thread_id, fromScan: true, rows: [{ kind: row.kind, item: 0, text: row.text, quote: `${row.text}.`, dueDay: day, dueAt: ask ? arrived : at.getTime(), timed: row.hour !== undefined, dated: !ask, actAt: act, ...(row.early ? { early: true } : {}) }], settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
}

test("plan 210 (iteration 3): the header says missed, today and waiting; Waiting on you is Today's quiet part; Coming up is a disclosure, by day then by week", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
  await dated(server, "water", "City Water", { kind: "pay", text: "Pay the water bill", days: -2 });
  await item(server, "payroll", "Wire payroll", null);
  await dated(server, "rfp", "Owen Hale", { kind: "respond", text: "Send Owen the RFP response", days: 3, hour: 17, early: true });
  await dated(server, "bio", "Inés Ruiz", { kind: "respond", text: "Send Inés your bio", days: 1, hour: 12, early: true });
  await dated(server, "quote", "Mariana Paz", { kind: "ask", text: "Answer Mariana about the rebranding quote", days: 0 });
  await dated(server, "keynote", "Shipfast", { kind: "event", text: "Shipfast Summit keynote", days: 5, hour: 19 });
  await dated(server, "dues", "Rowing Club", { kind: "pay", text: "Pay the club dues", days: 10 });
  await dated(server, "passport", "Passport Office", { kind: "pay", text: "Pay the passport renewal fee", days: 40 });
  await dated(server, "insurance", "Lakeshore Mutual", { kind: "pay", text: "Pay the home insurance premium", days: 75 });
  server.backend.today.changed();
  await fresh(page);
  await page.evaluate(() => localStorage.removeItem("terno.today.comingUp"));
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });

  await scenario("the header's three numbers, disjoint; the badge their sum", async () => {
    // (the demo mailbox's own conversations waiting on you are among the waiting)
    await expect(page.getByTestId("today-needs")).toHaveText(/^1 missed · 1 to do today · \d+ waiting$/);
    const waiting = Number(/(\d+) waiting/.exec(await page.getByTestId("today-needs").innerText())![1]);
    expect(waiting).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("nav-today")).toContainText(String(2 + waiting));
  });

  await scenario("Waiting on you under Today's own: the dated by their day, soonest first, keeping their time; then the asks", async () => {
    const { rows } = await walk(page);
    // these rows and the headings (the demo's own waiting conversations aside: they came before Mariana's ask, newest first)
    const ours = /^(Pay the water bill|Wire payroll|Send Inés your bio|Send Owen the RFP response|Answer Mariana about the rebranding quote|Shipfast Summit keynote)\.$/;
    const order = rows.filter((r) => r.kind.startsWith("#") || (r.kind === "open" && ours.test(r.text))).map((r) => (r.kind === "open" ? r.text : r.kind));
    expect(order.slice(0, 10)).toEqual(["#missed", "Pay the water bill.", "#today", "Wire payroll.", "#waiting", "Send Inés your bio.", "Send Owen the RFP response.", "Answer Mariana about the rebranding quote.", "#day", "Shipfast Summit keynote."]);
    await reach(page, "Send Owen the RFP response");
    await expect(openLine(page, "Send Owen the RFP response").getByTestId("wm-when")).toHaveText(/^by \w{3} 5:00\sPM$/);
    await expect(openLine(page, "Send Inés your bio").getByTestId("wm-when")).toHaveText(/^by tomorrow 12:00\sPM$/);
    await expect(openLine(page, "Send Owen the RFP response")).toHaveAttribute("data-tone", "none");
    // the keynote five days out is under its day (the seven days whole); Coming up holds the rest, closed
    await reach(page, "Shipfast Summit keynote");
    await expect(line(page, "Pay the club dues")).toHaveCount(0);
  });

  await scenario("Coming up is the feed's last heading, a disclosure: its rows in buckets of their own, by day then past two weeks by week; the same words open or shut", async () => {
    // (iteration 4, revision 9) never in the header
    await expect(page.getByTestId("today-line")).not.toContainText(/coming up/i);
    const toggle = page.getByTestId("wm-coming-up");
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(toggle).toHaveText("Coming up · 3");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveText("Coming up · 3");
    const { rows } = await walk(page);
    const order = rows.filter((r) => r.kind === "open" || r.kind.startsWith("#")).map((r) => (r.kind === "open" ? r.text : r.kind));
    // after every day of the open part: Coming up's heading, then its buckets (the demo's own Coming up, if any, in them too)
    const ours = /^Pay the (club dues|passport renewal fee|home insurance premium)\.$/;
    const from = order.indexOf("#comingUp");
    expect(from).toBeGreaterThan(order.indexOf("Shipfast Summit keynote."));
    expect(order.slice(from + 1).filter((t) => ours.test(t))).toEqual(["Pay the club dues.", "Pay the passport renewal fee.", "Pay the home insurance premium."]);
    // each of ours under a bucket heading of Coming up's, never a day of the open part
    for (const text of ["Pay the club dues.", "Pay the passport renewal fee.", "Pay the home insurance premium."]) {
      const at = order.indexOf(text);
      expect(order.slice(from, at).filter((t) => t.startsWith("#")).at(-1)).toBe("#coming");
    }
    await reach(page, "Pay the home insurance premium");
    await expect(feed(page).locator('[data-testid="wm-heading"][data-kind="coming"]').last()).toHaveText(/^Week of \w{3} \d{1,2}(, \d{4})?$/);
    await axeBothModes(page, '[data-testid="wm-feed"]');
  });

  const shots = process.env.WM_IT3_SHOTS;
  if (shots) {
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await scroller(page).evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/${test.info().project.name}-top-${mode}.png` });
      await reach(page, "Shipfast Summit keynote");
      // the keynote's day at the top: Coming up's days and weeks under it
      await line(page, "Shipfast Summit keynote").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/${test.info().project.name}-coming-up-${mode}.png` });
    }
    await page.emulateMedia({ colorScheme: "light" });
  }
});

/** plan 210 (iteration 4): a promise of yours to `who`, on a conversation of its own, its day `days` from today; broken: the day it had first, missed */
async function promised(server: DevServerFixture, key: string, who: { name: string; email: string }, text: string, o: { days: number; brokenDays?: number }) {
  const store = server.backend.store;
  const db = sqlDb(store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  // (since follow-ups went on: an older send is never read without a yes)
  const sentAt = E2E_NOW - 60_000;
  await store.sync.ingest([message(server, key, { name: "Me", email: acct.email }, `About ${key}`, `I'll ${text}.`, sentAt, { isSent: true, to: [who] })], { applyFilters: false, now: E2E_NOW, classifier: null, liveSent: { wanted: true } });
  const m = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = ?", key)!;
  const day = (n: number) => {
    const d = new Date(E2E_NOW);
    d.setDate(d.getDate() + n);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  await store.followups.finish({ messageId: m.id, threadId: m.thread_id, fromScan: false, rows: [{ kind: "promise", item: 0, text, quote: `I'll ${text}`, personName: who.name, personEmail: who.email, dueAt: day(o.days), dated: true }], kept: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
  if (o.brokenDays !== undefined) db.run("UPDATE followups SET broken_due_at = ? WHERE thread_id = ?", day(o.brokenDays), m.thread_id);
  return m.thread_id;
}

test("plan 210 (iteration 4): 'to do today'; a broken promise first in Waiting on you; Coming up the last heading, out of j/k while closed; the sentence keeps its width beside the reader; the palette with nothing selected; the menu's More", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true }, followups: { enabled: true } }, dev);
  await dated(server, "water", "City Water", { kind: "pay", text: "Pay the water bill", days: -2 });
  await item(server, "payroll", "Wire payroll", null);
  await dated(server, "rfp", "Owen Hale", { kind: "respond", text: "Send Owen the RFP response", days: 3, hour: 17, early: true });
  await dated(server, "yearend", "Gary Lee", { kind: "respond", text: "Send Gary the year-end numbers", days: 20, early: true });
  await dated(server, "quote", "Mariana Paz", { kind: "ask", text: "Answer Mariana about the rebranding quote", days: 0 });
  await dated(server, "keynote", "Shipfast", { kind: "event", text: "Shipfast Summit keynote", days: 5, hour: 19 });
  await dated(server, "dues", "Rowing Club", { kind: "pay", text: "Pay the club dues", days: 10 });
  await dated(server, "passport", "Passport Office", { kind: "pay", text: "Pay the passport renewal fee", days: 40 });
  await promised(server, "script", { name: "Jess Okafor", email: "jess@railyard.test" }, "send Jess the full Railyard integration script for brand and legal review", { days: 3, brokenDays: -2 });
  server.backend.today.changed();
  await page.evaluate(() => localStorage.removeItem("terno.today.comingUp"));
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
  const script = "You said you'd send Jess the full Railyard integration script for brand and legal review.";

  await scenario("the header says what it counts: to do today, apart from what's waiting; the badge their sum", async () => {
    await expect(page.getByTestId("today-needs")).toHaveText(/^1 missed · 1 to do today · \d+ waiting$/);
    const waiting = Number(/(\d+) waiting/.exec(await page.getByTestId("today-needs").innerText())![1]);
    await expect(page.getByTestId("nav-today")).toContainText(String(2 + waiting));
  });

  await scenario("Waiting on you: the broken promise first, in Missed's weight; then this week's requests; the asks; a request due later last", async () => {
    const { rows } = await walk(page);
    const from = rows.findIndex((r) => r.kind === "#waiting");
    const to = rows.findIndex((r, i) => i > from && r.kind.startsWith("#"));
    const waiting = rows.slice(from + 1, to).filter((r) => r.kind === "open").map((r) => r.text);
    expect(waiting[0]).toBe(script);
    const ours = waiting.filter((t) => /^(You said you'd send Jess|Send Owen the RFP response|Answer Mariana|Send Gary the year-end numbers)/.test(t));
    expect(ours).toEqual([script, "Send Owen the RFP response.", "Answer Mariana about the rebranding quote.", "Send Gary the year-end numbers."]);
    expect(waiting.at(-1)).toBe("Send Gary the year-end numbers.");
    await reach(page, "send Jess the full");
    const row = openLine(page, "send Jess the full");
    await expect(row).toHaveAttribute("data-tone", "missed");
    await expect(row.getByTestId("wm-when")).toHaveText(/^You said \w{3} \d{1,2} \(missed\) ·\sneeded \w{3}$/);
  });

  await scenario("the sentence keeps two thirds of the row; beside the reader the when column goes under it", async () => {
    await reach(page, "send Jess the full");
    const row = openLine(page, "send Jess the full");
    const box = async (id: string) => row.getByTestId(id).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    const whole = async () => row.getByTestId("wm-item-open").evaluate((el) => el.getBoundingClientRect().width - 24);
    expect((await box("wm-sentence")).width).toBeGreaterThanOrEqual((await whole()) * 0.66);
    expect((await box("wm-when")).top).toBeLessThan((await box("wm-sentence")).bottom);
    await row.getByTestId("wm-item-open").click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(row).toHaveAttribute("data-open", "true");
    // narrow: under the sentence, above who, the sentence the row's whole width
    await expect.poll(async () => (await box("wm-when")).top >= (await box("wm-sentence")).bottom - 1).toBe(true);
    expect((await box("wm-meta")).top).toBeGreaterThanOrEqual((await box("wm-when")).bottom - 1);
    expect((await box("wm-sentence")).width).toBeGreaterThanOrEqual((await whole()) * 0.9);
    await expect(row.getByTestId("wm-sentence")).toContainText("You said you'd send Jess the full");
  });

  await scenario("the menu: What matters' own and Reply; the mail's under More", async () => {
    await openLine(page, "send Jess the full").click({ button: "right" });
    await expect(page.getByTestId("menu-dated-done")).toBeVisible();
    await expect(page.getByTestId("menu-reply")).toBeVisible();
    await expect(page.getByTestId("menu-archive")).toHaveCount(0);
    await expect(page.getByTestId("menu-trash")).toHaveCount(0);
    await page.getByTestId("menu-more").hover();
    await expect(page.getByTestId("menu-more-list").getByTestId("menu-trash")).toBeVisible();
    await expect(page.getByTestId("menu-more-list").getByTestId("menu-archive")).toBeVisible();
    await page.keyboard.press("Escape");
    if (await page.getByTestId("menu-dated-done").isVisible()) await page.keyboard.press("Escape");
  });

  await scenario("with nothing selected, the palette lists Done, Later and Remove, unavailable, and says why", async () => {
    // a second click puts the conversation away: nothing selected
    if (await page.getByTestId("reader").count()) await feed(page).locator("[data-open] [data-testid=wm-item-open]").first().click();
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    for (const id of ["palette-dated-done", "palette-dated-later", "palette-dated-dismiss"]) {
      const it = page.getByTestId(id);
      await expect(it).toBeVisible();
      await expect(it).toHaveAttribute("aria-disabled", "true");
      await expect(it).toContainText("Select an item first");
    }
    await page.keyboard.press("Escape");
  });

  await scenario("Coming up is the feed's last heading; open, j walks its rows; closed on one of them, the feed is on the row above it and j never reaches them", async () => {
    await expect(page.getByTestId("today-line")).not.toContainText(/coming up/i);
    const toggle = page.getByTestId("wm-coming-up");
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(toggle).toHaveText("Coming up · 2");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await reach(page, "Pay the club dues");
    await openLine(page, "Pay the club dues").getByTestId("wm-item-open").click();
    await expect(openLine(page, "Pay the club dues")).toHaveAttribute("data-open", "true");
    await page.keyboard.press("j");
    await expect(openLine(page, "Pay the passport renewal fee")).toHaveAttribute("data-open", "true");
    // closed on it: the reader put away, the feed on the last row above Coming up
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await expect(line(page, "Pay the passport renewal fee")).toHaveCount(0);
    const cursor = feed(page).locator("[data-testid=wm-item][data-cursor]");
    await expect.poll(async () => (await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight)), await cursor.count())).toBe(1);
    await expect(cursor).not.toHaveAttribute("data-ahead", "true");
    // j from the keynote never opens one of Coming up's rows
    await reach(page, "Shipfast Summit keynote");
    await openLine(page, "Shipfast Summit keynote").getByTestId("wm-item-open").click();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("j");
      await expect(feed(page).locator("[data-testid=wm-item][data-open][data-ahead]")).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
  });

  const shots = process.env.WM_IT4_SHOTS;
  if (shots) {
    for (const language of ["en", "es"] as const) {
      await server.backend.server.invoke("settings.update", { language }, dev);
      await fresh(page);
      await page.getByTestId("nav-today").click();
      await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
      for (const width of [1440, 1100]) {
        await page.setViewportSize({ width, height: 900 });
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          const name = (what: string) => `${shots}/${what}-${language}-${width}-${mode}.png`;
          if (await page.getByTestId("reader").count()) await feed(page).locator("[data-open] [data-testid=wm-item-open]").first().click();
          await expect(page.getByTestId("reader")).toHaveCount(0);
          const toggle = page.getByTestId("wm-coming-up");
          // (the feed draws what's near its view: down to its end until the disclosure is drawn)
          const toEnd = async () => {
            for (let i = 0; i < 30 && !(await toggle.isVisible()); i++) {
              await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
              await page.waitForTimeout(100);
            }
          };
          await toEnd();
          if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
          await scroller(page).evaluate((el) => (el.scrollTop = 0));
          await page.waitForTimeout(300);
          await page.screenshot({ path: name("feed-top") });
          await toEnd();
          await page.waitForTimeout(300);
          await page.screenshot({ path: name("coming-up-closed") });
          await toggle.click();
          await page.waitForTimeout(300);
          await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
          await page.waitForTimeout(300);
          await page.screenshot({ path: name("coming-up-open") });
          await toEnd();
          await toggle.click();
          await reach(page, "Railyard");
          await openLine(page, "Railyard").getByTestId("wm-item-open").click();
          await page.waitForTimeout(400);
          await page.screenshot({ path: name("reader-long-row") });
          await openLine(page, "Railyard").click({ button: "right" });
          await page.waitForTimeout(200);
          await page.screenshot({ path: name("menu") });
          await page.getByTestId("menu-more").hover();
          await page.waitForTimeout(300);
          await page.screenshot({ path: name("menu-more") });
          await page.keyboard.press("Escape");
          if (await page.getByTestId("menu-dated-done").isVisible()) await page.keyboard.press("Escape");
        }
      }
    }
    await server.backend.server.invoke("settings.update", { language: "en" }, dev);
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

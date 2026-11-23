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
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
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
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
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
    // under the pointer, Done and Later; at rest, none (plan 214, after the second rating: the reader beside it has them,
    // and who and when stay whole)
    await it.hover();
    await expect(it.getByTestId("wm-controls")).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await expect(it.getByTestId("wm-controls")).toHaveCSS("opacity", "0");
    // and its second line keeps no room for them: who isn't cut short (the open button's aria-expanded isn't Later's)
    await expect(it.getByTestId("wm-meta").locator("..")).toHaveCSS("padding-right", "0px");
    await expect(page.getByTestId("thread-dated-done")).toBeVisible();
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

  await scenario("plan 236: the feed beside the reader keeps a width of its own, apart from the Inbox's list, named for it; both after a reload", async () => {
    const width = async () => Math.round((await page.locator("#app-list").boundingBox())!.width);
    const handle = page.getByTestId("pane-handle-list");
    const inboxOpen = async () => {
      await page.getByTestId("nav-inbox").click();
      await page.getByTestId("thread-row").first().click();
      await expect(page.getByTestId("reader")).toBeVisible();
    };
    // the feed's conversation put away before leaving it: coming back, nothing is open and a click opens it
    const feedOpen = async () => {
      await page.getByTestId("nav-today").click();
      await open.click();
      await expect(page.getByTestId("reader")).toBeVisible();
    };
    const feedClose = async () => {
      await page.getByTestId("reader-close").click();
      await expect(page.getByTestId("reader")).toHaveCount(0);
    };
    await inboxOpen();
    const inbox = await width();
    await expect(handle).toHaveAccessibleName("Resize message list");
    // never resized, the feed starts at the design's width, the list's
    await feedOpen();
    expect(await width()).toBe(inbox);
    await expect(handle).toHaveAccessibleName("Resize “What matters”");
    await handle.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(width).toBe(inbox + 64);
    await expect(handle).toHaveAttribute("aria-valuenow", String(inbox + 64));
    await feedClose();
    // the Inbox's list didn't follow; narrowed, the feed doesn't follow it
    await inboxOpen();
    expect(await width()).toBe(inbox);
    await expect(handle).toHaveAttribute("aria-valuenow", String(inbox));
    await handle.focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(width).toBe(inbox - 64);
    await feedOpen();
    expect(await width()).toBe(inbox + 64);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("terno:panes")))!)).toMatchObject({ list: inbox - 64, feed: inbox + 64 });
    // each after a reload: the view it comes back on, at its own width, then the other
    await page.reload();
    await expect(page.getByTestId("reader")).toBeVisible();
    const onFeed = await feed(page).isVisible();
    expect(await width()).toBe(onFeed ? inbox + 64 : inbox - 64);
    if (onFeed) await feedClose();
    await feedOpen();
    expect(await width()).toBe(inbox + 64);
    await feedClose();
    await inboxOpen();
    expect(await width()).toBe(inbox - 64);
    // Enter resets the one showing: the Inbox's, then the feed's
    await handle.focus();
    await page.keyboard.press("Enter");
    await expect.poll(width).toBe(inbox);
    await feedOpen();
    expect(await width()).toBe(inbox + 64);
    await handle.focus();
    await page.keyboard.press("Enter");
    await expect.poll(width).toBe(inbox);
    expect(await page.evaluate(() => localStorage.getItem("terno:panes"))).toBeNull();
    await feedClose();
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
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
  await item(server, "payroll", "Wire payroll", null);
  await item(server, "closed-1", "Pay the old bill", E2E_NOW - HOUR);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
  const earlier = feed(page).locator('[data-testid="wm-heading"][data-kind="history"]');
  const gear = page.getByTestId("wm-options");
  const toggle = page.getByTestId("wm-options-finished");

  await scenario("the gear: on the title's row, named; its switch hides the history at once, and shows it again", async () => {
    await expect(gear).toHaveAccessibleName("“What matters” options");
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
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
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

  await scenario("what you do first, by its time (the payroll) then the untimed (the deposit); then what happens, by its time (the dinner, the breakfast) then the untimed (the parcel); the deposit's conversation is two rows, its dinner its own", async () => {
    const order = (await walk(page)).rows.filter((r) => r.kind === "open").map((r) => r.text);
    const today = order.filter((t) => /payroll|deposit|breakfast|parcel|Dinner/.test(t));
    // (iteration 5, revision 7: one key, what you do before what happens to you, each by its time and then the untimed)
    expect(today).toEqual(["Wire payroll.", "Pay the deposit.", "Dinner at Lumen.", "Team breakfast.", "Your parcel arrives."]);
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
      // the open row shows them under the pointer only (plan 214), the line making room then
      await openLine(page, "Pay the deposit").hover();
      await clear();
      await page.keyboard.press("Escape");
      await page.mouse.move(0, 0);
    }
    await server.backend.server.invoke("settings.update", { language: "en" }, dev);
    await fresh(page);
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("list-title")).toHaveText("What matters");
  });

  await scenario("the owner (2026-11-18): who wrote, their avatar first on the second line, the line's height, where the design's lists have avatars", async () => {
    // the project's design, put back after (the e2e project's is macOS)
    const was = (test.info().project.use as { design?: "lumen" | "atelier" | "luma" | "graphite" | "relief" }).design ?? "macos";
    const design = async (d: typeof was | "lumen" | "macos") => {
      await server.backend.server.invoke("settings.update", { design: d, lightTheme: "design", darkTheme: "design" }, dev);
      await fresh(page);
      await page.getByTestId("nav-today").click();
      await expect(page.getByTestId("list-title")).toHaveText("What matters");
    };
    // macOS's rows are Mail's classic ones: no avatars there, nor here
    await design("macos");
    await expect(feed(page).getByTestId("wm-item").first()).toBeVisible();
    await expect(feed(page).getByTestId("wm-face")).toHaveCount(0);
    await design("lumen");
    await reach(page, "Pay the deposit");
    const row = openLine(page, "Pay the deposit");
    const meta = row.getByTestId("wm-meta");
    const avatar = meta.getByTestId("wm-face").getByTestId("sender-avatar");
    await expect(avatar).toBeVisible();
    // part of the line, never its words: it reads, matches and copies as before (the row's title has the line's words)
    const title = (await row.getByTestId("wm-item-open").getAttribute("title"))!;
    await expect(meta).toHaveText(title.split("\n")[1]!);
    const box = (el: typeof avatar) => el.evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);
    const [face, words, heading] = [await box(avatar), await box(meta), await box(feed(page).getByTestId("wm-heading").first())];
    const line = await meta.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight));
    // first on the line, on the headings' edge, no taller than the line and centred on it
    expect(Math.abs(face.left - heading.left)).toBeLessThanOrEqual(1);
    expect(face.height).toBeLessThanOrEqual(line);
    expect(Math.abs(face.top + face.height / 2 - (words.top + line / 2))).toBeLessThanOrEqual(1.5);
    await design(was);
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
async function dated(server: DevServerFixture, key: string, from: string, row: { kind: "pay" | "respond" | "ask" | "event" | "expire"; text: string; days: number; hour?: number; early?: boolean }) {
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
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
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
    await expect(page.locator("#today-count-help")).toContainText(`${2 + waiting} need`);
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

const LONG = "Send Megan Cole the revised logo files with the ligature version and both mockups (the coaster and the shop window), the color guide for the printer, and the signage drafts for both branches";

test("plan 210 (iteration 4): 'to do today'; a broken promise first in Waiting on you; Coming up the last heading, out of j/k while closed; the sentence keeps its width beside the reader; the palette with nothing selected; the menu's More", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true }, followups: { enabled: true } }, dev);
  await dated(server, "water", "City Water", { kind: "pay", text: "Pay the water bill", days: -2 });
  await item(server, "payroll", "Wire payroll", null);
  await dated(server, "rfp", "Owen Hale", { kind: "respond", text: "Send Owen the RFP response", days: 3, hour: 17, early: true });
  await dated(server, "yearend", "Gary Lee", { kind: "respond", text: "Send Gary the year-end numbers", days: 20, early: true });
  await dated(server, "quote", "Mariana Paz", { kind: "ask", text: "Answer Mariana about the rebranding quote", days: 0 });
  await dated(server, "keynote", "Shipfast", { kind: "event", text: "Shipfast Summit keynote", days: 5, hour: 19 });
  await dated(server, "dues", "Rowing Club", { kind: "pay", text: "Pay the club dues", days: 10 });
  await dated(server, "passport", "Passport Office", { kind: "pay", text: "Pay the passport renewal fee", days: 40 });
  await promised(server, "script", { name: "Jess Okafor", email: "jess@railyard.test" }, "send Jess the full Railyard integration script for brand and legal review", { days: 3, brokenDays: -2 });
  // the claims ledger's second batch: a request long enough for three lines beside the reader (Diego's Megan)
  await dated(server, "megan", "Megan Cole", { kind: "respond", text: LONG, days: 6, early: true });
  server.backend.today.changed();
  await page.evaluate(() => localStorage.removeItem("terno.today.comingUp"));
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
  const script = "You said you'd send Jess the full Railyard integration script for brand and legal review.";

  await scenario("the header says what it counts: to do today, apart from what's waiting; the badge their sum", async () => {
    // (iteration 5, revision 6: the broken promise needed ahead is one of those waiting, said so, never added again)
    await expect(page.getByTestId("today-needs")).toHaveText(/^1 missed · 1 to do today · \d+ waiting, 1 overdue$/);
    const waiting = Number(/(\d+) waiting/.exec(await page.getByTestId("today-needs").innerText())![1]);
    await expect(page.locator("#today-count-help")).toContainText(`${2 + waiting} need`);
  });

  await scenario("Waiting on you: the broken promise first, in Missed's weight; then this week's requests; the asks; a request due later is Ahead's (iteration 5)", async () => {
    const { rows } = await walk(page);
    const from = rows.findIndex((r) => r.kind === "#waiting");
    const to = rows.findIndex((r, i) => i > from && r.kind.startsWith("#"));
    const waiting = rows.slice(from + 1, to).filter((r) => r.kind === "open").map((r) => r.text);
    expect(waiting[0]).toBe(script);
    const ours = waiting.filter((t) => /^(You said you'd send Jess|Send Owen the RFP response|Answer Mariana|Send Gary the year-end numbers)/.test(t));
    expect(ours).toEqual([script, "Send Owen the RFP response.", "Answer Mariana about the rebranding quote."]);
    const ahead = rows.findIndex((r) => r.kind === "#ahead");
    expect(rows.findIndex((r) => r.text === "Send Gary the year-end numbers.")).toBeGreaterThan(ahead);
    expect(ahead).toBeGreaterThan(to - 1);
    await reach(page, "send Jess the full");
    const row = openLine(page, "send Jess the full");
    await expect(row).toHaveAttribute("data-tone", "missed");
    await expect(row.getByTestId("wm-when")).toHaveText(/^You said \w{3} \d{1,2} \(missed\)\u00a0·\u00a0needed \w{3}$/);
  });

  await scenario("plan 214 (Ledger): the sentence is the row's whole width, wide and beside the reader; when ends the line under it, beside who", async () => {
    await reach(page, "send Jess the full");
    const row = openLine(page, "send Jess the full");
    const box = async (id: string) => row.getByTestId(id).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    const whole = async () => row.getByTestId("wm-item-open").evaluate((el) => el.getBoundingClientRect().width - 24);
    const laidOut = async () => {
      const [sentence, when, meta] = [await box("wm-sentence"), await box("wm-when"), await box("wm-meta")];
      return sentence.width >= (await whole()) * 0.9 && when.top >= sentence.bottom - 1 && meta.top >= sentence.bottom - 1 && when.left >= meta.right - 1;
    };
    expect(await laidOut()).toBe(true);
    // Done and Later take when's place without moving anything: the row's height (what the virtualizer measured) holds
    // under the pointer and under keyboard focus (Codex's critique of plan 214, point 1)
    const height = () => row.evaluate((el) => el.getBoundingClientRect().height);
    await page.mouse.move(0, 0);
    const resting = await height();
    await row.hover();
    await expect(row.getByTestId("wm-done")).toBeVisible();
    expect(await height()).toBe(resting);
    await page.mouse.move(0, 0);
    await row.getByTestId("wm-item-open").focus();
    expect(await height()).toBe(resting);
    await row.getByTestId("wm-item-open").click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(row).toHaveAttribute("data-open", "true");
    // narrow: the same two lines (Done and Later take when's place on the open row: it's measured with the row hovered away)
    await page.mouse.move(0, 0);
    await expect.poll(async () => (await box("wm-sentence")).width >= (await whole()) * 0.9).toBe(true);
    await expect(row.getByTestId("wm-sentence")).toContainText("You said you'd send Jess the full");
  });

  await scenario("the claims ledger's second batch: a long sentence is three lines at most, whole in its title; the open one whole", async () => {
    // (the reader still open beside the feed: the narrowest the sentence gets)
    await expect(page.getByTestId("reader")).toBeVisible();
    await reach(page, "Send Megan Cole");
    const megan = openLine(page, "Send Megan Cole");
    const sentence = megan.getByTestId("wm-sentence");
    const clamp = () => sentence.evaluate((el) => ({ lines: getComputedStyle(el).webkitLineClamp, cut: el.scrollHeight > el.clientHeight + 1, height: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight) }));
    const closed = await clamp();
    expect(closed.lines).toBe("3");
    // long enough to be cut here: three lines shown, the rest in the title and to a screen reader (the text is whole)
    expect(closed.cut).toBe(true);
    expect(Math.round(closed.height / closed.line)).toBe(3);
    await expect(megan.getByTestId("wm-item-open")).toHaveAttribute("title", new RegExp(`^${LONG.replace(/[()]/g, "\\$&")}\\.\n`));
    await expect(sentence).toHaveText(`${LONG}.`);
    const shoot = async (name: string) => {
      if (!process.env.WM_CLAMP_SHOTS) return;
      for (const mode of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await page.screenshot({ path: `${process.env.WM_CLAMP_SHOTS}/${name}-${mode}.png` });
      }
      await page.emulateMedia({ colorScheme: "light" });
    };
    await shoot("feed-closed-long");
    // open, it's whole
    await megan.getByTestId("wm-item-open").click();
    await expect(megan).toHaveAttribute("data-open", "true");
    await expect.poll(async () => (await clamp()).cut).toBe(false);
    expect((await clamp()).lines).toBe("none");
    await shoot("feed-open-long");
    // put it away again (the scenarios after start with the reader closed by their own clicks)
    await megan.getByTestId("wm-item-open").click();
    await reach(page, "send Jess the full");
    await openLine(page, "send Jess the full").getByTestId("wm-item-open").click();
    await expect(openLine(page, "send Jess the full")).toHaveAttribute("data-open", "true");
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

test("plan 210 (iteration 5): Today's own by one key, a broken promise needed today first; '1 overdue'; Ahead after the seven days, Coming up last; the palette with an item selected; the reader's line; ⇧B and ⇧F", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true }, followups: { enabled: true } }, dev);
  // Today: a pay with a time, a pay with none, a delivery at 9:00 and a dinner at 7:00 PM, and María's slip, promised Monday,
  // needed today
  await item(server, "payroll", "Wire payroll", null);
  await items(server, "party", [
    { kind: "delivery", text: "Your parcel arrives", hour: 9 },
    { kind: "pay", text: "Pay the deposit", hour: null },
    { kind: "event", text: "Team dinner", hour: 19 },
  ]);
  await promised(server, "slip", { name: "Ms. Ruiz", email: "ruiz@school.test" }, "send Ms. Ruiz the signed slip", { days: 0, brokenDays: -3 });
  // Waiting on you: Jess's script, promised two days ago, needed in three
  await promised(server, "script", { name: "Jess Okafor", email: "jess@railyard.test" }, "send Jess the Railyard script", { days: 3, brokenDays: -2 });
  await dated(server, "keynote", "Shipfast", { kind: "event", text: "Shipfast Summit keynote", days: 5, hour: 19 });
  // Ahead: shown early past the seven days, by their own days; Coming up: not shown yet
  await dated(server, "yearend", "Gary Lee", { kind: "respond", text: "Send Gary the year-end numbers", days: 20, early: true });
  await dated(server, "visa", "Consulate", { kind: "expire", text: "Renew the work visa", days: 12 });
  await dated(server, "dues", "Rowing Club", { kind: "pay", text: "Pay the club dues", days: 10 });
  await dated(server, "passport", "Passport Office", { kind: "pay", text: "Pay the passport renewal fee", days: 40 });
  server.backend.today.changed();
  await page.evaluate(() => localStorage.removeItem("terno.today.comingUp"));
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
  const slip = "You said you'd send Ms. Ruiz the signed slip.";

  await scenario("the header: the slip is to do today; the script is one of those waiting, overdue; the badge their sum", async () => {
    await expect(page.getByTestId("today-needs")).toHaveText(/^3 to do today · \d+ waiting, 1 overdue$/);
    const waiting = Number(/(\d+) waiting/.exec(await page.getByTestId("today-needs").innerText())![1]);
    await expect(page.locator("#today-count-help")).toContainText(`${3 + waiting} need`);
  });

  await scenario("Today: the broken promise needed today first; what you do, by its time then the untimed; then what happens, by its time", async () => {
    const { rows } = await walk(page);
    const ours = /^(You said you'd send Ms\. Ruiz|Wire payroll|Pay the deposit|Your parcel arrives|Team dinner)/;
    const from = rows.findIndex((r) => r.kind === "#today");
    const to = rows.findIndex((r, i) => i > from && r.kind.startsWith("#"));
    expect(rows.slice(from + 1, to).filter((r) => r.kind === "open" && ours.test(r.text)).map((r) => r.text)).toEqual([slip, "Wire payroll.", "Pay the deposit.", "Your parcel arrives.", "Team dinner."]);
    await reach(page, "send Ms. Ruiz");
    await expect(openLine(page, "send Ms. Ruiz")).toHaveAttribute("data-tone", "missed");
    await expect(openLine(page, "send Ms. Ruiz").getByTestId("wm-when")).toContainText("needed today");
  });

  await scenario("Ahead after the seven days, by its rows' own days, each its date in its column; Coming up after it, last, closed, then open in buckets of its own", async () => {
    const toggle = page.getByTestId("wm-coming-up");
    const { rows } = await walk(page);
    const ours = /^(Shipfast Summit keynote|Renew the work visa|Send Gary the year-end numbers|Pay the club dues|Pay the passport renewal fee)\.$/;
    const order = rows.filter((r) => r.kind === "#day" || r.kind === "#ahead" || r.kind === "#comingUp" || r.kind === "#coming" || (r.kind === "open" && ours.test(r.text))).map((r) => (r.kind === "open" ? r.text : r.kind));
    const ahead = order.indexOf("#ahead");
    expect(order.slice(ahead)).toEqual(["#ahead", "Renew the work visa.", "Send Gary the year-end numbers.", "#comingUp"]);
    expect(order.indexOf("Shipfast Summit keynote.")).toBeLessThan(ahead);
    await expect(feed(page).locator('[data-testid="wm-heading"][data-kind="ahead"]')).toHaveText("Ahead");
    for (const text of ["Renew the work visa", "Send Gary the year-end numbers"]) {
      await reach(page, text);
      await expect(openLine(page, text).getByTestId("wm-when")).toHaveText(/^[A-Z][a-z]{2} \d{1,2}$/);
      await expect(openLine(page, text)).toHaveAttribute("data-tone", "later");
    }
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(toggle).toHaveText("Coming up · 2");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const open = await walk(page);
    const after = open.rows.filter((r) => r.kind === "#ahead" || r.kind === "#comingUp" || r.kind === "#coming" || (r.kind === "open" && ours.test(r.text))).map((r) => (r.kind === "open" ? r.text : r.kind));
    expect(after.slice(after.indexOf("#ahead"))).toEqual(["#ahead", "Renew the work visa.", "Send Gary the year-end numbers.", "#comingUp", "#coming", "Pay the club dues.", "#coming", "Pay the passport renewal fee."]);
    // closed on one of its rows with the reader open: the feed on Ahead's last row
    await reach(page, "Pay the club dues");
    await openLine(page, "Pay the club dues").getByTestId("wm-item-open").click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await toggle.click();
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await expect.poll(async () => (await reach(page, "Send Gary the year-end numbers"), await openLine(page, "Send Gary the year-end numbers").getAttribute("data-cursor"))).toBe("true");
  });

  await scenario("the reader's line: the sentence on a line of its own, its controls under it on its edge", async () => {
    await reach(page, "send Ms. Ruiz");
    await openLine(page, "send Ms. Ruiz").getByTestId("wm-item-open").click();
    const text = page.getByTestId("thread-dated-text");
    await expect(text).toContainText("send the signed slip");
    const box = async (id: string) => page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    const [t, done, dismiss] = [await box("thread-dated-text"), await box("thread-dated-done"), await box("thread-dated-dismiss")];
    expect(done.top).toBeGreaterThanOrEqual(t.bottom);
    expect(Math.abs(done.left - t.left)).toBeLessThanOrEqual(1);
    // the sentence has the card's width, nothing beside it
    expect(dismiss.top).toBeGreaterThanOrEqual(t.bottom);
    await axeBothModes(page, '[data-testid="thread-dated"]');
  });

  await scenario("the palette with an item selected: its acts lead under its words; Remind me is the email's, answers \"later\" no more, and offers nothing past the item's moment", async () => {
    await reach(page, "Team dinner");
    await openLine(page, "Team dinner").getByTestId("wm-item-open").click();
    await expect(openLine(page, "Team dinner")).toHaveAttribute("data-open", "true");
    await page.keyboard.press("ControlOrMeta+k");
    const groups = page.locator("[data-group]");
    await expect(groups.first()).toHaveAttribute("data-group", "item");
    await expect(page.getByTestId("palette-item")).toHaveText("Team dinner.");
    await expect(groups.first().locator("[data-command]")).toHaveCount(5);
    expect(await groups.first().locator("[data-command]").evaluateAll((els) => els.map((e) => e.getAttribute("data-command")))).toEqual(["dated.done", "dated.later", "dated.change", "dated.handTo", "dated.dismiss"]);
    // Remind me with the email's actions, never among the item's
    await expect(page.locator('[data-group="item"]').getByTestId("palette-remind")).toHaveCount(0);
    await page.getByTestId("palette-input").fill("later");
    await expect(page.locator("[data-group]").first()).toHaveAttribute("data-group", "item");
    await expect(page.locator('[aria-selected="true"]')).toHaveAttribute("data-command", "dated.later");
    await expect(page.getByTestId("palette-remind").getByTestId("palette-alias")).toHaveCount(0);
    // round 15's second morning: nor a Remind me preset ("Remind me: Later today") beside it; "remind" still finds them
    const presets = page.locator("[data-command^='remind:']");
    await expect(presets).toHaveCount(0);
    await page.getByTestId("palette-input").fill("remind");
    await expect(page.getByTestId("palette-remind")).toBeVisible();
    await expect(presets.first()).toBeVisible();
    // Remind me's page: a moment before the dinner's 7:00 PM only
    await page.getByTestId("palette-input").fill("");
    await page.getByTestId("palette-remind").click();
    await expect(page.getByTestId("palette-remind-always-laterToday")).toBeVisible();
    await expect(page.getByTestId("palette-remind-always-tomorrow")).toHaveCount(0);
    await expect(page.getByTestId("palette-remind-noReply-in1d")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toHaveCount(0);
  });

  await scenario("the menu says what Change… and Hand to… do; ⇧B opens Change… for the open row", async () => {
    await openLine(page, "Team dinner").click({ button: "right" });
    await expect(page.getByTestId("menu-dated-change-note")).toHaveText("Sets its own day");
    await expect(page.getByTestId("menu-dated-hand-note")).toHaveText("Forwards it to someone");
    await expect(page.getByTestId("menu-dated-change")).toHaveAttribute("aria-describedby", /.+/);
    await page.keyboard.press("Escape");
    if (await page.getByTestId("menu-dated-done").isVisible()) await page.keyboard.press("Escape");
    await expect(page.getByTestId("menu-dated-done")).toHaveCount(0);
    // (on the row open, or the one a conversation was put away from: the feed's place)
    await page.keyboard.press("Shift+B");
    await expect(page.getByTestId("today-change-dialog")).toBeVisible();
    await expect(page.getByTestId("today-change-text")).toContainText("Team dinner");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("today-change-dialog")).toHaveCount(0);
  });

  const shots = process.env.WM_IT5_SHOTS;
  if (shots) {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const language of ["en", "es"] as const) {
      await server.backend.server.invoke("settings.update", { language }, dev);
      await fresh(page);
      await page.getByTestId("nav-today").click();
      await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
      for (const mode of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        const name = (what: string) => `${shots}/${what}-${language}-${mode}.png`;
        if (await page.getByTestId("reader").count()) await feed(page).locator("[data-open] [data-testid=wm-item-open]").first().click();
        await expect(page.getByTestId("reader")).toHaveCount(0);
        await scroller(page).evaluate((el) => (el.scrollTop = 0));
        await page.waitForTimeout(300);
        await page.screenshot({ path: name("feed-top") });
        // Ahead and Coming up open, Ahead's heading at the top
        const toggle = page.getByTestId("wm-coming-up");
        for (let i = 0; i < 30 && !(await toggle.isVisible()); i++) {
          await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
          await page.waitForTimeout(100);
        }
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        await page.waitForTimeout(300);
        await feed(page).locator('[data-testid="wm-heading"][data-kind="ahead"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(300);
        await page.screenshot({ path: name("ahead-coming-up") });
        await toggle.click();
        await reach(page, "Ruiz");
        await openLine(page, "Ruiz").getByTestId("wm-item-open").click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: name("reader-line") });
        await reach(page, "Team dinner");
        await openLine(page, "Team dinner").getByTestId("wm-item-open").click();
        await page.waitForTimeout(300);
        await page.keyboard.press("ControlOrMeta+k");
        await page.waitForTimeout(300);
        await page.screenshot({ path: name("palette") });
        await page.keyboard.press("Escape");
        await openLine(page, "Team dinner").click({ button: "right" });
        await page.waitForTimeout(300);
        await page.screenshot({ path: name("menu") });
        await page.keyboard.press("Escape");
        if (await page.getByTestId("menu-dated-done").isVisible()) await page.keyboard.press("Escape");
      }
    }
    await server.backend.server.invoke("settings.update", { language: "en" }, dev);
    await page.emulateMedia({ colorScheme: "light" });
  }
});

test("plan 211: an account's switches in Settings → Accounts: out of What matters, nothing of it shows; AI off, only what the AI made goes, and what depends on its AI leaves Settings", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
  await item(server, "power", "Pay the power bill", null);
  // a conversation waiting on you: Needs you's own, local rule
  const store = server.backend.store;
  await store.sync.ingest([message(server, "waiting", { name: "Ana Ruiz", email: "ana@people.test" }, "Can we meet Thursday?", "Can we meet Thursday?", E2E_NOW - HOUR, { isRead: false, inInbox: true })], { applyFilters: false, now: E2E_NOW, classifier: null });
  const db = sqlDb(store);
  const waiting = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = 'waiting'")!.thread_id;
  db.run("UPDATE threads SET waiting_since = ?, has_sent = 1 WHERE id = ?", E2E_NOW - HOUR, waiting);
  await fresh(page);
  const settings = async () => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    const editor = page.getByTestId("account-editor").first();
    if (!(await editor.isVisible())) await page.getByTestId("account-toggle").first().click();
    await expect(page.getByTestId("account-ai")).toBeVisible();
  };
  const feedShows = async (bill: boolean, ana: boolean) => {
    await page.keyboard.press("Escape");
    await page.getByTestId("nav-today").click();
    await expect(feed(page)).toBeVisible();
    await expect(openLine(page, "Pay the power bill")).toHaveCount(bill ? 1 : 0);
    await expect(feed(page).locator(`[data-thread-id="${waiting}"]`)).toHaveCount(ana ? 1 : 0);
  };
  await page.getByTestId("nav-today").click();
  await expect(openLine(page, "Pay the power bill")).toBeVisible({ timeout: 15_000 });
  await expect(feed(page).locator(`[data-thread-id="${waiting}"]`)).toHaveCount(1);

  await scenario("Show in What matters off: neither the bill nor the conversation waiting on you; on, both are back", async () => {
    await settings();
    await expect(page.getByTestId("account-feed")).toHaveAccessibleName("Show in “What matters”");
    await page.getByTestId("account-feed").click();
    await expect(page.getByTestId("account-feed")).toHaveAttribute("aria-checked", "false");
    // its other AI is untouched: what depends on it stays
    await expect(page.getByTestId("account-followups")).toBeVisible();
    await feedShows(false, false);
    await settings();
    await page.getByTestId("account-feed").click();
    await expect(page.getByTestId("account-feed")).toHaveAttribute("aria-checked", "true");
    await feedShows(true, true);
  });

  await scenario("Use AI off: the bill goes, the waiting conversation stays, and what depends on the account's AI leaves Settings; on, it's all back", async () => {
    await settings();
    await expect(page.getByTestId("account-ai")).toHaveAccessibleName("Use AI with this account");
    await page.getByTestId("account-ai").click();
    await expect(page.getByTestId("account-ai")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("account-followups")).toHaveCount(0);
    await expect(page.getByTestId("account-prepare-replies")).toHaveCount(0);
    await expect(page.getByTestId("account-feed")).toBeVisible();
    await feedShows(false, true);
    await settings();
    await page.getByTestId("account-ai").click();
    await expect(page.getByTestId("account-followups")).toBeVisible();
    await feedShows(true, true);
  });
});

test("the list's keys on What matters' rows: e, # and r on the row the keys are on with nothing open; e on the open one moves on; a task stays, its mail filed; z exact", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
  const bill = await item(server, "power", "Pay the power bill", null);
  // two conversations waiting on you, as Needs you's own rule finds them: you wrote, they answered
  const store = server.backend.store;
  const db = sqlDb(store);
  const me = db.get<{ email: string }>("SELECT email FROM accounts ORDER BY id LIMIT 1")!.email;
  const waitingOn = async (key: string, who: { name: string; email: string }, subject: string, at: number) => {
    const mine = message(server, `${key}-mine`, { name: "", email: me }, subject, "Sounds good, what works for you?", at - HOUR, { providerThreadId: key, to: [who], isSent: true });
    const theirs = message(server, key, who, `Re: ${subject}`, subject, at, { providerThreadId: key, isRead: false, inInbox: true, inReplyTo: `<${key}-mine@e2e.test>` });
    await store.sync.ingest([mine, theirs], { applyFilters: false, now: E2E_NOW, classifier: null });
    return db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", key)!.thread_id;
  };
  const ana = await waitingOn("ana", { name: "Ana Ruiz", email: "ana@people.test" }, "Can we meet Thursday?", E2E_NOW - HOUR);
  await waitingOn("ben", { name: "Ben Ito", email: "ben@people.test" }, "Notes from the offsite", E2E_NOW - 2 * HOUR);
  const where = (id: number) => db.get<{ in_inbox: number; in_trash: number }>("SELECT in_inbox, in_trash FROM threads WHERE id = ?", id)!;
  await fresh(page);
  await page.getByTestId("nav-today").click();
  const anaRow = feed(page).locator(`[data-row-id="waiting:${ana}"]`);
  await expect(anaRow).toBeVisible({ timeout: 15_000 });
  /** the row drawn after Ana's, which the keys and the reader go on to */
  const nextId = () => anaRow.evaluate((el) => el.closest("[data-index]")!.nextElementSibling?.querySelector("[data-row-id]")?.getAttribute("data-row-id") ?? null);
  const row = (id: string) => feed(page).locator(`[data-row-id="${id}"]`);

  await scenario("e with nothing open archives the row the keys are on: it leaves, the keys on the next; z brings it back, the keys on it", async () => {
    const next = (await nextId())!;
    await anaRow.getByTestId("wm-item-open").focus();
    await page.keyboard.press("e");
    await expect(anaRow).toHaveCount(0);
    await expect(page.getByTestId("snack")).toContainText("Archived");
    await expect.poll(() => where(ana).in_inbox).toBe(0);
    await expect(row(next).getByTestId("wm-item-open")).toBeFocused();
    await expect(page.getByTestId("reader")).toHaveCount(0);
    await page.keyboard.press("z");
    await expect.poll(() => where(ana).in_inbox).toBe(1);
    await expect(page.getByTestId("snack")).toContainText("Restored");
    await expect(anaRow.getByTestId("wm-item-open")).toBeFocused();
    await expect(page.getByTestId("reader")).toHaveCount(0);
  });

  await scenario("e on the open row: it leaves and the next row's conversation opens, as the Inbox's next; z opens it again", async () => {
    const next = (await nextId())!;
    await anaRow.getByTestId("wm-item-open").click();
    await expect(page.locator("#reader-subject")).toHaveText(/Can we meet Thursday\?/);
    await page.keyboard.press("e");
    await expect(anaRow).toHaveCount(0);
    await expect(row(next)).toHaveAttribute("data-open");
    await expect(row(next).getByTestId("wm-item-open")).toBeFocused();
    await expect(page.locator("#reader-subject")).not.toHaveText(/Can we meet Thursday\?/);
    await page.keyboard.press("z");
    await expect.poll(() => where(ana).in_inbox).toBe(1);
    await expect(page.getByTestId("snack")).toContainText("Restored");
    await expect(anaRow).toHaveAttribute("data-open");
    await expect(page.locator("#reader-subject")).toHaveText(/Can we meet Thursday\?/);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("reader")).toHaveCount(0);
  });

  await scenario("a task stays (plan 204: the bill still has to be paid): e files its mail, its row stays open", async () => {
    const billRow = openLine(page, "Pay the power bill");
    await billRow.getByTestId("wm-item-open").click();
    await page.keyboard.press("e");
    await expect(page.getByTestId("snack")).toContainText("Archived");
    await expect.poll(() => where(bill).in_inbox).toBe(0);
    await expect(billRow).toHaveAttribute("data-open");
    await page.keyboard.press("z");
    await expect.poll(() => where(bill).in_inbox).toBe(1);
    await expect(page.getByTestId("snack")).toContainText("Restored");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("reader")).toHaveCount(0);
  });

  await scenario("# with nothing open trashes the keys' row; z restores it; r opens its conversation with the reply", async () => {
    await anaRow.getByTestId("wm-item-open").focus();
    const next = (await nextId())!;
    await page.keyboard.press("#");
    await expect(anaRow).toHaveCount(0);
    await expect.poll(() => where(ana).in_trash).toBe(1);
    await expect(row(next).getByTestId("wm-item-open")).toBeFocused();
    await page.keyboard.press("z");
    await expect.poll(() => where(ana).in_trash).toBe(0);
    await expect(page.getByTestId("snack")).toContainText("Restored");
    await expect(anaRow.getByTestId("wm-item-open")).toBeFocused();
    await page.keyboard.press("r");
    await expect(page.locator("#reader-subject")).toHaveText(/Can we meet Thursday\?/);
    await expect(anaRow).toHaveAttribute("data-open");
    await expect(page.getByTestId("composer")).toBeVisible();
  });
});

test("plan 215: Done and Later on Waiting on you's rows: Done leaves with its snack, lands under Earlier, leaves the Inbox's Waiting, Undo brings it back; Later puts it under Coming up, back tomorrow, out of the count; axe", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
  const store = server.backend.store;
  const db = sqlDb(store);
  const me = db.get<{ email: string }>("SELECT email FROM accounts ORDER BY id LIMIT 1")!.email;
  // as Needs you's own rule finds them: you wrote, they answered (never set by hand: Done walks the facts again)
  const waitingOn = async (key: string, who: { name: string; email: string }, subject: string, at: number) => {
    const mine = message(server, `${key}-mine`, { name: "", email: me }, subject, "Sounds good, what works for you?", at - HOUR, { providerThreadId: key, to: [who], isSent: true });
    const theirs = message(server, key, who, `Re: ${subject}`, subject, at, { providerThreadId: key, isRead: false, inInbox: true, inReplyTo: `<${key}-mine@e2e.test>` });
    await store.sync.ingest([mine, theirs], { applyFilters: false, now: E2E_NOW, classifier: null });
    return db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", key)!.thread_id;
  };
  const tomas = await waitingOn("tomas", { name: "Tomas Santarcieri", email: "tomas@people.test" }, "The Q3 numbers", E2E_NOW - HOUR);
  const ben = await waitingOn("ben", { name: "Ben Ito", email: "ben@people.test" }, "Notes from the offsite", E2E_NOW - 2 * HOUR);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  const row = (id: number) => feed(page).locator(`[data-row-id="waiting:${id}"]`);
  await expect(row(tomas)).toBeVisible({ timeout: 15_000 });
  const waitingCount = async () => Number(/(\d+) waiting/.exec(await page.getByTestId("today-needs").innerText())?.[1] ?? 0);
  const before = await waitingCount();
  const shots = process.env.WM_215_SHOTS;
  const shoot = async (name: string, rest = false) => {
    if (!shots) return;
    // at rest: no pointer on a row, no snack over the feed's foot
    if (rest) {
      await page.mouse.move(5, 5);
      if (await page.getByTestId("snack-close").count()) await page.getByTestId("snack-close").first().click();
    }
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${shots}/${test.info().project.name}-${name}-${mode}.png` });
    }
    await page.emulateMedia({ colorScheme: "light" });
  };

  await scenario("hovered, a waiting row shows Done and Later beside its date, as any task's", async () => {
    await row(tomas).hover();
    await expect(row(tomas).getByTestId("wm-done")).toBeVisible();
    await expect(row(tomas).getByTestId("wm-later")).toBeVisible();
    await expect(row(tomas).getByTestId("wm-when")).toBeVisible();
    await shoot("hover");
  });

  await scenario("Done: the row leaves with its snack, Earlier says it in the row's words, the Inbox's Waiting has it no more; z brings it all back", async () => {
    await row(tomas).getByTestId("wm-done").click();
    await expect(row(tomas)).toHaveCount(0);
    await expect(page.getByTestId("snack")).toContainText("Done: Tomas Santarcieri");
    await expect.poll(waitingCount).toBe(before - 1);
    await reach(page, "Tomas Santarcieri wrote back about");
    const line = feed(page).locator("[data-history]").filter({ hasText: "Tomas Santarcieri wrote back about" });
    await expect(line).toHaveCount(1);
    await expect(line.getByTestId("wm-when")).toHaveText("Done today");
    await expect(line.getByTestId("wm-controls")).toHaveCount(0);
    await line.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shoot("earlier", true);
    await page.getByTestId("nav-inbox").click();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-filter-waiting").click();
    await expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", /,"waiting","[^"]*"\]$/);
    await expect(page.locator(`[data-testid="thread-row"][data-thread-id="${ben}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid="thread-row"][data-thread-id="${tomas}"]`)).toHaveCount(0);
    await page.getByTestId("nav-today").click();
    await expect(feed(page)).toBeVisible();
    await page.keyboard.press("z");
    await expect.poll(() => db.get<{ w: number | null }>("SELECT waiting_since AS w FROM threads WHERE id = ?", tomas)!.w).not.toBeNull();
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await expect(row(tomas)).toBeVisible();
    await expect.poll(waitingCount).toBe(before);
    await expect(line).toHaveCount(0);
  });

  await scenario("Later to tomorrow: under Coming up, back tomorrow, out of the header's count; the Inbox keeps it", async () => {
    await row(tomas).hover();
    await row(tomas).getByTestId("wm-later").click();
    await page.getByTestId("wm-later-menu").getByTestId("wm-later-tomorrow").click();
    await expect(page.getByTestId("snack")).toContainText(/^Later: Tomas Santarcieri, back tomorrow/);
    await expect.poll(waitingCount).toBe(before - 1);
    // Coming up's disclosure, where the feed draws it (only what's near the view is drawn)
    const coming = page.getByTestId("wm-coming-up");
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    for (let i = 0; i < 60 && !(await coming.count()); i++) {
      await scroller(page).evaluate((el) => (el.scrollTop += el.clientHeight * 0.7));
      await page.waitForTimeout(80);
    }
    if ((await coming.getAttribute("aria-expanded")) !== "true") await coming.click();
    await reach(page, "Tomas Santarcieri");
    await expect(row(tomas)).toHaveAttribute("data-ahead", "true");
    await expect(row(tomas).getByTestId("wm-when")).toHaveText(/^back tomorrow/);
    expect(db.get<{ w: number | null }>("SELECT waiting_since AS w FROM threads WHERE id = ?", tomas)!.w).not.toBeNull();
    await row(tomas).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shoot("later", true);
    await axeBothModes(page, '[data-testid="wm-feed"]');
  });
});

test("plan 216: Remove on Waiting on you's rows (the right-click menu, ⇧D), the Inbox keeping it; the open waiting row's line in the reader with Done, Later and Remove; axe", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
  const store = server.backend.store;
  const db = sqlDb(store);
  const me = db.get<{ email: string }>("SELECT email FROM accounts ORDER BY id LIMIT 1")!.email;
  const waitingOn = async (key: string, who: { name: string; email: string }, subject: string, at: number) => {
    const mine = message(server, `${key}-mine`, { name: "", email: me }, subject, "Sounds good, what works for you?", at - HOUR, { providerThreadId: key, to: [who], isSent: true });
    const theirs = message(server, key, who, `Re: ${subject}`, subject, at, { providerThreadId: key, isRead: false, inInbox: true, inReplyTo: `<${key}-mine@e2e.test>` });
    await store.sync.ingest([mine, theirs], { applyFilters: false, now: E2E_NOW, classifier: null });
    return db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", key)!.thread_id;
  };
  const lucas = await waitingOn("lucas", { name: "Lucas Fajardo Gutiérrez", email: "lucas@iuspro.test" }, "IusPro - Colombia", E2E_NOW - HOUR);
  const ben = await waitingOn("ben", { name: "Ben Ito", email: "ben@people.test" }, "Notes from the offsite", E2E_NOW - 2 * HOUR);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  const row = (id: number) => feed(page).locator(`[data-row-id="waiting:${id}"]`);
  await expect(row(lucas)).toBeVisible({ timeout: 15_000 });
  const waitingCount = async () => Number(/(\d+) waiting/.exec(await page.getByTestId("today-needs").innerText())?.[1] ?? 0);
  const before = await waitingCount();
  const snack = page.getByTestId("snack");
  const card = page.getByTestId("thread-dated");
  const waitingSince = () => db.get<{ w: number | null }>("SELECT waiting_since AS w FROM threads WHERE id = ?", lucas)!.w;
  const shots = process.env.WM_216_SHOTS;
  const shoot = async (name: string) => {
    if (!shots) return;
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${shots}/216-${name}-${mode}.png` });
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  /** open it (a second click on the open one would put it away) */
  const openRow = async () => {
    if ((await row(lucas).getAttribute("data-open")) !== "true") await row(lucas).getByTestId("wm-item-open").click();
    await expect(row(lucas)).toHaveAttribute("data-open", "true");
  };
  /** the row's way back: z, and the feed at its top */
  const back = async () => {
    await page.keyboard.press("z");
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await expect(row(lucas)).toBeVisible();
    await expect.poll(waitingCount).toBe(before);
  };

  await scenario("the right-click menu's Remove: off What matters with its snack and count, still waiting in the Inbox; z brings it back", async () => {
    await row(lucas).click({ button: "right" });
    await expect(page.getByTestId("menu-dated-dismiss")).toBeVisible();
    await expect(page.getByTestId("menu-dated-hand")).toHaveCount(0);
    await shoot("menu");
    await page.getByTestId("menu-dated-dismiss").click();
    await expect(row(lucas)).toHaveCount(0);
    await expect(snack).toContainText("Removed from “What matters”: Lucas Fajardo Gutiérrez");
    await expect.poll(waitingCount).toBe(before - 1);
    // no Earlier line, and the conversation still waits: the Inbox's Waiting lists it
    await expect(feed(page).locator("[data-history]").filter({ hasText: "Lucas Fajardo" })).toHaveCount(0);
    expect(waitingSince()).not.toBeNull();
    await page.getByTestId("nav-inbox").click();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-filter-waiting").click();
    await expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", /,"waiting","[^"]*"\]$/);
    await expect(page.locator(`[data-testid="thread-row"][data-thread-id="${lucas}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid="thread-row"][data-thread-id="${ben}"]`)).toHaveCount(1);
    await page.getByTestId("nav-today").click();
    await expect(feed(page)).toBeVisible();
    await back();
  });

  await scenario("open, its line leads the reader's card with Done, Later and Remove; the row at rest shows none; axe", async () => {
    await openRow();
    await expect(card.getByTestId("thread-dated-item")).toHaveAttribute("data-source", "waiting");
    await expect(card.getByTestId("thread-dated-text")).toHaveText(/^Lucas Fajardo Gutiérrez is waiting on your reply · since /u);
    await expect(card.getByTestId("thread-dated-controls").getByRole("button")).toHaveText(["Done", "Later", "Remove"]);
    await page.mouse.move(5, 5);
    await expect(row(lucas).getByTestId("wm-controls")).toHaveCSS("opacity", "0");
    await shoot("reader");
    await axeBothModes(page, '[data-testid="thread-dated"]');
  });

  await scenario("the card's Remove: the row leaves, the keys go on to the feed's row; z brings it back open", async () => {
    await card.getByTestId("thread-dated-dismiss").click();
    await expect(row(lucas)).toHaveCount(0);
    await expect(snack).toContainText("Removed from “What matters”: Lucas Fajardo Gutiérrez");
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-testid=wm-feed]") !== null)).toBe(true);
    await back();
  });

  await scenario("⇧D on the open waiting row removes it; the card's Later to tomorrow and its Done act on it too, each with its Undo", async () => {
    await openRow();
    await expect(card.getByTestId("thread-dated-item")).toHaveAttribute("data-source", "waiting");
    // the keys came back to it with the Undo (they'd gone on to the next row with the card's Remove)
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-row-id]")?.getAttribute("data-row-id"))).toBe(`waiting:${lucas}`);
    await page.keyboard.press("Shift+D");
    await expect(row(lucas)).toHaveCount(0);
    await expect(snack).toContainText("Removed from “What matters”: Lucas Fajardo Gutiérrez");
    await back();
    await openRow();
    await card.getByTestId("thread-dated-later").click();
    await page.getByTestId("thread-dated-later-menu").getByTestId("thread-dated-later-tomorrow").click();
    await expect(snack).toContainText(/^Later: Lucas Fajardo Gutiérrez, back tomorrow/);
    await expect.poll(waitingCount).toBe(before - 1);
    await back();
    await openRow();
    await card.getByTestId("thread-dated-done").click();
    await expect(snack).toContainText("Done: Lucas Fajardo Gutiérrez");
    await expect.poll(waitingSince).toBeNull();
    await page.keyboard.press("z");
    await expect.poll(waitingSince).not.toBeNull();
  });
});

test("plan 222: nothing needs you: the horizon heads the feed and says what you're free until; the clear day counted once a day; on the feed's column; axe in light and dark", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
  // (the demo mailbox's own conversations waiting on you would keep it from ever being clear)
  sqlDb(server.backend.store).run("UPDATE threads SET waiting_since = NULL");
  await item(server, "gas", "Pay the gas bill", E2E_NOW - 2 * HOUR);
  await item(server, "payroll", "Wire payroll", null);
  server.backend.today.changed();
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(openLine(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
  const clear = feed(page).getByTestId("wm-clear");
  const words = clear.getByTestId("wm-clear-words");

  await scenario("something needs you: no horizon; the last item done, it heads the feed with Earlier under it, the first clear day", async () => {
    await expect(clear).toHaveCount(0);
    await openLine(page, "Wire payroll").getByTestId("wm-item-open").click();
    await page.keyboard.press("d");
    await page.keyboard.press("Escape");
    await expect(words).toHaveText("Nothing on the horizon.");
    await expect(clear.getByTestId("wm-clear-day")).toHaveText("Clear day No. 1");
    await expect(feed(page).locator('[data-index="0"] [data-testid=wm-clear]')).toHaveCount(1);
    await expect(feed(page).locator('[data-testid="wm-heading"][data-kind="history"]')).toBeVisible();
    // 9:30 on the demo's morning: the sun on its arc, never a night scene
    await expect(clear.getByTestId("wm-horizon")).toHaveAttribute("data-sun", "up");
  });

  await scenario("finished items hidden: the horizon still heads the feed, centred on the feed's column; axe in light and dark", async () => {
    await page.getByTestId("wm-options").click();
    await page.getByTestId("wm-options-finished").click();
    await page.keyboard.press("Escape");
    await expect(feed(page).locator('[data-testid="wm-heading"][data-kind="history"]')).toHaveCount(0);
    await expect(words).toHaveText("Nothing on the horizon.");
    await expect(clear.getByTestId("wm-clear-day")).toHaveText("Clear day No. 1");
    const centre = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    };
    // the header's column, the one the title starts on
    const column = await page.getByTestId("list-title").evaluate((el) => {
      const r = el.closest("header")!.firstElementChild!.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    expect(Math.abs((await clear.evaluate(centre)) - column)).toBeLessThanOrEqual(2);
    await axeBothModes(page, '[data-testid="wm-feed"]');
    await page.getByTestId("wm-options").click();
    await page.getByTestId("wm-options-finished").click();
    await page.keyboard.press("Escape");
    await expect(feed(page).locator('[data-testid="wm-heading"][data-kind="history"]')).toBeVisible();
  });

  await scenario("an item two days ahead: free until its day, said as it arrives", async () => {
    await dated(server, "keynote", "Shipfast", { kind: "event", text: "Shipfast Summit keynote", days: 2, hour: 19 });
    server.backend.today.changed();
    const day = await page.evaluate((now) => {
      const d = new Date(now);
      d.setDate(d.getDate() + 2);
      return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(d);
    }, E2E_NOW);
    await expect(words).toHaveText(`Nothing needs you until ${day}.`);
    await expect(openLine(page, "Shipfast Summit keynote")).toBeVisible();
  });

  await scenario("a reload the same day: still the first clear day; j, with nothing open, lands on the first item, never on the horizon", async () => {
    await fresh(page);
    await page.getByTestId("nav-today").click();
    await expect(clear.getByTestId("wm-clear-day")).toHaveText("Clear day No. 1");
    await page.keyboard.press("j");
    await expect(feed(page).locator("[data-cursor], [data-open]")).toHaveCount(1);
    await expect(feed(page).locator("[data-cursor], [data-open]")).toContainText("Shipfast Summit keynote");
  });
});

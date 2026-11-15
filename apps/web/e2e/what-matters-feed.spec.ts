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

const feed = (page: Page) => page.getByTestId("wm-feed");
const line = (page: Page, text: string) => feed(page).locator("[data-thread-id]").filter({ hasText: text });
const scroller = (page: Page) => feed(page).locator('[data-keep-scroll="list"]');

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
  await page.evaluate(() => localStorage.setItem("terno.wm.look", "brief"));
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
    expect(kinds[0]).toBe("#deadlines");
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

  await scenario("a new item arrives while the feed is on screen", async () => {
    await scroller(page).evaluate((el) => (el.scrollTop = 0));
    await item(server, "rent", "Pay the rent", null);
    server.backend.today.changed();
    await expect(line(page, "Pay the rent")).toBeVisible({ timeout: 15_000 });
    await expect(line(page, "Pay the rent")).not.toHaveAttribute("data-history");
  });
});

test("the list look has no history; drawn as the feed, the same What matters has it", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
  await item(server, "payroll", "Wire payroll", null);
  await item(server, "closed-1", "Pay the old bill", E2E_NOW - HOUR);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(page.getByTestId("thread-row").filter({ hasText: "Wire payroll" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("thread-row").filter({ hasText: "Pay the old bill" })).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("terno.wm.look", "brief"));
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(line(page, "Wire payroll")).toBeVisible({ timeout: 15_000 });
  await reach(page, "Pay the old bill");
  await expect(line(page, "Pay the old bill")).toHaveAttribute("data-history", "true");
});

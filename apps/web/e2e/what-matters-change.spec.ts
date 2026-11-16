/**
 * Plan 210 (iteration 4, the owner's "Change…"): an item's day and time, the user's. From the row's right-click menu
 * (beside Later), the reader's line and the palette, the shared date and time form; Earlier says "Changed" while the item
 * is open; a later mail's move of it is a proposal on the reader's line ("Elena says Mon now · Use"); Undo exact; axe in
 * light and dark.
 */
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, expect, focusList, fresh, scenario, test, typeTime, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };
const HOUR = 3_600_000;
/** where screenshots go when asked for (light and dark, en and es: the form, the proposal line) */
const SHOTS = process.env.CHANGE_SHOTS;

const dayKey = (days: number): string => {
  const d = new Date(E2E_NOW);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const moment = (days: number, hour: number): number => {
  const d = new Date(E2E_NOW);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

function message(server: DevServerFixture, key: string, from: { name: string; email: string }, subject: string, text: string, date: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  const db = sqlDb(server.backend.store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  return { accountId: acct.id, providerMsgId: key, providerThreadId: key, rfcMessageId: `<${key}@e2e.test>`, inReplyTo: null, references: [], from, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject, date, snippet: text, bodyText: text, bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200, ...over } as unknown as IncomingMessage;
}

/** a message read by the dated reader as it writes one: its items, the open ones it moves */
async function read(server: DevServerFixture, m: IncomingMessage, rows: { kind: "pay" | "respond"; text: string; days: number }[], moved: { id: number; days: number }[] = []) {
  const store = server.backend.store;
  const db = sqlDb(store);
  await store.sync.ingest([m], { applyFilters: false, now: E2E_NOW, classifier: null });
  const row = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = ?", m.providerMsgId)!;
  await store.dated.marks.queueScan([row.id], E2E_NOW);
  await store.dated.finish({
    messageId: row.id,
    threadId: row.thread_id,
    fromScan: true,
    rows: rows.map((r, i) => ({ kind: r.kind, item: i, text: r.text, quote: `${r.text}.`, dueDay: dayKey(r.days), dueAt: moment(r.days, 9), timed: false, dated: true, actAt: E2E_NOW - HOUR })),
    settled: [],
    moved: moved.map((x) => ({ id: x.id, dueDay: dayKey(x.days), dueAt: moment(x.days, 9), timed: false, actAt: E2E_NOW - HOUR })),
    now: E2E_NOW,
    model: "demo",
    provider: "fake",
    promptVersion: 1,
    clearGeneration: store.dated.clearGeneration(),
  });
  server.backend.today.changed();
  return row.thread_id;
}

const feed = (page: Page) => page.getByTestId("wm-feed");
const openLine = (page: Page, text: string) => feed(page).locator("[data-thread-id]:not([data-history])").filter({ hasText: text });
const historyLine = (page: Page, text: string) => feed(page).locator("[data-history]").filter({ hasText: text });
const snack = (page: Page) => page.getByTestId("snack");
const scroller = (page: Page) => feed(page).locator('[data-keep-scroll="list"]');

/** Down from the top until a line is drawn (the feed draws only what's near the view; the seed's waiting rows come first). */
async function reach(page: Page, text: string, which: (page: Page, text: string) => ReturnType<Page["locator"]> = openLine): Promise<void> {
  await scroller(page).evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(100);
  for (let i = 0; i < 120 && !(await which(page, text).count()); i++) {
    await scroller(page).evaluate((el) => (el.scrollTop += el.clientHeight * 0.7));
    await page.waitForTimeout(80);
  }
  await expect(which(page, text)).toBeVisible();
}
const shot = async (page: Page, name: string, el?: ReturnType<Page["getByTestId"]>) => {
  if (!SHOTS) return;
  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveClass(mode === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    await page.waitForTimeout(150);
    await (el ?? page).screenshot({ path: `${SHOTS}/${name}-${mode}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
};

test("plan 210 (iteration 4): Change… from the row's menu, the reader's line and the palette; Earlier says Changed; a later mail's move is the user's to take; Undo; axe", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
  const store = server.backend.store;
  const lumen = await read(server, message(server, "lumen", { name: "Lumen Billing", email: "billing@lumen.test" }, "Your invoice", "Pay the Lumen invoice.", E2E_NOW - HOUR), [{ kind: "pay", text: "Pay the Lumen invoice", days: 1 }]);
  const elena = { name: "Elena Ruiz", email: "elena@school.test" };
  const slipThread = await read(server, message(server, "slip", elena, "Field trip", "Return the signed field trip slip.", E2E_NOW - 2 * HOUR), [{ kind: "respond", text: "Return the signed field trip slip", days: 3 }]);
  const itemOf = async (thread: number) => (await store.dated.ofThread(thread))[0]!;
  /** the open part's rows and Earlier's "Changed" lines, by id, as the feed reads them (it draws only what's near the view) */
  const lines = async () => {
    const list = await server.backend.today.list([], { history: { through: null } });
    return { open: list.sections.flatMap((s) => s.items.map((i) => i.id)), history: list.history!.items.filter((i) => i.outcome === "changed").map((i) => i.id) };
  };
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(page.getByTestId("wm-feed")).toBeVisible({ timeout: 15_000 });
  await reach(page, "Pay the Lumen invoice");

  await scenario("the row's menu: Change… beside Later opens the shared form; a day and a time move the item; Earlier says Changed; z undoes all of it", async () => {
    const before = await itemOf(lumen);
    await reach(page, "Pay the Lumen invoice");
    await openLine(page, "Pay the Lumen invoice").click({ button: "right" });
    const change = page.getByTestId("menu-dated-change");
    await expect(change).toHaveText(/^Change…⇧B$/);
    // What matters' own group: right after Later
    const entries = await page.locator("[role=menu] [data-testid^=menu-dated]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(entries.indexOf("menu-dated-change")).toBe(entries.indexOf("menu-dated-later") + 1);
    await change.click();
    const dialog = page.getByTestId("today-change-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading")).toHaveText("Change day and time");
    await expect(dialog.getByTestId("today-change-text")).toHaveText("Pay the Lumen invoice");
    // a day alone (the bill has no time): no time field until "At a time"
    await expect(dialog.getByTestId("today-change-time")).toHaveCount(0);
    await dialog.getByTestId("today-change-timed-box").click();
    await expect(dialog.getByTestId("today-change-time")).toBeVisible();
    await axeBothModes(page, "[data-testid=today-change-dialog]");
    await shot(page, "change-dialog-en", dialog);
    await dialog.getByTestId("today-change-date").click();
    await page.getByTestId("today-change-calendar").locator(`button[data-day="${dayKey(5)}"]`).click();
    await typeTime(dialog.getByTestId("today-change-time"), 4, 0, "PM");
    await dialog.getByTestId("today-change-set").click();
    await expect(dialog).toHaveCount(0);
    await expect(snack(page)).toContainText("Changed to");
    await expect(snack(page)).toContainText("Pay the Lumen invoice");
    await expect.poll(async () => (await itemOf(lumen)).dueDay).toBe(dayKey(5));
    expect(await itemOf(lumen)).toMatchObject({ dueAt: moment(5, 16), timed: true, revision: before.revision + 1 });
    // Earlier: "Changed today", the item still open above
    await reach(page, "Pay the Lumen invoice", historyLine);
    await expect(historyLine(page, "Pay the Lumen invoice")).toContainText("Changed today");
    expect((await lines()).open).toContain(`dated:${before.id}`);
    expect((await lines()).history).toEqual([`change:dated:${before.id}`]);
    await focusList(page);
    await page.keyboard.press("z");
    await expect.poll(async () => (await itemOf(lumen)).dueDay).toBe(dayKey(1));
    expect(await itemOf(lumen)).toMatchObject({ dueAt: before.dueAt, timed: false, changedAt: null });
    expect((await lines()).history).toEqual([]);
  });

  await scenario("the reader's line: Change… beside Later, in a popover; its snack's Undo", async () => {
    await reach(page, "Pay the Lumen invoice");
    await openLine(page, "Pay the Lumen invoice").getByTestId("wm-item-open").click();
    const line = page.getByTestId("thread-dated");
    await expect(line).toBeVisible();
    const change = line.getByTestId("thread-dated-change");
    await expect(change).toHaveAccessibleName("Change day and time: Pay the Lumen invoice");
    await change.click();
    const form = page.getByTestId("thread-dated-change-form");
    await expect(form).toBeVisible();
    await shot(page, "change-reader-popover-en");
    await form.getByTestId("thread-dated-change-date").click();
    await page.getByTestId("thread-dated-change-calendar").locator(`button[data-day="${dayKey(2)}"]`).click();
    await form.getByTestId("thread-dated-change-set").click();
    await expect(form).toHaveCount(0);
    await expect.poll(async () => (await itemOf(lumen)).dueDay).toBe(dayKey(2));
    await snack(page).getByRole("button", { name: /Undo/ }).click();
    await expect.poll(async () => (await itemOf(lumen)).dueDay).toBe(dayKey(1));
    await page.keyboard.press("Escape");
  });

  await scenario("a later mail's move of an item the user changed: the user's day stays, the reader's line says Elena's and Use takes it; Undo brings the proposal back", async () => {
    const slip = await itemOf(slipThread);
    await server.backend.server.invoke("today.schedule", { item: { source: "dated", id: slip.id, revision: slip.revision }, to: { day: dayKey(4), time: null } }, dev);
    await read(server, message(server, "slip-2", elena, "Re: Field trip", "Actually Tuesday is better for the slip.", E2E_NOW - HOUR / 2, { providerThreadId: "slip", inReplyTo: "<slip@e2e.test>", references: ["<slip@e2e.test>"] }), [], [{ id: slip.id, days: 6 }]);
    const proposed = await itemOf(slipThread);
    expect(proposed).toMatchObject({ dueDay: dayKey(4), proposal: { dueDay: dayKey(6), by: "Elena Ruiz" } });
    await fresh(page);
    await page.getByTestId("nav-today").click();
    await reach(page, "Return the signed field trip slip");
    await openLine(page, "Return the signed field trip slip").getByTestId("wm-item-open").click();
    const proposal = page.getByTestId("thread-dated-proposal");
    await expect(proposal.getByTestId("thread-dated-proposal-text")).toHaveText(/^Elena says .+ now$/);
    await expect(proposal.getByTestId("thread-dated-proposal-use")).toHaveText("Use");
    await axeBothModes(page, "[data-testid=thread-dated]");
    await shot(page, "change-proposal-en", page.getByTestId("thread-dated"));
    // Use
    await proposal.getByTestId("thread-dated-proposal-use").click();
    await expect.poll(async () => (await itemOf(slipThread)).dueDay).toBe(dayKey(6));
    expect((await itemOf(slipThread)).proposal).toBeNull();
    await expect(page.getByTestId("thread-dated-proposal")).toHaveCount(0);
    // its Undo: back on the user's day, the proposal offered again
    await focusList(page);
    await page.keyboard.press("z");
    await expect.poll(async () => (await itemOf(slipThread)).dueDay).toBe(dayKey(4));
    expect((await itemOf(slipThread)).proposal).toMatchObject({ dueDay: dayKey(6) });
    await expect(page.getByTestId("thread-dated-proposal")).toBeVisible();
  });

  await scenario("the palette: Change day and time… for the open item opens the same form; Esc leaves it as it was", async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-dated-change").click();
    const dialog = page.getByTestId("today-change-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("today-change-text")).toHaveText("Return the signed field trip slip");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await itemOf(slipThread)).toMatchObject({ dueDay: dayKey(4) });
  });

  await scenario("in Spanish: the reader's Cambiar…, the proposal's words and Usar, the form's title", async () => {
    await server.backend.server.invoke("settings.update", { language: "es" }, dev);
    await fresh(page);
    await page.getByTestId("nav-today").click();
    await reach(page, "Return the signed field trip slip");
    await openLine(page, "Return the signed field trip slip").getByTestId("wm-item-open").click();
    const proposal = page.getByTestId("thread-dated-proposal");
    await expect(proposal.getByTestId("thread-dated-proposal-text")).toHaveText(/^Elena ahora dice .+$/);
    await expect(proposal.getByTestId("thread-dated-proposal-use")).toHaveText("Usar");
    await expect(page.getByTestId("thread-dated-change")).toHaveText("Cambiar…");
    await shot(page, "change-proposal-es", page.getByTestId("thread-dated"));
    await page.getByTestId("thread-dated-change").click();
    await expect(page.getByTestId("thread-dated-change-timed")).toHaveText("A una hora");
    await shot(page, "change-reader-popover-es");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-dated-change").click();
    const dialog = page.getByTestId("today-change-dialog");
    await expect(dialog.getByRole("heading")).toHaveText("Cambiar día y hora");
    await shot(page, "change-dialog-es", dialog);
    await page.keyboard.press("Escape");
    await server.backend.server.invoke("settings.update", { language: "en" }, dev);
  });
});

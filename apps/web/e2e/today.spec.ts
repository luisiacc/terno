/**
 * Plan 145 in the page, on the offline fake model. What matters for anyone with a provider, nothing without one; its
 * items under their groups' headings; the digest's way in, off and on; Archive all and its Undo. Plan 210: What matters
 * is the feed (the owner made it the only view), so these read its items.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { inEveryLook, wheelsTo } from "./helpers/looks";
import { unclipped } from "./helpers/unclipped";
import { DIGEST, digestRow } from "./helpers/today";
import { axeBothModes, expect, focusList, fresh, ingestConversation, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };
const SHOTS = process.env.TODAY_SHOTS;

const FEED = "[data-testid=wm-feed]";
/** plan 251: the digest's list beside a newsletter it opened (Split), where the feed was: the digest's way back is open */
const BESIDE = "[data-testid=digest-page][data-place=column]";
/** the feed's scroller */
const feedList = (page: Page) => page.locator(`${FEED} [data-keep-scroll="list"]`);
/** an open item of the feed (not a history line), by its words (its sentence, or who and what's next under it) */
const item = (page: Page, text: string | RegExp) => page.locator(`${FEED} [data-testid=wm-item]:not([data-history])`).filter({ hasText: text });
const toTop = (page: Page) => feedList(page).evaluate((el) => { el.scrollTop = 0; });
const toEnd = (page: Page) => feedList(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });

interface FeedRow {
  heading: string | null;
  text: string;
  id: string | null;
  digest: boolean;
  history: boolean;
  /** plan 210: one of Coming up's, under its day */
  ahead: boolean;
}

/** Every row of the feed in order, from its top to its end (it draws only what's near the view): a heading's kind, or an item. */
async function walk(page: Page): Promise<FeedRow[]> {
  const seen = new Map<number, FeedRow>();
  await toTop(page);
  for (let i = 0, still = 0; i < 200 && still < 2; i++) {
    await page.waitForTimeout(60);
    const rows = await page.locator(`${FEED} [data-index]`).evaluateAll((els) =>
      els.map((e) => {
        const h = e.querySelector("[data-testid=wm-heading]");
        const it = e.querySelector("[data-testid=wm-item]");
        return { index: Number(e.getAttribute("data-index")), heading: h?.getAttribute("data-kind") ?? null, text: (it?.textContent ?? "").trim(), id: it?.getAttribute("data-thread-id") ?? null, digest: !!it?.hasAttribute("data-digest"), history: !!it?.hasAttribute("data-history"), ahead: !!it?.hasAttribute("data-ahead") };
      }),
    );
    for (const { index, ...r } of rows) seen.set(index, r);
    const end = await feedList(page).evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
    still = end ? still + 1 : 0;
    await feedList(page).evaluate((el) => { el.scrollTop += el.clientHeight * 0.7; });
  }
  await toTop(page);
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}
/** the feed's headings, top to bottom */
const kinds = async (page: Page) => (await walk(page)).flatMap((r) => (r.heading ? [r.heading] : []));
/** the heading an item is under, or "gone" */
async function groupOf(page: Page, text: string): Promise<string | null> {
  let under: string | null = null;
  for (const r of await walk(page)) {
    if (r.heading) under = r.heading;
    // plan 210: Coming up's rows sit under their day's heading: said as Coming up's
    else if (!r.history && r.text.includes(text)) return r.ahead ? "comingUp" : under;
  }
  return "gone";
}

/**
 * An item wherever it is: from the top, down until it's in the feed's view (an item just drawn where the feed was before
 * the scroll can still be in the DOM for a frame, so being there isn't enough).
 */
async function show(page: Page, text: string) {
  await toTop(page);
  const inView = () =>
    item(page, text)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const box = el.closest('[data-keep-scroll="list"]')!.getBoundingClientRect();
        return r.top >= box.top && r.bottom <= box.bottom;
      }, undefined, { timeout: 500 })
      .catch(() => false);
  // down half a screen at a time; from the end, round again (the item may come with a reload)
  for (let i = 0; i < 80 && !(await inView()); i++) {
    await feedList(page).evaluate((el) => { el.scrollTop = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 ? 0 : el.scrollTop + el.clientHeight / 2; });
    await page.waitForTimeout(50);
  }
  expect(await inView()).toBe(true);
}

async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  await server.backend.server.invoke("settings.update", patch, dev);
  await fresh(page);
}

/** a person waiting, and newsletters the demo's fixture doesn't hold */
async function withMail(server: DevServerFixture, more = 0) {
  await ingestConversation(server, { subject: "Can you make the 19th", count: 1, now: E2E_NOW });
  const db = sqlDb(server.backend.store);
  const waiting = db.get<{ id: number }>("SELECT id FROM threads WHERE subject = ?", "Can you make the 19th")!.id;
  db.run("UPDATE threads SET waiting_since = ?, last_date = ?, has_sent = 1 WHERE id = ?", E2E_NOW - 1000, E2E_NOW + 60_000, waiting);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const letter = (i: number, from: string, subject: string): IncomingMessage => ({
    accountId: acct.id, providerMsgId: `nl-${i}`, providerThreadId: `nl-${i}`, rfcMessageId: `<nl-${i}@e2e.test>`, inReplyTo: null, references: [], from: { name: from, email: `news@${from.toLowerCase().replace(/\s/g, "")}.test` }, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject, date: E2E_NOW - 3600_000 - i, snippet: `Issue ${i}`, bodyText: `Issue ${i} says something.`, bodyHtml: null, bodyState: "full", listId: `list-${i}`, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 2000,
  }) as unknown as IncomingMessage;
  // plan 162 (after ai162-r02): more newsletters where a test needs a page to scroll and several to open
  const extra = Array.from({ length: more }, (_, i) => letter(10 + i, `Weekly ${String.fromCharCode(65 + i)}`, `Weekly ${String.fromCharCode(65 + i)} issue`));
  await server.backend.store.sync.ingest([letter(1, "Stratechery", "Stratechery weekly"), letter(2, "Morning Brew", "Morning Brew digest"), letter(3, "Acme Store", "Sale ends tonight"), ...extra], { applyFilters: false, now: E2E_NOW, classifier: null });
  db.run("UPDATE threads SET person = 0 WHERE subject IN ('Stratechery weekly','Morning Brew digest','Sale ends tonight') OR subject LIKE 'Weekly % issue'");
  db.run("UPDATE messages SET created_at = ? WHERE subject IN ('Stratechery weekly','Morning Brew digest','Sale ends tonight') OR subject LIKE 'Weekly % issue'", E2E_NOW - 3600_000);
  // plan 166: a new conversation from someone you write to, not answered: "Waiting for your reply"
  await server.backend.store.sync.ingest([{ ...letter(90, "Marta Ruiz", "Lunch on Friday?"), from: { name: "Marta Ruiz", email: "marta@ruiz.test" }, listId: null, snippet: "Are you free on Friday?", bodyText: "Are you free on Friday?" } as unknown as IncomingMessage], { applyFilters: false, now: E2E_NOW, classifier: null });
  const fresh = db.get<{ id: number }>("SELECT id FROM threads WHERE subject = ?", "Lunch on Friday?")!.id;
  db.run("UPDATE threads SET waiting_since = ?, last_date = ?, has_sent = 0, person = 1 WHERE id = ?", E2E_NOW - 2000, E2E_NOW + 30_000, fresh);
  db.run("INSERT INTO correspondents (email, own, written) VALUES ('marta@ruiz.test', 0, 1) ON CONFLICT(email) DO UPDATE SET written = 1, own = 0");
  return { waiting, db };
}

test.describe("What matters and its digest (plan 145)", () => {
  test("plan 162: the digest's provenance is whole and its header stays as the list scrolls, in every design, light and dark, 1440 and 1100", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.getByTestId("nav-today").click();
    await expect(await digestRow(page)).toContainText("today's digest", { timeout: 15_000 });
    await (await digestRow(page)).click();
    await expect(page.getByTestId("digest-title")).toHaveText("Today's digest");
    await inEveryLook(page, async (where) => {
      await page.getByTestId("digest-provenance").click();
      const popover = page.getByTestId("digest-provenance-popover");
      await expect(popover, where).toBeVisible();
      expect(await unclipped(popover), where).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(popover, where).toHaveCount(0);
      // the last row reaches the wheel, and Archive is still in view when it does
      expect(await wheelsTo(page, page.getByTestId("digest-scroller"), page.getByTestId("digest-item").last()), where).toBe(true);
      await expect(page.getByTestId("digest-archive"), where).toBeInViewport();
      await page.getByTestId("digest-scroller").evaluate((el) => { el.scrollTop = 0; });
    });
  });

  test("without a provider there's no row, and no palette entry", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "none" } });
    await expect(page.getByTestId("nav-inbox")).toBeVisible();
    await expect(page.getByTestId("nav-today")).toHaveCount(0);
  });

  test("What matters opens on its groups, a person's own words, the digest's way in its last item, and the digest reads beside it", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    // the app still opens on the Inbox
    await expect(page.getByTestId("list-title").or(page.getByTestId("list-header")).first()).toBeVisible();
    await page.getByTestId("nav-today").click();
    // plan 210 (the owner): by day: what needs you now is Today's; with only people waiting on you, their heading leads
    // (no empty Today above it, the owner 2026-11-19)
    const first = page.locator(`${FEED} [data-testid=wm-heading]`).first();
    await expect(first).toHaveAttribute("data-kind", "waiting");
    await expect(first).toHaveText("Waiting on you");
    // plan 204 (after the panel): the digest's way in is the last open item, never before a person, under no heading of
    // its own; its count where an item's sentence is, what it holds under it in general words (plan 210, iteration 1: never
    // senders' names, which read as people the feed already shows)
    const entry = await digestRow(page);
    await expect(entry.getByTestId("wm-sentence")).toContainText(/\d+ /, { timeout: 15_000 });
    await expect(entry.getByTestId("wm-meta")).toHaveText("Newsletters and notifications");
    await expect(entry).not.toHaveAttribute("data-thread-id");
    const rows = await walk(page);
    const at = rows.findIndex((r) => r.digest);
    expect(at).toBeGreaterThan(0);
    expect(rows.slice(at + 1).every((r) => r.history || r.heading === "history")).toBe(true);
    expect(rows.slice(0, at).some((r) => r.id !== null)).toBe(true);
    await expect(page.locator(`${FEED} [data-testid=wm-heading]`).filter({ hasText: /Newsletters|Automated/ })).toHaveCount(0);
    if (SHOTS) {
      for (const mode of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await toEnd(page);
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-digest-end-${mode}.png` });
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
    await toTop(page);
    await show(page, "Can you make the 19th");
    // plan 166: an item leads with its own words: no "Your turn: they replied ·" before them
    await expect(item(page, "Can you make the 19th")).not.toContainText("Your turn");
    // pass 3: one sentence, never a second total to read against the Inbox's; plan 210 (iteration 3): by when and who, "1
    // missed · 3 today · 5 waiting", and the sidebar's badge is their sum
    await expect(page.getByTestId("today-needs")).toHaveText(/^(?:\d+ missed|\d+ to do today|\d+ waiting)(?: · (?:\d+ to do today|\d+ waiting))*$/);
    const sidebar = (await page.getByTestId("nav-today").innerText()).match(/\d+/)?.[0];
    const said = [...(await page.getByTestId("today-needs").innerText()).matchAll(/(\d+) (?:missed|to do today|waiting)/g)].reduce((n, m) => n + Number(m[1]), 0);
    if (sidebar) expect(Number(sidebar)).toBe(said);
    await expect(page.getByTestId("today-line")).not.toContainText(/this week|\d+ to reply/);
    // the owner: "Your turn" and "Waiting for your reply" are the same thing: one heading, and the new conversation is
    // under it in its own words, no reason before them. Plan 210 (iteration 3, the owner's "'Waiting on you' in Today"):
    // people waiting on you are Today's quiet "Waiting on you"; with nothing else today, no empty Today heading above it
    // (the owner, 2026-11-19)
    expect((await kinds(page)).filter((k) => k !== "history")).toEqual(["waiting"]);
    const waitingHeading = page.locator(`${FEED} [data-testid=wm-heading][data-kind=waiting]`);
    await expect(waitingHeading).toHaveText("Waiting on you");
    // a sub-heading on the rows' text line, as the headings are
    await show(page, "Lunch on Friday?");
    const textLeft = async (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
    expect(Math.abs((await textLeft(waitingHeading)) - (await textLeft(item(page, "Lunch on Friday?").getByTestId("wm-sentence"))))).toBeLessThanOrEqual(1);
    await show(page, "Lunch on Friday?");
    const lunch = item(page, "Lunch on Friday?");
    await expect(lunch.getByTestId("wm-sentence")).toContainText("Lunch on Friday?");
    await expect(lunch.getByTestId("wm-meta")).toHaveText("Marta Ruiz");
    await expect(lunch).not.toContainText("Your turn");
    await expect(await digestRow(page)).toContainText("automated");
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dark.png` });
    }
    for (const mode of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      const results = await new AxeBuilder({ page }).include(FEED).analyze();
      expect(results.violations.map((v) => `${mode} ${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
    }
    // a heading sits on its items' text line
    await toTop(page);
    const left = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
    expect(Math.abs((await left(first)) - (await left(page.locator(`${FEED} [data-testid=wm-sentence]`).first())))).toBeLessThanOrEqual(1);
    await (await digestRow(page)).click();
    await expect(page.locator(DIGEST)).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("digest-page")).toBeVisible();
    await expect(page.getByTestId("digest-title")).toHaveText("Automated mail");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-digest-off.png` });
    // plan 247 (Codex code review): the way to turn the digest on opens What matters' section at its switch
    await page.getByTestId("digest-turn-on").click();
    await expect(page.getByTestId("tab-whatMatters")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("ai-digest-switch")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    // plan 235: ticked rows' senders can be hidden from the foot, and each row has a menu (⇧F10 on it) for the ticked rows
    const digestRows = page.getByTestId("digest-item");
    expect(await digestRows.count()).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("digest-hide")).toHaveCount(0);
    // Shift with a tick takes the rows between, and selects no text on the way
    await digestRows.nth(0).getByTestId("digest-tick").click();
    await digestRows.nth(2).getByTestId("digest-tick").click({ modifiers: ["Shift"] });
    for (const n of [0, 1, 2]) await expect(digestRows.nth(n).getByTestId("digest-tick")).toBeChecked();
    expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
    // and the tick pressed has the focus, so Space is that one's (Codex review)
    await expect(digestRows.nth(2).getByTestId("digest-tick")).toBeFocused();
    await digestRows.nth(2).getByTestId("digest-tick").click();
    await expect(page.getByTestId("digest-hide")).toHaveText(/^Hide (sender|2 senders)$/);
    await digestRows.nth(0).getByTestId("digest-open").focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByTestId("digest-item-menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Open", "Archive 2", /^Hide (sender|2 senders)$/]);
    // what Hide does to mail still to come, on its help icon's hover
    await menu.getByTestId("digest-menu-hide-help").hover();
    await expect(page.locator("[data-slot=tooltip-content]")).toContainText("now and in the future");
    // plan 247 (Codex code review): where to let them back in
    await expect(page.locator("[data-slot=tooltip-content]")).toContainText("Settings → What matters → Once a day");
    // and by the keys alone: the pointer away, the arrows reach Hide and its help shows (a keyboard has no hover)
    await page.mouse.move(0, 0);
    await expect(page.locator("[data-slot=tooltip-content]")).toHaveCount(0);
    const hideItem = menu.getByTestId("digest-menu-hide");
    for (let n = 0; n < 4 && !(await hideItem.evaluate((el) => el === document.activeElement)); n++) await page.keyboard.press("ArrowDown");
    await expect(hideItem).toBeFocused();
    await expect(page.locator("[data-slot=tooltip-content]")).toContainText("now and in the future");
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-automated-menu-${mode}.png` });
      const results = await new AxeBuilder({ page }).include("[data-testid=digest-scroller]").include("[data-testid=digest-item-menu]").analyze();
      expect(results.violations.map((v) => `${mode} ${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
    }
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // plan 286: every sender hidden leaves nothing to review: clear skies, axe-clean both ways, the × where it was
    const closeAt = await page.getByTestId("digest-close").boundingBox();
    await page.getByTestId("digest-tick-all").click();
    await expect(page.getByTestId("digest-tick-all")).toHaveText("Tick all");
    await page.getByTestId("digest-tick-all").click();
    await page.getByTestId("digest-hide").click();
    const clear = page.locator("[data-testid=digest-page][data-empty]");
    await expect(clear).toContainText("Clear skies.");
    expect(await page.getByTestId("digest-close").boundingBox()).toEqual(closeAt);
    await axeBothModes(page, "[data-testid=digest-page]");
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-automated-clear-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-automated-clear-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
    }
    // its × at the top right closes it as Esc does: the feed has the room again, with no way in left (nothing automated)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-automated-close.png` });
    await page.getByTestId("digest-close").click();
    await expect(page.getByTestId("digest-page")).toHaveCount(0);
    await expect(page.locator(FEED)).toBeVisible();
    await expect(page.locator(DIGEST)).toHaveCount(0);
  });

  test("plan 166: Not a newsletter, by the row's control or its menu, leaves the digest at once with an exact Undo, and Settings lists the sender to let back in", async ({ app: page, server }) => {
    const { db } = await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.getByTestId("nav-today").click();
    await expect(await digestRow(page)).toContainText("today's digest", { timeout: 15_000 });
    await (await digestRow(page)).click();
    await expect(page.getByTestId("digest-title")).toHaveText("Today's digest");
    const strat = page.getByTestId("digest-item").filter({ hasText: "Stratechery" });
    const count = await page.getByTestId("digest-item").count();
    await expect(page.getByTestId("digest-archive")).toHaveText(`Archive ${count}`);
    // quiet at rest: the date shows, the control doesn't; on the row's hover it takes the date's place, the chevron unmoved
    const control = strat.getByTestId("digest-not-newsletter");
    await page.mouse.move(0, 0);
    await expect(control).toHaveCSS("opacity", "0");
    await expect(strat.getByTestId("digest-date")).toBeVisible();
    const chevron = async () => (await strat.getByTestId("digest-open").locator("svg").last().boundingBox())!.x;
    const before = await chevron();
    await strat.hover();
    await expect(control).toHaveCSS("opacity", "1");
    await expect(strat.getByTestId("digest-date")).toBeHidden();
    expect(await chevron()).toBe(before);
    await control.hover();
    await expect(page.locator("[data-slot=tooltip-content]")).toHaveText("Not a newsletter");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-not-newsletter-hover.png` });
    await control.click();
    // at once: gone from the page, the batch and the way in; nothing opened or read
    await expect(strat).toHaveCount(0);
    await expect(page.getByTestId("digest-archive")).toHaveText(`Archive ${count - 1}`);
    await expect(await digestRow(page)).toContainText(`${count - 1} newsletter`);
    await expect(page.locator(BESIDE)).toHaveCount(0);
    expect(db.get<{ u: number }>("SELECT unread_count u FROM threads WHERE subject = ?", "Stratechery weekly")!.u).toBe(1);
    const snack = page.getByTestId("snack").filter({ hasText: "Stratechery won't be in your digest" });
    await expect(snack).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-not-newsletter-done.png` });
    // the keys stay on the page
    await expect(page.locator("[data-digest-open]:focus, [data-testid=digest-title]:focus")).toHaveCount(1);
    await snack.getByTestId("snack-action").click();
    await expect(strat).toHaveCount(1);
    await expect(page.getByTestId("digest-archive")).toHaveText(`Archive ${count}`);
    // the row's menu does the same, and Settings lists who's kept out
    // (the demo's own Morning Brew writes from another address: only this sender goes)
    const others = await page.getByTestId("digest-item").filter({ hasText: "Morning Brew" }).count();
    await page.getByTestId("digest-item").filter({ hasText: "Morning Brew digest" }).click({ button: "right" });
    await expect(page.getByTestId("digest-menu-open")).toHaveText("Open");
    await page.getByTestId("digest-menu-not-newsletter").click();
    await expect(page.getByTestId("digest-item").filter({ hasText: "Morning Brew digest" })).toHaveCount(0);
    await expect(page.getByTestId("digest-item").filter({ hasText: "Morning Brew" })).toHaveCount(others - 1);
    // the page's keys are back (the menu went with its row)
    await page.keyboard.press("j");
    await expect(page.locator("[data-digest-open]:focus")).toHaveCount(1);
    await page.getByTestId("open-settings").click();
    // plan 247: the digest's settings are What matters' (Once a day)
    await page.getByTestId("tab-whatMatters").click();
    const excluded = page.getByTestId("ai-digest-excluded");
    await expect(excluded).toContainText("Senders left out");
    await expect(excluded.getByTestId("ai-digest-excluded-item")).toHaveText(["Morning Brewnews@morningbrew.test"]);
    await excluded.scrollIntoViewIfNeeded();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-not-newsletter-settings.png` });
    for (const mode of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      const results = await new AxeBuilder({ page }).include("[data-testid=ai-digest]").analyze();
      expect(results.violations.map((v) => `${mode} ${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
    }
    // by keyboard: the last one gone, the keys land on the digest's switch, not the dialog (Codex review)
    await excluded.getByTestId("ai-digest-excluded-remove").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ai-digest-excluded")).toHaveCount(0);
    await expect(page.getByTestId("ai-digest-switch")).toBeFocused();
    await expect(page.getByTestId("snack").filter({ hasText: "Morning Brew can be in the digest again" })).toBeVisible();
    // plan 247 (iteration 2): seven left out show the newest four and +3 more, which opens the rest by keyboard and folds
    // them back, focus staying on it; axe in light and dark both ways
    const senders = Array.from({ length: 7 }, (_, i) => ({ email: `list${i}@lists.test`, name: `List ${i}` }));
    await server.backend.server.invoke("today.notNewsletter", { senders }, { clientId: "setup", origin: "dev" as const });
    await page.getByTestId("tab-general").click();
    await page.getByTestId("tab-whatMatters").click();
    await expect(excluded.getByTestId("ai-digest-excluded-item")).toHaveCount(4);
    const more = excluded.getByTestId("ai-digest-excluded-more");
    await expect(more).toHaveText("+3 more");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.scrollIntoViewIfNeeded();
    if (SHOTS) for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await page.getByTestId("ai-digest").screenshot({ path: `${SHOTS}/${test.info().project.name}-left-out-folded-${mode}.png` });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await axeBothModes(page, "[data-testid=ai-digest]");
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(excluded.getByTestId("ai-digest-excluded-item")).toHaveCount(7);
    await expect(more).toHaveText("Show fewer");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(more).toBeFocused();
    await axeBothModes(page, "[data-testid=ai-digest]");
    await page.keyboard.press("Enter");
    await expect(excluded.getByTestId("ai-digest-excluded-item")).toHaveCount(4);
    await expect(more).toBeFocused();
  });

  test("the digest off lists unticked and sends nothing; on, it sorts them, Archive all has one Undo", async ({ app: page, server }) => {
    const { db } = await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.getByTestId("nav-today").click();
    await expect(await digestRow(page)).toContainText("today's digest", { timeout: 15_000 });
    await (await digestRow(page)).click();
    await expect(page.getByTestId("digest-title")).toHaveText("Today's digest");
    // pass 3: who wrote the lines, at the top, as every AI result says it; the model is its detail, and the foot holds none
    await expect(page.getByTestId("digest-provenance")).toHaveText("Written with AI");
    expect((await page.getByTestId("digest-provenance").boundingBox())!.y).toBeLessThan((await page.getByTestId("digest-item").first().boundingBox())!.y);
    await page.getByTestId("digest-provenance").click();
    await expect(page.getByTestId("digest-provenance-detail")).toContainText(/Written by .+\. It can make mistakes\./);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("digest-provenance-detail")).toHaveCount(0);
    await page.mouse.move(0, 0);
    // the sale isn't a newsletter, so it isn't here or in Archive all
    await expect(page.getByTestId("digest-item").filter({ hasText: "Stratechery" })).toHaveCount(1);
    await expect(page.getByTestId("digest-item").filter({ hasText: "Acme Store" })).toHaveCount(0);
    const count = await page.getByTestId("digest-item").count();
    await expect(page.getByTestId("digest-archive")).toHaveText(`Archive ${count}`);
    // plan 161: each row names its issue, so two of one newsletter are told apart
    await expect(page.getByTestId("digest-item").filter({ hasText: "Stratechery" }).getByTestId("digest-subject")).toHaveText("Stratechery weekly");
    for (const item of await page.getByTestId("digest-item").all()) {
      if (!/Morning Brew digest/.test(await item.innerText())) await item.getByTestId("digest-tick").click();
    }
    // pass 2: the button's number is what goes, and the line says what stays
    await expect(page.getByTestId("digest-archive")).toHaveText("Archive 1");
    await expect(page.getByTestId("digest-count")).toContainText(`1 to archive · ${count - 1} ${count - 1 === 1 ? "stays" : "stay"} in Inbox`);
    await expect(page.getByTestId("digest-tick-hint")).toHaveText("Archive moves the ticked newsletters out of your Inbox. Any you untick or open stay.");
    await expect(page.getByTestId("digest-item").filter({ hasText: "Stratechery" }).getByTestId("digest-state")).toHaveText("Stays in Inbox");
    // a 24 px box of its own
    const box = (await page.getByTestId("digest-tick").first().boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
    // by keyboard too: a named control, and it's what's kept
    await page.getByTestId("digest-tick").last().focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("digest-archive")).not.toHaveText("Archive 1");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("digest-archive")).toHaveText("Archive 1");
    // plan 161: opening a source and coming back keeps what was unticked. Pass 2: Esc is the way back, and the row
    // opened says it stays (it's read: plan 145 archives only unread mail)
    await page.getByTestId("digest-item").filter({ hasText: "Stratechery" }).getByTestId("digest-open").click();
    await expect(page.locator(BESIDE)).toBeVisible();
    await expect(page.getByTestId("reader-subject")).toHaveText("Stratechery weekly");
    // read after the reader's dwell, as a person reading it would
    await expect.poll(() => db.get<{ u: number }>("SELECT unread_count u FROM threads WHERE subject = ?", "Stratechery weekly")!.u).toBe(0);
    // the owner (plan 161): a newsletter from the digest is mail like any other. Read, it isn't added to Today's list, nor
    // pinned there while it's open. Plan 162 (after ai162-r02): the digest's way in counts what's still in the Inbox, read
    // or not, as its page lists them (it counted the unread: "1 newsletter" beside four)
    server.backend.notifyChanged([]);
    await expect(await digestRow(page)).toContainText(new RegExp(`(^|\\D)${count} newsletters? · today's digest`));
    await expect(item(page, "Stratechery weekly")).toHaveCount(0);
    await expect(page.getByTestId("reader-subject")).toHaveText("Stratechery weekly");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("digest-page")).toBeVisible();
    await expect(page.getByTestId("digest-item").filter({ hasText: "Stratechery" }).getByTestId("digest-open")).toBeFocused();
    await expect(page.getByTestId("digest-item").filter({ hasText: "Morning Brew digest" }).getByTestId("digest-tick")).toBeChecked();
    await expect(page.getByTestId("digest-item").filter({ hasText: "Stratechery" }).getByTestId("digest-state")).toHaveText("Opened · stays in Inbox");
    await expect(page.getByTestId("digest-archive")).toHaveText("Archive 1");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/digest-on.png` });
    await page.getByTestId("digest-archive").click();
    await expect(page.getByTestId("snack")).toContainText("Archived 1 newsletter");
    // pass 2: what it archived leaves the page, which says it's done; the rest stays, each saying why
    await expect(page.getByTestId("digest-done")).toHaveText("Archived 1 newsletter.");
    await expect(page.getByTestId("digest-item").filter({ hasText: "Morning Brew digest" })).toHaveCount(0);
    await expect(page.getByTestId("digest-item")).toHaveCount(count - 1);
    await expect(page.getByTestId("digest-still-here")).toHaveText("Still in your Inbox");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/digest-done.png` });
    const inbox = (subject: string) => db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE subject = ?", subject)!.in_inbox;
    await expect.poll(() => inbox("Morning Brew digest")).toBe(0);
    expect(inbox("Stratechery weekly")).toBe(1);
    expect(inbox("Sale ends tonight")).toBe(1);
    // its Undo is the snack's while the snack shows (plan 162: one at a time; the page's comes when the snack goes)
    await expect(page.getByTestId("digest-undo")).toHaveCount(0);
    await page.getByTestId("snack").filter({ hasText: "Archived 1 newsletter" }).getByTestId("snack-action").click();
    await expect.poll(() => inbox("Morning Brew digest")).toBe(1);
    // the open page hears it: back in the list and the count, and done no more
    await expect(page.getByTestId("digest-item").filter({ hasText: "Morning Brew digest" })).toHaveAttribute("data-live", "true");
    await expect(page.getByTestId("digest-done")).toHaveCount(0);
    await expect(page.getByTestId("digest-archive")).toHaveText("Archive 1");
    // plan 161: leaving Today takes the way back with it
    await page.getByTestId("digest-item").filter({ hasText: "Stratechery" }).getByTestId("digest-open").click();
    await expect(page.locator(BESIDE)).toBeVisible();
    await page.getByTestId("nav-inbox").click();
    await page.getByTestId("thread-row").first().click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(page.locator(BESIDE)).toHaveCount(0);
  });

  test("owner's decisions (2): Archive, e, Trash and Spam on a newsletter opened from the digest go back to it, where it was, with Undo", async ({ app: page, server }) => {
    const { db } = await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    // short, so the digest scrolls and where it was can be held (348: plan 250's shell keeps 8 px above and below the
    // panes, so the reader keeps the 340 px this was written for; at 332 the row's focus nudge alone is 18 px)
    await page.setViewportSize({ width: 1100, height: 348 });
    await page.getByTestId("nav-today").click();
    await expect(await digestRow(page)).toContainText("today's digest", { timeout: 15_000 });
    await (await digestRow(page)).click();
    await expect(page.getByTestId("digest-title")).toHaveText("Today's digest");
    const scroller = page.getByTestId("digest-scroller");
    const item = page.getByTestId("digest-item").filter({ hasText: "Stratechery" });
    const where = () => db.get<{ in_inbox: number; in_trash: number; in_spam: number }>("SELECT in_inbox, in_trash, in_spam FROM threads WHERE subject = ?", "Stratechery weekly")!;
    const ways = [
      { how: "the toolbar's Archive", run: () => page.getByTestId("action-archive").click(), said: /^Archived/, row: "Archived", gone: { in_inbox: 0 } },
      { how: "e", run: () => page.keyboard.press("e"), said: /^Archived/, row: "Archived", gone: { in_inbox: 0 } },
      { how: "Trash", run: () => page.getByTestId("action-trash").click(), said: /^Moved to Trash/, row: "Moved to Trash", gone: { in_trash: 1 } },
      { how: "Spam", run: () => page.getByTestId("action-spam").click(), said: /as spam/, row: "Marked as spam", gone: { in_spam: 1 } },
    ];
    for (const way of ways) {
      await scenario(`${way.how}: back on the digest, scrolled where it was, on the row it came from, and Undo opens it again`, async () => {
        await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
        const top = await scroller.evaluate((el) => el.scrollTop);
        expect(top).toBeGreaterThan(0);
        await item.getByTestId("digest-open").click();
        await expect(page.locator(BESIDE)).toBeVisible();
        await expect(page.getByTestId("reader-subject")).toHaveText("Stratechery weekly");
        // read, as a person reading it (an unread one comes back unread, and ticked)
        await expect.poll(() => db.get<{ u: number }>("SELECT unread_count u FROM threads WHERE subject = ?", "Stratechery weekly")!.u).toBe(0);
        await way.run();
        // not on to Today's first conversation: the digest, as it was left
        await expect(page.getByTestId("digest-page")).toBeVisible();
        await expect(page.getByTestId("reader-subject")).toHaveCount(0);
        await expect(item.getByTestId("digest-open")).toBeFocused();
        // plan 162 (after ai162-r02): the page keeps its place as the newsletter opens, once the row's focus has cleared the
        // foot bar (scroll-padding-bottom), so where it was is held within that nudge
        expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - top)).toBeLessThanOrEqual(12);
        // the row says what happened to it, and the snack has the usual Undo
        await expect(item).toHaveAttribute("data-state", "archived");
        await expect(item.getByTestId("digest-state")).toHaveText(way.row);
        await expect(page.getByTestId("snack")).toContainText(way.said);
        await expect.poll(where).toMatchObject(way.gone);
        await page.getByTestId("snack-action").click();
        await expect.poll(where).toMatchObject({ in_inbox: 1, in_trash: 0, in_spam: 0 });
        // exact: the newsletter open again, still from the digest
        await expect(page.getByTestId("reader-subject")).toHaveText("Stratechery weekly");
        await expect(page.locator(BESIDE)).toBeVisible();
        await page.getByTestId("reader-close").click();
        await expect(item.getByTestId("digest-open")).toBeFocused();
        await expect(item).toHaveAttribute("data-state", "opened");
      });
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/digest-after-reader-archive.png` });
    // anything else from there is as before: a conversation of What matters' own goes on as it always has (above, the
    // digest's item being the last open one)
    await show(page, "Can you make the 19th");
    await page.locator(`${FEED} [data-testid=wm-item]`).filter({ hasText: "Can you make the 19th" }).click();
    await expect(page.locator(BESIDE)).toHaveCount(0);
  });

  test("plan 162 (after ai162-r02): every way back keeps an opened newsletter out of Archive, at once; the page has the list's keys", async ({ app: page, server }) => {
    const { db } = await withMail(server, 10);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.getByTestId("nav-today").click();
    await expect(await digestRow(page)).toContainText("today's digest", { timeout: 15_000 });
    // what's waiting on you leads the feed (nothing else today: no empty Today heading); the digest's way in is its last
    // open item (plan 204, after the panel)
    await toTop(page);
    await expect(page.locator(`${FEED} [data-testid=wm-heading]`).first()).toHaveAttribute("data-kind", "waiting");
    await (await digestRow(page)).click();
    await expect(page.getByTestId("digest-title")).toHaveText("Today's digest");
    const items = page.getByTestId("digest-item");
    const total = await items.count();
    expect(total).toBeGreaterThanOrEqual(8);
    const unread = (subject: string) => db.get<{ u: number }>("SELECT unread_count u FROM threads WHERE subject = ?", subject)!.u;
    const subjectOf = async (i: number) => (await items.nth(i).getByTestId("digest-subject").innerText()).trim();
    let kept = 0;

    await scenario("opened from the feed, the keys go into the page: its first row is the cursor; j, k and x are its own", async () => {
      await expect(page.getByTestId("digest-open").first()).toBeFocused();
      // j and k move through its rows, never the feed's behind it; x ticks the cursor's row
      await page.keyboard.press("j");
      await page.keyboard.press("j");
      await expect(page.getByTestId("digest-open").nth(2)).toBeFocused();
      await page.keyboard.press("k");
      await expect(page.getByTestId("digest-open").nth(1)).toBeFocused();
      await expect(page.getByTestId("digest-page")).toBeVisible();
      await page.keyboard.press("x");
      await expect(items.nth(1).getByTestId("digest-tick")).not.toBeChecked();
      await expect(page.getByTestId("digest-archive")).toHaveText(`Archive ${total - 1}`);
      await page.keyboard.press("x");
      await expect(page.getByTestId("digest-archive")).toHaveText(`Archive ${total}`);
    });

    await scenario("each way back, straight back (under the reader's dwell): the row opened stays, said so, and isn't counted", async () => {
      const ways: [string, () => Promise<void>][] = [
        ["Enter, then Esc", async () => page.keyboard.press("Escape")],
        // the reader's ×, "Close (Esc)", does what Esc does: the digest first, never the feed behind it (owner, 2026-11-18)
        ["the reader's close", async () => page.getByTestId("reader-close").click()],
      ];
      expect(total).toBeGreaterThan((ways.length - 1) * 2);
      for (const [i, [way, back]] of ways.entries()) {
        const at = i * 2;
        const subject = await subjectOf(at);
        if (i === 0) {
          await page.getByTestId("digest-open").nth(at).focus();
          await page.keyboard.press("Enter");
        } else await page.getByTestId("digest-open").nth(at).click();
        await expect(page.getByTestId("reader-subject"), way).toHaveText(subject);
        await back();
        kept++;
        await expect(page.getByTestId("digest-page"), way).toBeVisible();
        await expect(items.nth(at).getByTestId("digest-state"), way).toHaveText("Opened · stays in Inbox");
        await expect(items.nth(at).getByTestId("digest-tick"), way).not.toBeChecked();
        await expect(page.getByTestId("digest-archive"), way).toHaveText(`Archive ${total - kept}`);
        await expect(page.getByTestId("digest-count"), way).toContainText(`${total - kept} to archive · ${kept} ${kept === 1 ? "stays" : "stay"} in Inbox`);
        // back on the row it was opened from; opened is read (plan 145)
        await expect(page.getByTestId("digest-open").nth(at), way).toBeFocused();
        await expect.poll(() => unread(subject), way).toBe(0);
      }
    });

    await scenario("the page's scroll is kept on the way back, and the cursor stays above the foot bar", async () => {
      const scroller = page.getByTestId("digest-scroller");
      await page.getByTestId("digest-open").first().focus();
      for (let i = 0; i < total; i++) await page.keyboard.press("j");
      await expect(page.getByTestId("digest-open").last()).toBeFocused();
      const foot = (await page.getByTestId("digest-actions").boundingBox())!;
      const lastBox = (await items.last().boundingBox())!;
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(foot.y + 1);
      const scrolled = await scroller.evaluate((e) => e.scrollTop);
      expect(scrolled).toBeGreaterThan(0);
      const lastSubject = await subjectOf(total - 1);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("reader-subject")).toHaveText(lastSubject);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("digest-open").last()).toBeFocused();
      expect(Math.abs((await scroller.evaluate((e) => e.scrollTop)) - scrolled)).toBeLessThanOrEqual(1);
      kept++;
    });

    await scenario("Esc on the page puts it away, as the feed puts away a conversation: back on the digest's item, in view even when the feed was moved away meanwhile; k and j are the feed's again", async () => {
      await toTop(page);
      await page.getByTestId("digest-open").last().focus();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("digest-page")).toHaveCount(0);
      await expect(page.locator(DIGEST)).toBeInViewport();
      await expect(page.locator(DIGEST).getByTestId("wm-item-open")).toBeFocused();
      // k from there is the feed's: the last person's conversation opens; j back down opens the page again
      await page.keyboard.press("k");
      await expect(page.getByTestId("digest-page")).toHaveCount(0);
      await expect(page.locator(`${FEED} [data-testid=wm-item][data-open][data-thread-id]`)).toHaveCount(1);
      await page.keyboard.press("j");
      await expect(page.locator(DIGEST)).toHaveAttribute("data-open", "true");
      await expect(page.getByTestId("digest-page")).toBeVisible();
    });

    await scenario("Archive takes only the ticked; the snack stands on the page's foot bar, not over it", async () => {
      if (!(await page.getByTestId("digest-page").isVisible())) await (await digestRow(page)).click();
      await page.getByTestId("digest-archive").click();
      await expect(page.getByTestId("snack")).toContainText(`Archived ${total - kept} newsletters`);
      const snackBox = (await page.getByTestId("snack").first().boundingBox())!;
      const footAfter = (await page.getByTestId("digest-actions").boundingBox())!;
      expect(snackBox.y + snackBox.height).toBeLessThanOrEqual(footAfter.y);
      await expect(page.getByTestId("digest-item").filter({ hasText: "Opened · stays in Inbox" })).toHaveCount(kept);
      // by the row's conversation (a subject can be two conversations': the demo's has more than one brief)
      for (let i = 0; i < kept; i++) expect(db.get<{ n: number }>("SELECT in_inbox n FROM threads WHERE id = ?", Number(await items.nth(i).getByTestId("digest-open").getAttribute("data-digest-open")))!.n).toBe(1);
    });
  });

  test("plan 251: a message opened from Automated mail has the list beside it: a click or j/k/↓/↑ opens another, Esc puts it back", async ({ app: page, server }) => {
    await withMail(server, 6);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("nav-today").click();
    await (await digestRow(page)).click();
    await expect(page.getByTestId("digest-title")).toHaveText("Automated mail");
    const items = page.getByTestId("digest-item");
    const total = await items.count();
    expect(total).toBeGreaterThanOrEqual(6);
    const subjectOf = async (i: number) => (await items.nth(i).getByTestId("digest-subject").innerText()).trim();
    const column = page.locator("[data-testid=digest-page][data-place=column]");
    const listCard = page.locator("#app-list");
    const feedScroll = await feedList(page).evaluate((el) => el.scrollTop);
    // ticked before, kept beside
    await items.nth(0).getByTestId("digest-tick").click();

    await scenario("a click: the list goes into the list column, the message into the reader, its row marked; no button back", async () => {
      const second = await subjectOf(1);
      await items.nth(1).getByTestId("digest-open").click();
      await expect(page.getByTestId("reader-subject")).toHaveText(second);
      await expect(column).toBeVisible();
      // in the list's card, where the feed was (kept under it, out of reach)
      const box = (await column.boundingBox())!;
      const card = (await listCard.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(card.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 1);
      await expect(page.locator(FEED)).toBeHidden();
      await expect(page.locator("[data-testid=digest-page]:not([data-place])")).toHaveCount(0);
      await expect(column.getByTestId("digest-open").nth(1)).toHaveAttribute("aria-current", "true");
      await expect(column.getByTestId("digest-open").nth(1)).toBeFocused();
      await expect(column.getByTestId("digest-tick").first()).toBeChecked();
      await expect(page.getByText("Back to the digest")).toHaveCount(0);
      if (SHOTS) {
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-beside-light.png` });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-beside-dark.png` });
      }
      for (const mode of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        const results = await new AxeBuilder({ page }).include("#app-list").analyze();
        expect(results.violations.map((v) => `${mode} ${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
      }
    });

    await scenario("another row's click opens it there; the list stays", async () => {
      const fourth = await subjectOf(3);
      await column.getByTestId("digest-open").nth(3).click();
      await expect(page.getByTestId("reader-subject")).toHaveText(fourth);
      await expect(column.getByTestId("digest-open").nth(3)).toHaveAttribute("aria-current", "true");
      await expect(column.locator("[aria-current]")).toHaveCount(1);
    });

    await scenario("j and ↓ open the next, k and ↑ the previous, from the list and from the reader; x ticks the open one", async () => {
      await page.keyboard.press("j");
      await expect(page.getByTestId("reader-subject")).toHaveText(await subjectOf(4));
      await expect(column.getByTestId("digest-open").nth(4)).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByTestId("reader-subject")).toHaveText(await subjectOf(5));
      await page.keyboard.press("k");
      await page.keyboard.press("ArrowUp");
      await expect(page.getByTestId("reader-subject")).toHaveText(await subjectOf(3));
      await expect(column.getByTestId("digest-open").nth(3)).toBeFocused();
      // with the keys in the reader they stay there
      await page.getByTestId("reader-subject").click();
      await page.keyboard.press("j");
      await expect(page.getByTestId("reader-subject")).toHaveText(await subjectOf(4));
      await expect(column.getByTestId("digest-open").nth(4)).toHaveAttribute("aria-current", "true");
      await expect(column.getByTestId("digest-open").nth(4)).not.toBeFocused();
      await page.keyboard.press("x");
      await expect(column.getByTestId("digest-tick").nth(4)).toBeChecked();
      // the feed under it took none of it
      expect(await feedList(page).evaluate((el) => el.scrollTop)).toBe(feedScroll);
      // ⌘A selects nothing in the feed under it
      await page.keyboard.press("ControlOrMeta+a");
      await expect(page.getByTestId("reader-subject")).toHaveText(await subjectOf(4));
      // Skip to list / Enter: the open row has the keys; Enter on it goes into the reader
      await column.getByTestId("digest-open").nth(4).focus();
      await page.keyboard.press("Enter");
      await expect(column.getByTestId("digest-open").nth(4)).not.toBeFocused();
      await expect(page.getByTestId("reader-subject")).toHaveText(await subjectOf(4));
    });

    await scenario("Codex review: from a control of the conversation that goes, j lands the keys in the next one; a new message over it, the open row's click comes back to it", async () => {
      await page.getByTestId("quick-reply").focus();
      await page.keyboard.press("j");
      await expect(page.getByTestId("reader-subject")).toHaveText(await subjectOf(5));
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-testid=reader]") !== null)).toBe(true);
      await page.keyboard.press("c");
      await expect(page.getByTestId("reader-subject")).toHaveCount(0);
      await column.getByTestId("digest-open").nth(5).click();
      await expect(page.getByTestId("reader-subject")).toHaveText(await subjectOf(5));
      await page.keyboard.press("k");
      await expect(page.getByTestId("reader-subject")).toHaveText(await subjectOf(4));
    });

    await scenario("Codex review: scrolled away from the open row, Esc brings the page back with it in view", async () => {
      await column.getByTestId("digest-scroller").evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.keyboard.press("Escape");
      await expect(column).toHaveCount(0);
      await expect(page.getByTestId("digest-open").nth(4)).toBeInViewport();
      await expect(page.getByTestId("digest-open").nth(4)).toBeFocused();
      await page.getByTestId("digest-open").nth(4).click();
      await expect(column).toBeVisible();
    });

    await scenario("Esc: the page again, on the row it was on, the ticks kept; again, the feed where it was", async () => {
      await page.keyboard.press("Escape");
      await expect(column).toHaveCount(0);
      await expect(page.getByTestId("digest-page")).toBeVisible();
      await expect(page.getByTestId("digest-open").nth(4)).toBeFocused();
      await expect(items.nth(0).getByTestId("digest-tick")).toBeChecked();
      await expect(items.nth(4).getByTestId("digest-tick")).toBeChecked();
      await expect(page.locator(FEED)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("digest-page")).toHaveCount(0);
    });

    await scenario("Codex review: the open row gone from the list's end (its sender hidden), j opens nothing past it and k the row above", async () => {
      await (await digestRow(page)).click();
      const last = (await items.count()) - 1;
      await items.nth(last).getByTestId("digest-open").click();
      const lastSubject = (await column.getByTestId("digest-subject").nth(last).innerText()).trim();
      await expect(page.getByTestId("reader-subject")).toHaveText(lastSubject);
      await column.getByTestId("digest-open").nth(last).click({ button: "right" });
      await page.getByTestId("digest-menu-hide").click();
      await expect(column.getByTestId("digest-subject").filter({ hasText: lastSubject })).toHaveCount(0);
      await page.keyboard.press("j");
      await expect(page.getByTestId("reader-subject")).toHaveText(lastSubject);
      const above = (await column.getByTestId("digest-subject").last().innerText()).trim();
      await page.keyboard.press("k");
      await expect(page.getByTestId("reader-subject")).toHaveText(above);
    });
  });

  test.describe("with motion", () => {
    test.use({ reducedMotion: "no-preference" });
    test("plan 251: the list glides between the reader and the list column in one view transition, its rows named only while it runs", async ({ app: page, server }) => {
      await withMail(server, 3);
      await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
      await page.getByTestId("nav-today").click();
      await (await digestRow(page)).click();
      await expect(page.getByTestId("digest-title")).toHaveText("Automated mail");
      await page.evaluate(() => {
        const w = window as unknown as { transitions: string[][] };
        w.transitions = [];
        const start = document.startViewTransition.bind(document);
        document.startViewTransition = ((update: () => void) => {
          const names = () => [...document.querySelectorAll<HTMLElement>("[data-morph]")].map((el) => el.style.getPropertyValue("view-transition-name")).filter(Boolean);
          w.transitions.push(names());
          return start(() => {
            update();
            w.transitions.push(names());
          });
        }) as typeof document.startViewTransition;
      });
      const transitions = () => page.evaluate(() => (window as unknown as { transitions: string[][] }).transitions);
      const subject = (await page.getByTestId("digest-subject").nth(1).innerText()).trim();
      await page.getByTestId("digest-open").nth(1).click();
      await expect(page.getByTestId("reader-subject")).toHaveText(subject);
      await expect(page.locator("[data-testid=digest-page][data-place=column]")).toBeVisible();
      await expect.poll(async () => (await transitions()).length).toBe(2);
      const [before, after] = await transitions();
      // the title, the foot and the rows in view, on both sides
      for (const names of [before!, after!]) {
        expect(names).toContain("digest-title");
        expect(names).toContain("digest-foot");
        expect(names.filter((n) => n.startsWith("digest-row-")).length).toBeGreaterThanOrEqual(3);
      }
      // another row from the column: no transition (only the reader changes)
      await page.locator("[data-place=column] [data-testid=digest-open]").nth(2).click();
      await expect(page.getByTestId("reader-subject")).not.toHaveText(subject);
      // Esc: back, one transition more
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-testid=digest-page][data-place=column]")).toHaveCount(0);
      await expect(page.getByTestId("digest-page")).toBeVisible();
      await expect.poll(async () => (await transitions()).length).toBe(4);
      // and the names are gone once it's over
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-morph]")].some((el) => el.style.getPropertyValue("view-transition-name")))).toBe(false);
    });
  });

  test("ai-r03: the digest scrolls in its pane, so its last row and its box are reachable by the wheel in a short window", async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.setViewportSize({ width: 1100, height: 340 });
    await page.getByTestId("nav-today").click();
    await expect(await digestRow(page)).toContainText("today's digest", { timeout: 15_000 });
    await (await digestRow(page)).click();
    await expect(page.getByTestId("digest-title")).toHaveText("Today's digest");
    const last = page.getByTestId("digest-item").last();
    const below = async () => (await last.boundingBox())!.y + (await last.boundingBox())!.height - (await page.evaluate(() => innerHeight));
    // the page is taller than the window: its last row starts below it
    expect(await below()).toBeGreaterThan(0);
    const pane = (await page.getByTestId("digest-scroller").boundingBox())!;
    // over the pane's empty side, not only the column: the whole pane scrolls
    await page.mouse.move(pane.x + pane.width - 20, pane.y + pane.height / 2);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
    await expect.poll(below).toBeLessThanOrEqual(0);
    await last.getByTestId("digest-tick").click();
    await expect(last.getByTestId("digest-tick")).not.toBeChecked();
  });

  test("the digest's way in is no conversation: no menu, and a refresh keeps it", async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await page.getByTestId("nav-today").click();

    await scenario("the digest's item opens its page; e there acts on nothing; it isn't a thread to a refresh or a menu", async () => {
      await digestRow(page);
      const asked: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" || /Too small/.test(m.text())) asked.push(m.text());
      });
      await (await digestRow(page)).click();
      await page.keyboard.press("e");
      await expect(page.getByTestId("digest-page")).toBeVisible();
      // a refresh with the digest's item open: it's not a thread, and the items stay
      server.backend.notifyChanged([]);
      await expect(page.locator(DIGEST)).toBeVisible();
      // no menu: it's no thread (nothing to act on)
      await page.locator(DIGEST).click({ button: "right" });
      await expect(page.getByTestId("menu-reply")).toHaveCount(0);
      expect(asked.filter((a) => /Too small|VALIDATION|invalid/i.test(a))).toEqual([]);
      await page.keyboard.press("Escape");
    });
  });
});

test.describe("What matters in List (plan 162, after ai162-r02, Codex review)", () => {
  test.use({ layout: "list" });
  test("the digest is a page over the feed: Esc closes it, back to the feed at its way in", async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.getByTestId("nav-today").click();
    await expect(await digestRow(page)).toContainText("today's digest", { timeout: 15_000 });
    await (await digestRow(page)).click();
    await expect(page.getByTestId("digest-page")).toBeVisible();
    await scenario("its keys while it's open: j moves its cursor, not the feed under it", async () => {
      await expect(page.getByTestId("digest-open").first()).toBeFocused();
      await page.keyboard.press("j");
      await expect(page.getByTestId("digest-open").nth(1)).toBeFocused();
    });
    await scenario("Esc closes it: back on the feed, at the digest's way in, in view", async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("digest-page")).toHaveCount(0);
      await expect(page.locator(FEED)).toBeVisible();
      await expect(page.locator(DIGEST)).toBeInViewport();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-list-digest-end.png` });
    });
    await scenario("its × closes it the same way", async () => {
      await (await digestRow(page)).click();
      await page.getByTestId("digest-close").click();
      await expect(page.getByTestId("digest-page")).toHaveCount(0);
      await expect(page.locator(DIGEST)).toBeInViewport();
    });
    await scenario("plan 251: a newsletter opened from it is a page: no list beside, and the toolbar's Back says the digest and goes back to it", async () => {
      await (await digestRow(page)).click();
      const subject = (await page.getByTestId("digest-subject").nth(1).innerText()).trim();
      await page.getByTestId("digest-open").nth(1).click();
      await expect(page.getByTestId("reader-subject")).toHaveText(subject);
      await expect(page.locator(BESIDE)).toHaveCount(0);
      await expect(page.getByTestId("reader-back")).toHaveAccessibleName("Back to Today's digest");
      await page.getByTestId("reader-back").click();
      await expect(page.getByTestId("digest-page")).toBeVisible();
      await expect(page.getByTestId("digest-open").nth(1)).toBeFocused();
      // and its Back from there is the feed's again
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("digest-page")).toHaveCount(0);
      await expect(page.locator(FEED)).toBeVisible();
    });
  });
});

test.describe("What matters, part one: dated items (plan 204)", () => {
  /** a message from a service, as live mail reaches the dated reader (marked in the ingest, as the sync does) */
  async function received(server: DevServerFixture, key: string, from: { name: string; email: string }, subject: string, text: string, live = true) {
    const db = sqlDb(server.backend.store);
    const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
    const message = { accountId: acct.id, providerMsgId: key, providerThreadId: key, rfcMessageId: `<${key}@e2e.test>`, inReplyTo: null, references: [], from, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject, date: E2E_NOW, snippet: text, bodyText: text, bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200 } as unknown as IncomingMessage;
    await server.backend.store.sync.ingest([message], { applyFilters: false, now: E2E_NOW, classifier: null, ...(live ? { datedMail: await server.backend.dated.wanted() } : {}) });
    return db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = ?", key)!;
  }
  const datedSetting = async (server: DevServerFixture) => ((await server.backend.server.invoke("app.bootstrap", {}, dev)) as { settings: { dated: { enabled: boolean } } }).settings.dated;
  /** Needs you (the demo's waiting conversations) comes before Soon (the seventh panel round), so what's Soon's can be past the virtualized feed's first screen */
  const reach = async (page: Page, text: string) => {
    await expect.poll(async () => (await item(page, text).count()) > 0 || (await feedList(page).evaluate((el) => { el.scrollTop += el.clientHeight / 2; }), false)).toBe(true);
  };
  /** put off: out of its day; with Coming up open (as a scenario before left it) it's there, under its day, quietly */
  const leftSoon = (page: Page, text: string) => expect.poll(() => groupOf(page, text)).toMatch(/^(gone|comingUp)$/);
  /** the open item: the conversation beside the feed */
  const open = (page: Page) => page.locator(`${FEED} [data-testid=wm-item][data-open]`);

  test("on, What matters' header offers nothing; a bill, a flight and a renewal from new mail; Missed; Done from the menu with Undo; Coming up by keyboard; the reader's line", async ({ app: page, server }) => {
    // a long flow, and the feed is walked end to end to read its groups (it draws only what's near the view)
    test.setTimeout(120_000);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await page.getByTestId("nav-today").click();

    await scenario("plan 211: on (the fixture had it off), the header asks nothing: the backend checks each account itself, and the demo's mailbox counts as checked", async () => {
      await server.backend.server.invoke("settings.update", { dated: { enabled: true } }, dev);
      await expect.poll(async () => (await datedSetting(server)).enabled).toBe(true);
      const header = page.locator(`${FEED} header`);
      await expect(header.getByTestId("today-line")).toBeVisible();
      // the title's row and the day's line, and no offer under them: no link, no button but the title row's options
      await expect(header.locator('p:has(button), [data-testid^="today-dated"]')).toHaveCount(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-on-light.png` });
      expect(await server.backend.store.dated.marks.count()).toBe(0);
    });

    await scenario("new mail with a date: the flight and the bill each under its day, after Today; the renewal under Coming up, closed", async () => {
      await received(server, "bill-1", { name: "City Power", email: "billing@citypower.test" }, "Electricity bill", "Hello. Your electricity bill of $84.20 is due 2026-10-24. Thank you.");
      await received(server, "flight-1", { name: "Iberia", email: "no-reply@iberia.test" }, "Flight to Madrid", "Your flight on 2026-10-23 at 07:40 leaves from terminal 4.");
      await received(server, "renew-1", { name: "Domains Co", email: "billing@domains.test" }, "Domain renewal", "Your domain renews soon. Payment is due 2026-11-01.");
      // plan 210 (iteration 3): Coming up has no horizon: a bill six weeks out is Coming up's, under its week
      await received(server, "dues-1", { name: "Rowing Club", email: "billing@rowing.test" }, "Club dues", "Hello. Your club dues are due 2026-12-01. Thank you.");
      server.backend.dated.wake();
      await expect.poll(async () => (await server.backend.store.dated.active()).length, { timeout: 15_000 }).toBe(4);
      await reach(page, "Electricity bill");
      // the item's own words in a sentence, who under it, when it's due in the right-hand column
      const bill = item(page, "Electricity bill");
      await expect(bill.getByTestId("wm-sentence")).toHaveText("Electricity bill.");
      await expect(bill.getByTestId("wm-meta")).toHaveText("City Power");
      await expect(bill.getByTestId("wm-when")).toHaveText("Sat");
      await reach(page, "Flight to Madrid");
      const flight = item(page, "Flight to Madrid");
      await expect(flight.getByTestId("wm-sentence")).toHaveText("Flight to Madrid.");
      // tomorrow, at its time; a day ahead's weight is the quiet one
      await expect(flight.getByTestId("wm-when")).toHaveText(/^Tomorrow 7:40\sAM$/);
      await expect(flight).toHaveAttribute("data-tone", "later");
      // plan 210 (the owner): by day: what needs you now (nothing of Today's own here, so no empty Today heading above the
      // people waiting on you, the owner 2026-11-19), then a heading per day ahead, in order
      const ks = await kinds(page);
      // (iteration 4: Coming up the last heading, closed)
      expect(ks.filter((k) => k !== "history" && k !== "missed")).toEqual(["waiting", "day", "day", "comingUp"]);
      await expect.poll(() => groupOf(page, "Flight to Madrid")).toBe("day");
      await reach(page, "Flight to Madrid");
      const days = page.locator(`${FEED} [data-testid=wm-heading][data-kind=day]`);
      await expect(days.first()).toHaveText("Tomorrow");
      await expect(days.nth(1)).toHaveText("Saturday");
      await toTop(page);
      // later than its time to act: not an item, only Coming up's count, the feed's last heading (iteration 4)
      await expect(item(page, "Domain renewal")).toHaveCount(0);
      await expect(page.getByTestId("today-line")).not.toContainText(/coming up/i);
      await toEnd(page);
      await expect(page.getByTestId("wm-coming-up")).toHaveAccessibleName("Coming up 2");
      await expect(page.getByTestId("wm-coming-up")).toHaveAttribute("aria-expanded", "false");
    });

    await scenario("a date that passed with nothing done: Missed, first", async () => {
      // written as the worker would have, on the 14-day check's path (a past day isn't kept from new mail)
      const m = await received(server, "domain-1", { name: "Registrar", email: "billing@registrar.test" }, "Renew the domain", "Your domain expires.", false);
      const store = server.backend.store;
      await store.dated.marks.queueScan([m.id], E2E_NOW);
      const due = new Date(2026, 9, 20, 9, 0).getTime();
      const wrote = await store.dated.finish({ messageId: m.id, threadId: m.thread_id, fromScan: true, rows: [{ kind: "renew", item: 0, text: "Renew the domain", quote: "Your domain expires.", dueDay: "2026-10-20", dueAt: due, timed: false, dated: true, actAt: due - 7 * 86_400_000 }], settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
      expect(wrote).toBe("written");
      server.backend.today.changed();
      await toTop(page);
      const missed = item(page, "Renew the domain");
      await expect(missed.getByTestId("wm-sentence")).toHaveText("Renew the domain.");
      await expect(missed.getByTestId("wm-when")).toHaveText("Was due Tue");
      await expect(missed).toHaveAttribute("data-tone", "missed");
      expect((await kinds(page))[0]).toBe("missed");
      await expect(page.locator(`${FEED} [data-testid=wm-heading]`).first()).toHaveText("Missed");
    });

    await scenario("Coming up opens and closes by keyboard, its rows under their days and, past two weeks, their weeks, and stays open after a reload", async () => {
      const toggle = page.getByTestId("wm-coming-up");
      await toEnd(page);
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      // plan 210 (iteration 3): the catalog's disclosure: the same words open or shut, its chevron turned
      await expect(toggle).toHaveAccessibleName("Coming up 2");
      await expect(toggle.locator("[data-slot=collapsible-chevron]")).toHaveCount(1);
      await expect(toggle).toBeFocused();
      // last, past the demo's Needs you (the feed is virtualized: scrolled to its end, focus left on the toggle)
      await expect.poll(async () => (await toEnd(page), await item(page, "Domain renewal").count())).toBe(1);
      const renewal = item(page, "Domain renewal");
      await expect(renewal.getByTestId("wm-sentence")).toHaveText("Domain renewal.");
      await expect(renewal).toHaveAttribute("data-tone", "later");
      // its words in the row's ink, not a fade (its column stays quiet)
      const ink = async (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);
      expect(await ink(renewal.getByTestId("wm-sentence"))).not.toBe(await ink(renewal.getByTestId("wm-meta")));
      // plan 210: under its own day's heading; iteration 3: the dues six weeks out under their week's, last; iteration 4:
      // Coming up's own buckets, under its heading
      expect(await groupOf(page, "Domain renewal")).toBe("comingUp");
      expect(await groupOf(page, "Club dues")).toBe("comingUp");
      expect((await kinds(page)).filter((k) => k !== "history").slice(-3)).toEqual(["comingUp", "coming", "coming"]);
      const week = page.locator(`${FEED} [data-testid=wm-heading][data-kind=coming]`).last();
      await expect.poll(async () => (await toEnd(page), await week.textContent())).toBe("Week of Nov 30");
      // the heading on its items' text line
      await expect.poll(async () => (await toEnd(page), await item(page, "Domain renewal").count())).toBe(1);
      const left = async (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
      expect(Math.abs((await left(page.locator(`${FEED} [data-testid=wm-heading][data-kind=coming]`).first())) - (await left(renewal.getByTestId("wm-sentence"))))).toBeLessThanOrEqual(1);
      // plan 274: Coming up a section title (its words, its count's badge) on the same line as the days it opens, which
      // are quiet subheadings: a different ink
      const bucket = page.locator(`${FEED} [data-testid=wm-heading][data-kind=coming]`).first();
      await expect(toggle.getByTestId("wm-coming-up-title")).toHaveText("Coming up");
      await expect(toggle.getByTestId("wm-heading-count")).toHaveText("2");
      expect(Math.abs((await left(toggle.getByTestId("wm-coming-up-title"))) - (await left(bucket)))).toBeLessThanOrEqual(1);
      // in the ink and the quiet ink, by the theme's own (a probe of each in the feed), and a level apart for a screen reader
      const themeInk = (cls: string) => page.locator(FEED).evaluate((feed, c) => {
        const probe = feed.appendChild(document.createElement("span"));
        probe.className = c;
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }, cls);
      expect(await ink(toggle.getByTestId("wm-coming-up-title"))).toBe(await themeInk("text-foreground"));
      expect(await ink(bucket)).toBe(await themeInk("text-muted-foreground"));
      expect(await page.locator(`${FEED} [data-testid=wm-heading][data-kind=comingUp]`).evaluate((el) => el.tagName)).toBe("H2");
      expect(await bucket.evaluate((el) => el.tagName)).toBe("H3");
      // its count in BoardUI's neutral badge, and never larger than the page's own title (the Codex code review)
      await expect(toggle.getByTestId("wm-heading-count")).toHaveAttribute("data-slot", "badge");
      const size = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(await size(toggle.getByTestId("wm-coming-up-title"))).toBeLessThanOrEqual(await size(page.getByTestId("list-title")));
      if (SHOTS) {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await toEnd(page);
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-end-${mode}.png` });
          await toTop(page);
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-top-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
        await toEnd(page);
      }
      // plan 274: axe with the section title, its badge and a quiet bucket on screen (the Codex code review)
      await toggle.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await expect(toggle).toBeInViewport();
      await expect(bucket).toBeInViewport();
      for (const mode of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await expect(page.locator("html")).toHaveClass(mode === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
        const results = await new AxeBuilder({ page }).include(FEED).analyze();
        expect(results.violations.map((v) => `${mode} ${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
      }
      await toEnd(page);
      await toggle.focus();
      await page.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(item(page, "Domain renewal")).toHaveCount(0);
      // remembered: open again after a reload
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await fresh(page);
      await page.getByTestId("nav-today").click();
      await expect.poll(async () => (await toEnd(page), await page.getByTestId("wm-coming-up").getAttribute("aria-expanded"))).toBe("true");
      await expect.poll(async () => (await toEnd(page), await item(page, "Domain renewal").count())).toBe(1);
    });

    await scenario("Done from the item's menu (D beside it), Remove (⇧D) and Later (B); each leaves What matters, and Undo (z) brings it back", async () => {
      await show(page, "Electricity bill");
      const snack = page.locator("[data-testid=snack]");
      // after the second panel round: gone at once, even the open item (not held in place: the user finished it)
      const gone = () => expect(item(page, "Electricity bill")).toHaveCount(0);
      const undo = async (after: string) => {
        await focusList(page);
        await page.keyboard.press("z");
        await expect(item(page, "Electricity bill"), `undone after ${after}`).toHaveCount(1);
      };
      // the conversations' items, top to bottom
      const order = () => page.locator(`${FEED} [data-testid=wm-item][data-thread-id]`).evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-thread-id"), top: e.getBoundingClientRect().top })).sort((a, b) => a.top - b.top).map((r) => r.id));
      await item(page, "Electricity bill").click({ button: "right" });
      await expect(page.getByTestId("menu-dated-done")).toContainText("D");
      // plan 210 (iteration 1, the owner): "Not a task" is "Remove", and the menu says its key, as Later's does; iteration
      // 3: what it removes from, that the email stays, and after Done and Later, a separator away from the mail's actions
      const remove = page.getByTestId("menu-dated-dismiss");
      await expect(remove).toContainText("Remove from “What matters”");
      await expect(remove).toContainText("⇧D");
      await expect(remove).toHaveAccessibleDescription("The email stays");
      await expect(page.getByTestId("menu-dated-later")).toContainText("B");
      const menuOrder = await page.locator("[role=menu]").first().evaluate((menu) => [...menu.children].map((el) => el.getAttribute("data-testid") ?? el.getAttribute("role") ?? el.getAttribute("data-slot")));
      const at = menuOrder.indexOf("menu-dated-dismiss");
      // plan 210 (iteration 4): then Reply, and the mail's actions (Delete among them) under More, nothing else (what's under
      // More: what-matters-feed.spec); Change… and Hand to… after Later, each (iteration 5) with its key and what it does under it
      expect(menuOrder.slice(at - 6)).toEqual(["menu-dated-done", "menu-dated-later", "menu-dated-change", "menu-dated-change-note", "menu-dated-hand", "menu-dated-hand-note", "menu-dated-dismiss", "menu-dated-keeps", "separator", "menu-reply", "separator", "menu-more"]);
      await expect(page.getByTestId("menu-dated-change")).toContainText("⇧B");
      await expect(page.getByTestId("menu-dated-change")).toHaveAccessibleDescription("Sets its own day");
      await expect(page.getByTestId("menu-dated-hand")).toContainText("⇧F");
      await expect(page.getByTestId("menu-dated-hand")).toHaveAccessibleDescription("Forwards it to someone");
      // Later replaces Remind me on a task's item: every preset that applies now, and a day of your own
      await expect(page.getByTestId("menu-remind-always")).toHaveCount(0);
      await page.getByTestId("menu-dated-later").click();
      await expect(page.getByTestId("menu-dated-later-list")).toBeVisible();
      await expect(page.getByTestId("menu-dated-later-tomorrow")).toBeVisible();
      await expect(page.getByTestId("menu-dated-later-nextWeek")).toBeVisible();
      await expect(page.getByTestId("menu-dated-later-pick")).toHaveText("Pick a date…");
      if (SHOTS) {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-menu-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      await page.keyboard.press("Escape");
      if (await page.getByTestId("menu-dated-done").isVisible()) await page.keyboard.press("Escape");
      await show(page, "Electricity bill");
      await item(page, "Electricity bill").click({ button: "right" });
      await page.getByTestId("menu-dated-done").click();
      await gone();
      // the fourth panel round: Undo names what it undoes
      await expect(snack).toContainText("Done: Electricity bill");
      await undo("the menu's Done");

      // D: the open item's Done, the same snack and Undo. It goes and the next one opens, as after Archive; z brings it back
      // in its place, open
      await show(page, "Electricity bill");
      await item(page, "Electricity bill").click();
      await expect(item(page, "Electricity bill")).toHaveAttribute("data-open", "true");
      const ids = await order();
      const bill = await item(page, "Electricity bill").getAttribute("data-thread-id");
      const next = ids[ids.indexOf(bill) + 1]!;
      await focusList(page);
      await page.keyboard.press("d");
      await gone();
      await expect(open(page)).toHaveAttribute("data-thread-id", next);
      await expect(snack).toContainText("Done: Electricity bill");
      await undo("D");
      await expect(open(page)).toHaveAttribute("data-thread-id", bill!);
      // in its place among its neighbours (the feed draws a few items more or less around it, past Needs you)
      const near = (all: (string | null)[]) => all.slice(Math.max(0, all.indexOf(bill) - 2), all.indexOf(bill) + 3);
      // (only the rows drawn both times: the virtualized feed may draw one more past its end)
      expect(near(await order()).filter((id) => ids.includes(id))).toEqual(near(ids));
      // (⇧D on a conversation waiting on you: plan 216's, what-matters-feed.spec.ts)

      // Remove: out of What matters, said so (never as if the email went), with Undo
      await show(page, "Electricity bill");
      await item(page, "Electricity bill").click({ button: "right" });
      await page.getByTestId("menu-dated-dismiss").click();
      await gone();
      await expect(snack).toContainText(/Removed( from “What matters”)?.*Electricity bill/);
      await expect.poll(async () => (await server.backend.store.dated.active()).some((r) => r.text === "Electricity bill")).toBe(false);
      await undo("Remove");
      if (await page.getByTestId("reader").count()) await page.keyboard.press("Escape");

      // plan 210 (iteration 1): ⇧D, the open item's Remove, the same snack and Undo; the next one opens, as after D
      await show(page, "Electricity bill");
      await item(page, "Electricity bill").click();
      await expect(item(page, "Electricity bill")).toHaveAttribute("data-open", "true");
      await focusList(page);
      await page.keyboard.press("Shift+D");
      await gone();
      await expect(open(page)).toHaveAttribute("data-thread-id", next);
      await expect(snack).toContainText(/Removed( from “What matters”)?.*Electricity bill/);
      await undo("⇧D");
      await expect(open(page)).toHaveAttribute("data-thread-id", bill!);

      // b: the open item's Later, its own presets beside it. Opening and leaving it moves nothing, and while it's open the
      // mail behind keeps its keys (D there would finish the item)
      await focusList(page);
      await page.keyboard.press("b");
      const laterMenu = page.getByTestId("wm-later-menu");
      await expect(laterMenu).toBeVisible();
      await expect(laterMenu.getByTestId("wm-later-tomorrow")).toBeVisible();
      await page.keyboard.press("d");
      await page.keyboard.press("Escape");
      await expect(laterMenu).toHaveCount(0);
      await expect(item(page, "Electricity bill")).toHaveCount(1);
      await expect(open(page)).toHaveAttribute("data-thread-id", bill!);
      await expect(snack.filter({ hasText: "Done:" })).toHaveCount(0);
      expect((await server.backend.store.dated.active()).some((r) => r.text === "Electricity bill")).toBe(true);
      // b again, a preset: it goes, said so, and z brings it back
      await focusList(page);
      await page.keyboard.press("b");
      await laterMenu.getByTestId("wm-later-tomorrow").click();
      // put off, it leaves its place for Coming up, which draws it when that's open and near (5970e8d23), as the reader's
      // Later below
      await leftSoon(page, "Electricity bill");
      await expect(snack).toContainText("Later: Electricity bill");
      await undo("b");
      if (await page.getByTestId("reader").count()) await page.keyboard.press("Escape");

      // Later ▸ Pick a date…: the reminder's own date and time; a timed Plan's only before it starts (the third panel
      // round: tomorrow at 9:00 isn't for a 7:40 AM flight)
      await show(page, "Flight to Madrid");
      await item(page, "Flight to Madrid").click({ button: "right" });
      await page.getByTestId("menu-dated-later").click();
      await expect(page.getByTestId("menu-dated-later-laterToday")).toBeVisible();
      await expect(page.getByTestId("menu-dated-later-tomorrow")).toHaveCount(0);
      await expect(page.getByTestId("menu-dated-later-nextWeek")).toHaveCount(0);
      await page.keyboard.press("Escape");
      if (await page.getByTestId("menu-dated-done").isVisible()) await page.keyboard.press("Escape");
      await show(page, "Electricity bill");
      await item(page, "Electricity bill").click({ button: "right" });
      await page.getByTestId("menu-dated-later").click();
      await page.getByTestId("menu-dated-later-pick").click();
      const dialog = page.getByTestId("today-later-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("today-later-date")).toBeVisible();
      await expect(dialog.getByTestId("today-later-time")).toBeVisible();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-pick-light.png` });
      expect((await new AxeBuilder({ page }).include("[data-testid=today-later-dialog]").analyze()).violations).toEqual([]);
      await dialog.getByTestId("today-later-set").click();
      await expect(dialog).toHaveCount(0);
      await leftSoon(page, "Electricity bill");
      await expect(snack).toContainText("Later: Electricity bill");
      // back under its day (wherever the feed has drawn it)
      await focusList(page);
      await page.keyboard.press("z");
      await expect.poll(() => groupOf(page, "Electricity bill")).toBe("day");
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await server.backend.store.dated.active()).some((r) => r.text === "Electricity bill" && r.deferredUntil === null)).toBe(true);
    });

    await scenario("promises of yours: said as yours, to the person; one with no day in Needs you says none, one due later in Coming up says its day, the card says its day, D is the promise's own Done", async () => {
      await server.backend.server.invoke("settings.update", { followups: { enabled: true } }, dev);
      const store = server.backend.store;
      const promise = async (subject: string, text: string, dueAt: number, dated = true) => {
        await ingestConversation(server, { subject, count: 2, now: E2E_NOW });
        const { items } = await store.threads.searchText({ query: `subject:"${subject}"`, limit: 1, now: E2E_NOW });
        const thread = await store.threads.get(items[0]!.id);
        const message = thread!.messages.at(-1)!;
        await store.followups.marks.queueScan([message.id], E2E_NOW);
        await store.followups.finish({ messageId: message.id, threadId: items[0]!.id, fromScan: false, rows: [{ kind: "promise", item: 0, text, quote: `I'll ${text}`, personName: "Tom Reed", personEmail: "tom.reed@example.com", dueAt, dated }], kept: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
      };
      await promise("The agenda", "send the agenda", E2E_NOW - 1000);
      await promise("The deck", "send the deck", E2E_NOW + 3 * 86_400_000);
      await promise("Callback for Tom", "call Tom back", E2E_NOW - 1000, false);
      await server.backend.followups.look();
      server.backend.today.changed();
      // the page reads follow-ups' setting at its start: the conversation's promise card needs it
      await fresh(page);
      await page.getByTestId("nav-today").click();
      await toTop(page);
      const agenda = item(page, "send the agenda");
      await expect(agenda.getByTestId("wm-sentence")).toHaveText("You said you'd send the agenda.", { timeout: 15_000 });
      // the fourth panel round (revision 9): to the person you made it to, not you (the last to write)
      await expect(agenda.getByTestId("wm-meta")).toHaveText("To Tom Reed");
      await expect(agenda.getByTestId("wm-when")).toHaveText("Today");
      await expect(agenda).toHaveAttribute("data-tone", "today");
      // one that named no day is Today's too (plan 210, the owner's "Under Today"), its column saying since when, quietly
      await show(page, "call Tom back");
      const call = item(page, "call Tom back");
      await expect(call.getByTestId("wm-sentence")).toHaveText("You said you'd call Tom back.");
      await expect(call.getByTestId("wm-when")).toHaveText(/^since /);
      await expect(call).toHaveAttribute("data-tone", "none");
      expect(await groupOf(page, "call Tom back")).toBe("today");
      expect(await groupOf(page, "send the agenda")).toBe("today");
      await expect(page.locator(`${FEED} [data-testid=wm-heading][data-kind=today]`)).toHaveText("Today");
      // first after what's Missed, and no Needs you or Soon any more
      const ks = (await kinds(page)).filter((k) => k !== "missed");
      expect(ks[0]).toBe("today");
      expect(ks.filter((k) => k === "today")).toHaveLength(1);
      if (SHOTS) {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-promise-rows-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      // its line in the conversation says its day, never the moment it's placed at: the dated line's one design (plan 210,
      // iteration 3), its person once
      await show(page, "send the agenda");
      await agenda.click();
      const card = page.getByTestId("thread-dated-item");
      await expect(card).toHaveAttribute("data-source", "promise");
      await expect(card).toHaveAttribute("data-target", "true");
      await expect(card.getByTestId("thread-dated-text")).toHaveText("Due today · You told Tom you’d send the agenda");
      await expect(card.getByTestId("thread-dated-done")).toHaveText("Done");
      await expect(card.getByTestId("thread-dated-later")).toHaveText("Later");
      await expect(card.getByTestId("thread-dated-dismiss")).toHaveText("Remove");
      await expect(page.getByTestId("followup-line")).toHaveCount(0);
      if (SHOTS) {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-promise-card-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      await page.keyboard.press("Escape");
      // Coming up holds the later one, saying its day (it's open from the scenario before)
      await expect.poll(async () => (await toEnd(page), await item(page, "send the deck").count())).toBe(1);
      await expect(item(page, "send the deck").getByTestId("wm-sentence")).toHaveText("You said you'd send the deck.");
      await expect(item(page, "send the deck").getByTestId("wm-when")).toHaveText("Sun");
      if (SHOTS) {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-promises-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      // D on the promise's item: that promise's Done, its Undo with z
      await show(page, "send the agenda");
      await agenda.click();
      await expect(agenda).toHaveAttribute("data-open", "true");
      await focusList(page);
      await page.keyboard.press("d");
      await expect(agenda).toHaveCount(0);
      await expect(page.locator("[data-testid=snack]")).toContainText("Done: send the agenda");
      await expect.poll(async () => (await store.followups.active()).some((r) => r.text === "send the agenda")).toBe(false);
      await page.keyboard.press("z");
      await expect(agenda).toHaveCount(1);
      await page.keyboard.press("Escape");
    });

    await scenario("the reader's line: on the AI card's surface, with its Done, Later and Remove", async () => {
      await show(page, "Electricity bill");
      await item(page, "Electricity bill").click();
      const line = page.getByTestId("thread-dated");
      await expect(line).toBeVisible();
      await expect(line.getByTestId("thread-dated-text")).toHaveText("Due Saturday · Electricity bill");
      await expect(line).toHaveClass(/\bai-card\b/);
      await expect(line.getByTestId("thread-dated-done")).toHaveAccessibleName("Done: Electricity bill");
      await expect(line.getByTestId("thread-dated-dismiss")).toHaveAccessibleName("Remove from “What matters”: Electricity bill");
      await expect(line.getByTestId("thread-dated-dismiss")).toHaveText("Remove");
      // Remove here: the item leaves What matters as from its own menu (the next conversation opens), and the snack's
      // Undo brings it back, open again with its line
      await line.getByTestId("thread-dated-dismiss").click();
      await expect(item(page, "Electricity bill")).toHaveCount(0);
      await expect(page.locator("[data-testid=snack]")).toContainText(/Removed( from “What matters”)?.*Electricity bill/);
      await focusList(page);
      await page.keyboard.press("z");
      await expect(open(page)).toContainText("Electricity bill");
      await expect(line.getByTestId("thread-dated-text")).toHaveText("Due Saturday · Electricity bill");
      if (SHOTS) {
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-reader-light.png` });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-reader-dark.png` });
        await page.emulateMedia({ colorScheme: "light" });
      }
      expect((await new AxeBuilder({ page }).include("[data-testid=thread-dated]").analyze()).violations).toEqual([]);
      // the third panel round: Later beside Done and Remove, on their line, with the item's presets and a day of your own
      const later = line.getByTestId("thread-dated-later");
      await expect(later).toHaveAccessibleName("Later: Electricity bill");
      const box = async (id: string) => line.getByTestId(id).evaluate((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
      expect(await box("thread-dated-later")).toEqual(await box("thread-dated-done"));
      expect(await box("thread-dated-later")).toEqual(await box("thread-dated-dismiss"));
      // keyboard: Tab from Done reaches it, Enter opens it
      await line.getByTestId("thread-dated-done").focus();
      await page.keyboard.press("Tab");
      await expect(later).toBeFocused();
      await page.keyboard.press("Enter");
      const menu = page.getByTestId("thread-dated-later-menu");
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveText([/^Later today/, /^Tomorrow/, /^This weekend/, /^Next week/, "Pick a date…"]);
      if (SHOTS) {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-reader-later-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      expect((await new AxeBuilder({ page }).include("[data-testid=thread-dated-later-menu]").analyze()).violations).toEqual([]);
      // Escape gives the keys back to Later, as the follow-up's Later
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(later).toBeFocused();
      // Tomorrow: the item leaves What matters as from its own menu, and z brings it back, open with its line
      await later.click();
      await page.getByTestId("thread-dated-later-tomorrow").click();
      await leftSoon(page, "Electricity bill");
      await expect(page.locator("[data-testid=snack]")).toContainText("Later: Electricity bill");
      await expect.poll(async () => (await server.backend.store.dated.active()).find((r) => r.text === "Electricity bill")?.deferredUntil ?? null).not.toBeNull();
      await focusList(page);
      await page.keyboard.press("z");
      await expect(open(page)).toContainText("Electricity bill");
      await expect(line.getByTestId("thread-dated-text")).toHaveText("Due Saturday · Electricity bill");
      await expect.poll(async () => (await server.backend.store.dated.active()).find((r) => r.text === "Electricity bill")?.deferredUntil).toBeNull();
      // Pick a date…: the reminder's own fields, in a popover by Later
      await later.click();
      await page.getByTestId("thread-dated-later-pick").click();
      const custom = page.getByTestId("thread-dated-later-custom");
      await expect(custom).toBeVisible();
      await expect(custom.getByTestId("thread-dated-later-date")).toBeVisible();
      if (SHOTS) {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-reader-pick-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      await page.keyboard.press("Escape");
      await expect(custom).toHaveCount(0);
      await expect(later).toBeFocused();
      // Done here: the item leaves What matters at once (not held in place: the user finished it)
      await line.getByTestId("thread-dated-done").click();
      await expect(item(page, "Electricity bill")).toHaveCount(0);
      await expect(page.locator("[data-testid=snack]")).toContainText("Done: Electricity bill");
    });

    await scenario("a person's ask (the third panel round): Needs you, in its words, the day it came; its line in the conversation", async () => {
      await received(server, "ask-1", { name: "Mariana Paz", email: "mariana@studio.test" }, "Rebranding", "Hi! Can you send me a quote for the rebranding?");
      server.backend.dated.wake();
      // (plan 210, iteration 3: Today's "Waiting on you")
      await expect.poll(() => groupOf(page, "Answer Mariana Paz"), { timeout: 15_000 }).toBe("waiting");
      await show(page, "Answer Mariana Paz");
      const ask = item(page, "Answer Mariana Paz");
      await expect(ask.getByTestId("wm-sentence")).toHaveText("Answer Mariana Paz.");
      await expect(ask.getByTestId("wm-meta")).toHaveText("Mariana Paz");
      // no day to say: the right column is since when it came, quietly
      await expect(ask).toHaveAttribute("data-tone", "none");
      await expect(ask.getByTestId("wm-when")).toHaveText(/^since /);
      await ask.click();
      const line = page.getByTestId("thread-dated");
      await expect(line.getByTestId("thread-dated-item")).toHaveAttribute("data-kind", "ask");
      await expect(line.getByTestId("thread-dated-text")).toHaveText("Answer Mariana Paz");
      if (SHOTS) {
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-ask-light.png` });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-ask-dark.png` });
        await page.emulateMedia({ colorScheme: "light" });
      }
      await line.getByTestId("thread-dated-done").click();
      await expect(item(page, "Answer Mariana Paz")).toHaveCount(0);
      if (await page.getByTestId("reader").count()) await page.keyboard.press("Escape");
    });

    /** the fifth panel round: Jess's draft and her board meeting, from one mail */
    const jess = () => item(page, "Send Jess your draft");
    await scenario("plan 210 (iteration 2): two items of one conversation are two rows: each opens it, the reader's line marks its own; j/k walk them, a second click puts the open one away; D on one leaves the other, z brings it back", async () => {
      const store = server.backend.store;
      const m = await received(server, "board-1", { name: "Jess Okafor", email: "jess@board.test" }, "Board meeting", "Board meeting is locked: Saturday at 8:00. Could you send me your draft by Saturday?", false);
      await store.dated.marks.queueScan([m.id], E2E_NOW);
      const DAY = 86_400_000;
      const saturday = new Date(2026, 9, 24, 9, 0).getTime();
      const meeting = new Date(2026, 9, 24, 8, 0).getTime();
      const rows = [
        { kind: "respond" as const, item: 0, text: "Send Jess your draft", quote: "send me your draft by Saturday", dueDay: "2026-10-24", dueAt: saturday, timed: false, dated: true, actAt: saturday - 7 * DAY },
        { kind: "event" as const, item: 1, text: "Board meeting", quote: "Board meeting is locked", dueDay: "2026-10-24", dueAt: meeting, timed: true, dated: true, actAt: saturday - 7 * DAY },
      ];
      expect(await store.dated.finish({ messageId: m.id, threadId: m.thread_id, fromScan: true, rows, settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
      server.backend.today.changed();
      await expect.poll(async () => (await server.backend.today.list([])).sections.flatMap((s) => s.items).filter((i) => i.thread.id === m.thread_id).length).toBe(2);
      await show(page, "Send Jess your draft");
      const board = () => page.locator(`${FEED} [data-testid=wm-item]:not([data-history])`).filter({ has: page.locator("[data-testid=wm-sentence]", { hasText: /^Board meeting\.$/ }) });
      // two rows, one conversation, each its own id; no Also on either (a related detail only)
      await expect(jess()).toHaveAttribute("data-thread-id", String(m.thread_id));
      await expect(board()).toHaveAttribute("data-thread-id", String(m.thread_id));
      const [draftId, boardId] = [await jess().getAttribute("data-row-id"), await board().getAttribute("data-row-id")];
      expect(draftId).not.toBe(boardId);
      await expect(jess().getByTestId("wm-meta")).toHaveText("Jess Okafor");
      if (SHOTS) {
        await jess().scrollIntoViewIfNeeded();
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-two-rows-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      // the draft opens the conversation, the reader's line marking the draft
      await jess().click();
      await expect(jess()).toHaveAttribute("data-open", "true");
      await expect(board()).not.toHaveAttribute("data-open", "true");
      const target = page.locator("[data-testid=thread-dated-item][data-target]");
      await expect(target).toHaveCount(1);
      await expect(target.getByTestId("thread-dated-text")).toContainText("Send Jess your draft");
      // plan 210 (iteration 3, Codex revision 10): the row's item is the one line on top, with the one Done; the meeting is
      // the quiet line under it
      const also = page.getByTestId("thread-dated-also");
      await expect(page.getByTestId("thread-dated-item")).toHaveCount(1);
      await expect(page.getByTestId("thread-dated-done")).toHaveCount(1);
      await expect(also).toContainText("Also in this conversation");
      await expect(also.getByTestId("thread-dated-also-item")).toHaveText(["Saturday 8:00 AM · Board meeting"]);
      for (const mode of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        expect((await new AxeBuilder({ page }).include("[data-testid=thread-dated]").analyze()).violations, mode).toEqual([]);
      }
      await page.emulateMedia({ colorScheme: "light" });
      // the meeting's row: the same conversation, its line now the meeting's, nothing reopened
      const subject = await page.getByTestId("reader-subject").innerText();
      await board().click();
      await expect(board()).toHaveAttribute("data-open", "true");
      await expect(jess()).not.toHaveAttribute("data-open", "true");
      await expect(page.getByTestId("reader-subject")).toHaveText(subject);
      await expect(target.getByTestId("thread-dated-text")).toContainText("Board meeting");
      await expect(page.getByTestId("thread-dated-done")).toHaveCount(1);
      await expect(also.getByTestId("thread-dated-also-item")).toHaveText([/Send Jess your draft$/]);
      // chosen from the line under it, the draft leads, and the feed's open row is its row (the keys act on it)
      await also.getByTestId("thread-dated-also-item").click();
      await expect(target.getByTestId("thread-dated-text")).toContainText("Send Jess your draft");
      await expect(jess()).toHaveAttribute("data-open", "true");
      await expect(board()).not.toHaveAttribute("data-open", "true");
      await expect(page.getByTestId("thread-dated-done")).toBeFocused();
      await expect(also.getByTestId("thread-dated-also-item")).toHaveText(["Saturday 8:00 AM · Board meeting"]);
      // Done on the top line: the draft goes, the meeting stays (now the line, alone), Undo brings the draft back
      await page.getByTestId("thread-dated-done").click();
      await expect(page.locator("[data-testid=snack]")).toContainText("Done: Send Jess your draft");
      await expect(jess()).toHaveCount(0);
      await expect(board()).toHaveCount(1);
      await focusList(page);
      await page.keyboard.press("z");
      await expect(jess()).toHaveCount(1);
      await expect.poll(async () => (await store.dated.ofThread(m.thread_id)).map((r) => r.text).sort()).toEqual(["Board meeting", "Send Jess your draft"]);
      await board().click();
      await expect(board()).toHaveAttribute("data-open", "true");
      if (SHOTS) {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-two-rows-open-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      // a second click puts it away
      await board().click();
      await expect(page.locator(`${FEED} [data-testid=wm-item][data-open]`)).toHaveCount(0);
      // j/k walk rows: from the draft down to the meeting, two steps of one conversation, and back
      const order = async () => page.locator(`${FEED} [data-testid=wm-item]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-row-id")));
      const ids = await order();
      const steps = ids.indexOf(boardId) - ids.indexOf(draftId);
      expect(steps).toBeGreaterThan(0);
      await jess().click();
      await focusList(page);
      for (let i = 0; i < steps; i++) await page.keyboard.press("j");
      await expect(board()).toHaveAttribute("data-open", "true");
      for (let i = 0; i < steps; i++) await page.keyboard.press("k");
      await expect(jess()).toHaveAttribute("data-open", "true");
      // D on the draft: it goes, the meeting of its conversation stays; z, back
      await page.keyboard.press("d");
      await expect(page.locator("[data-testid=snack]")).toContainText("Done: Send Jess your draft");
      await expect(jess()).toHaveCount(0);
      await expect(board()).toHaveCount(1);
      await expect.poll(async () => (await store.dated.ofThread(m.thread_id)).map((r) => r.text)).toEqual(["Board meeting"]);
      await page.keyboard.press("z");
      await expect(jess()).toHaveCount(1);
      await expect(board()).toHaveCount(1);
      await page.keyboard.press("Escape");

      // an alert that named no day is Today's while it shows, its column since when it came, quietly (plan 210)
      await received(server, "alert-1", { name: "Tri-River", email: "alerts@tririverfcu.org" }, "Card payment failed", "Your card payment failed at Corner Market.");
      server.backend.dated.wake();
      await expect.poll(() => groupOf(page, "Card payment failed"), { timeout: 15_000 }).toBe("today");
      await toTop(page);
      const alert = item(page, "Card payment failed");
      await expect(alert.getByTestId("wm-sentence")).toHaveText("Card payment failed, the email says.");
      await expect(alert.getByTestId("wm-when")).toHaveText(/^since /);
      await expect(alert).toHaveAttribute("data-tone", "none");
    });

    await scenario("plan 210 (iteration 2): one dinner read from two conversations is one row; Done finishes both, z brings both back", async () => {
      const store = server.backend.store;
      const dinner = new Date(2026, 9, 24, 19, 30).getTime();
      const add = async (key: string, from: { name: string; email: string }, text: string) => {
        const m = await received(server, key, from, "Friday", `${text} Saturday 7:30 PM.`, false);
        await store.dated.marks.queueScan([m.id], E2E_NOW);
        const row = { kind: "event" as const, item: 0, text, quote: text, dueDay: "2026-10-24", dueAt: dinner, timed: true, dated: true, actAt: E2E_NOW };
        expect(await store.dated.finish({ messageId: m.id, threadId: m.thread_id, fromScan: true, rows: [row], settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
      };
      await add("nopa-1", { name: "Nopa", email: "reservations@nopa.test" }, "Dinner reservation at Nopa");
      await add("nopa-2", { name: "Jess Okafor", email: "jess@board.test" }, "Dinner with Jess at Nopa");
      server.backend.today.changed();
      const dinners = page.locator(`${FEED} [data-testid=wm-item]:not([data-history])`).filter({ hasText: /Nopa/ });
      await show(page, "Dinner reservation at Nopa");
      await expect(dinners).toHaveCount(1);
      await dinners.hover();
      await dinners.getByTestId("wm-done").click();
      await expect(page.locator("[data-testid=snack]")).toContainText("Done: Dinner reservation at Nopa");
      await expect(dinners).toHaveCount(0);
      await expect.poll(async () => (await store.dated.active()).filter((r) => /Nopa/.test(r.text)).length).toBe(0);
      await focusList(page);
      await page.keyboard.press("z");
      await expect.poll(async () => (await store.dated.active()).filter((r) => /Nopa/.test(r.text)).length).toBe(2);
      await expect(dinners).toHaveCount(1);
    });

    await scenario("Settings → What matters: what it looks for, on, naming who reads the mail; not in AI any more", async () => {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await expect(page.getByTestId("ai-tab")).toBeVisible();
      await expect(page.getByTestId("ai-dated")).toHaveCount(0);
      await expect(page.getByTestId("ai-digest")).toHaveCount(0);
      await page.getByTestId("tab-whatMatters").click();
      const group = page.getByTestId("ai-dated");
      // plan 247: the group says what it's for; who reads its mail beside the switch and in full below it
      await expect(group).toContainText("What it looks for");
      await expect(group.getByTestId("ai-dated-switch")).toBeChecked();
      await expect(group).toContainText(/Read by \S/);
      await expect(group.getByTestId("today-privacy")).toContainText("To find bills, trips and requests, Terno");
      await expect(group).not.toContainText("digest");
      await group.scrollIntoViewIfNeeded();
      if (SHOTS) {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await group.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-settings-${mode}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      expect((await new AxeBuilder({ page }).include("[data-testid=ai-dated]").analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
    });

    // the screenshots AGENTS.md asks for: the groups, in every design, light and dark, at 1440 and 1100 (looked at, not compared)
    if (SHOTS) {
      test.setTimeout(240_000);
      for (const design of ["macos", "atelier", "lumen", "luma", "graphite", "relief"] as const) {
        await settingUp(page, server, { design });
        await expect(page.locator(`html[data-design=${design}]`)).toHaveCount(1);
        await page.getByTestId("nav-today").click();
        await show(page, "Send Jess your draft");
        for (const width of [1440, 1100]) {
          await page.setViewportSize({ width, height: 900 });
          for (const mode of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: mode });
            await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-${design}-${width}-${mode}.png` });
          }
        }
        // plan 274: Coming up open at the feed's end, its title over its quiet days, in each design
        await page.setViewportSize({ width: 1100, height: 900 });
        await toEnd(page);
        if ((await page.getByTestId("wm-coming-up").getAttribute("aria-expanded")) !== "true") await page.getByTestId("wm-coming-up").click();
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await toEnd(page);
          await page.getByTestId("wm-coming-up").evaluate((el) => el.scrollIntoView({ block: "center" }));
          await expect(page.getByTestId("wm-coming-up")).toBeInViewport();
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dated-${design}-coming-up-${mode}.png` });
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.emulateMedia({ colorScheme: "light" });
      }
    }
  });
});

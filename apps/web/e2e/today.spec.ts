/**
 * Plan 145 in the page, on the offline fake model. Today for anyone with a provider, nothing without one; ordinary rows
 * under headings; the digest's own row, off and on; Archive all and its Undo.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { inEveryLook, wheelsTo } from "./helpers/looks";
import { unclipped } from "./helpers/unclipped";
import { expect, fresh, ingestConversation, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };
const SHOTS = process.env.TODAY_SHOTS;

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
  return { waiting, db };
}

test.describe("Today (plan 145)", () => {
  test("plan 162: the digest's provenance is whole and its header stays as the list scrolls, in every design, light and dark, 1440 and 1100", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("digest-row")).toContainText("today's digest", { timeout: 15_000 });
    await page.getByTestId("digest-row").click();
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

  test("the row opens sections of ordinary rows, and the digest row reads in the reader", { tag: "@design" }, async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    // the app still opens on the Inbox
    await expect(page.getByTestId("list-title").or(page.getByTestId("list-header")).first()).toBeVisible();
    await page.getByTestId("nav-today").click();
    // plan 162 (after ai162-r02): the list starts with Needs you; the digest's way in is the header's, above the fold
    await expect(page.getByTestId("today-heading").first()).toHaveAttribute("data-kind", "needsYou");
    await expect(page.getByTestId("today-heading").first()).toHaveText("Needs you");
    expect(await page.getByTestId("today-heading").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13);
    // Codex review: a drawn heading can't sit in a listbox, so each section's first row says its name to assistive tech
    await expect(page.locator('[data-keep-scroll="list"] [role=option]').first()).toHaveAccessibleName(/^Needs you, /);
    await expect(page.getByTestId("list-header").getByTestId("digest-row")).toHaveAccessibleName(/^Newsletters, /);
    await expect(page.locator('[data-keep-scroll="list"]').getByTestId("digest-row")).toHaveCount(0);
    await expect(page.getByTestId("thread-row").filter({ hasText: "Can you make the 19th" })).toBeVisible();
    // plan 161: the row says why it needs you (they've written in it). Pass 2: as a label of its own, not the snippet's first words
    await expect(page.getByTestId("thread-row").filter({ hasText: "Can you make the 19th" }).getByTestId("row-why")).toHaveText("They replied");
    // the header says what each number is: the sidebar's count, then how many of them the list shows if it's capped
    // pass 3: one sentence, never a second total to read against the Inbox's: "9 need you", or when capped (plan 162) "Showing 12 of 41"
    await expect(page.getByTestId("today-needs")).toHaveText(/^(The newest \d+ of \d+ that need you|\d+ needs? you)$/);
    const sidebar = (await page.getByTestId("nav-today").innerText()).match(/\d+/)?.[0];
    if (sidebar) await expect(page.getByTestId("today-needs")).toHaveText(new RegExp(`^(The newest \\d+ of ${sidebar} that need you|${sidebar} needs? you)$`));
    await expect(page.getByTestId("today-line")).not.toContainText(/waiting|\d+ to reply/);
    // plan 162 (after ai162-r02): the reason is quiet words, the row's secondary at medium weight, no box (the outlined
    // tag was the loudest thing in every row), then a "·" and the mail's words
    const why = page.getByTestId("thread-row").filter({ hasText: "Can you make the 19th" }).getByTestId("row-why");
    const ink = async (el: typeof why) => el.evaluate((e) => getComputedStyle(e).color);
    expect(await ink(why)).toBe(await ink(page.getByTestId("thread-row").filter({ hasText: "Can you make the 19th" }).getByTestId("row-snippet").locator("span").last()));
    expect(await why.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe("0px");
    await expect(why).toHaveCSS("font-weight", "500");
    await expect(page.getByTestId("thread-row").filter({ hasText: "Can you make the 19th" }).getByTestId("row-snippet")).toContainText("They replied · ");
    // the digest's way in is quieter than any person: its words in the secondary, no ring; in view, a real target
    await expect(page.getByTestId("digest-row")).toContainText("automated");
    await expect(page.getByTestId("digest-row")).toBeInViewport();
    expect((await page.getByTestId("digest-row").boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await expect(page.getByTestId("digest-row")).toHaveCSS("cursor", "pointer");
    await expect(page.getByTestId("digest-row")).not.toHaveAttribute("aria-current");
    // above Needs you's first row, and its glyph on the header's text edge
    expect((await page.getByTestId("digest-row").boundingBox())!.y).toBeLessThan((await page.getByTestId("thread-row").first().boundingBox())!.y);
    const textEdge = await page.getByTestId("today-line").evaluate((e) => e.getBoundingClientRect().left);
    const glyph = await page.getByTestId("digest-row").locator("svg").first().evaluate((e) => e.getBoundingClientRect().left);
    expect(Math.abs(glyph - textEdge)).toBeLessThanOrEqual(1);
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dark.png` });
    }
    for (const mode of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      const results = await new AxeBuilder({ page }).include('[data-keep-scroll="list"]').analyze();
      expect(results.violations.map((v) => `${mode} ${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
    }
    // a heading sits on the rows' own line
    const left = async (testId: string) => page.getByTestId(testId).first().evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
    expect(Math.abs((await left("today-heading")) - (await left("thread-row")))).toBeLessThanOrEqual(1);
    await page.getByTestId("digest-row").click();
    await expect(page.getByTestId("digest-row")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("digest-page")).toBeVisible();
    await expect(page.getByTestId("digest-title")).toHaveText("Automated mail");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-digest-off.png` });
  });

  test("the digest off lists unticked and sends nothing; on, it sorts them, Archive all has one Undo", async ({ app: page, server }) => {
    const { db } = await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("digest-row")).toContainText("today's digest", { timeout: 15_000 });
    await page.getByTestId("digest-row").click();
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
    await expect(page.getByTestId("back-to-digest")).toBeVisible();
    await expect(page.getByTestId("reader-subject")).toHaveText("Stratechery weekly");
    // read after the reader's dwell, as a person reading it would
    await expect.poll(() => db.get<{ u: number }>("SELECT unread_count u FROM threads WHERE subject = ?", "Stratechery weekly")!.u).toBe(0);
    // the owner (plan 161): a newsletter from the digest is mail like any other. Read, it isn't added to Today's list, nor
    // pinned there while it's open. (The digest's row counting one fewer says the list has refreshed since the read.)
    await expect(page.getByTestId("digest-row")).toContainText(new RegExp(`(^|\\D)${count - 1} newsletters? · today's digest`));
    await expect(page.locator('[data-keep-scroll="list"]').getByTestId("thread-row").filter({ hasText: "Stratechery weekly" })).toHaveCount(0);
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
    await expect(page.getByTestId("back-to-digest")).toBeVisible();
    await page.getByTestId("nav-inbox").click();
    await page.getByTestId("thread-row").first().click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await expect(page.getByTestId("back-to-digest")).toHaveCount(0);
  });

  test("owner's decisions (2): Archive, e, Trash and Spam on a newsletter opened from the digest go back to it, where it was, with Undo", async ({ app: page, server }) => {
    const { db } = await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    // short, so the digest scrolls and where it was can be held
    await page.setViewportSize({ width: 1100, height: 340 });
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("digest-row")).toContainText("today's digest", { timeout: 15_000 });
    await page.getByTestId("digest-row").click();
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
        await expect(page.getByTestId("back-to-digest")).toBeVisible();
        await expect(page.getByTestId("reader-subject")).toHaveText("Stratechery weekly");
        // read, as a person reading it (an unread one comes back unread, and ticked)
        await expect.poll(() => db.get<{ u: number }>("SELECT unread_count u FROM threads WHERE subject = ?", "Stratechery weekly")!.u).toBe(0);
        await way.run();
        // not on to Today's first conversation: the digest, as it was left
        await expect(page.getByTestId("digest-page")).toBeVisible();
        await expect(page.getByTestId("reader-subject")).toHaveCount(0);
        await expect(item.getByTestId("digest-open")).toBeFocused();
        expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top);
        // the row says what happened to it, and the snack has the usual Undo
        await expect(item).toHaveAttribute("data-state", "archived");
        await expect(item.getByTestId("digest-state")).toHaveText(way.row);
        await expect(page.getByTestId("snack")).toContainText(way.said);
        await expect.poll(where).toMatchObject(way.gone);
        await page.getByTestId("snack-action").click();
        await expect.poll(where).toMatchObject({ in_inbox: 1, in_trash: 0, in_spam: 0 });
        // exact: the newsletter open again, still from the digest
        await expect(page.getByTestId("reader-subject")).toHaveText("Stratechery weekly");
        await expect(page.getByTestId("back-to-digest")).toBeVisible();
        await page.getByTestId("back-to-digest").click();
        await expect(item.getByTestId("digest-open")).toBeFocused();
        await expect(item).toHaveAttribute("data-state", "opened");
      });
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/digest-after-reader-archive.png` });
    // anything else from there is as before: a conversation of Today's own goes on as it always has
    await page.getByTestId("thread-row").filter({ hasText: "Can you make the 19th" }).click();
    await expect(page.getByTestId("back-to-digest")).toHaveCount(0);
  });

  test("plan 162 (after ai162-r02): every way back keeps an opened newsletter out of Archive, at once; the page has the list's keys", async ({ app: page, server }) => {
    const { db } = await withMail(server, 10);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("digest-row")).toContainText("today's digest", { timeout: 15_000 });
    // Needs you leads the list; the digest's way in is above the fold, in the header
    await expect(page.getByTestId("today-heading").first()).toHaveAttribute("data-kind", "needsYou");
    await expect(page.getByTestId("digest-row")).toBeInViewport();
    await page.getByTestId("digest-row").click();
    await expect(page.getByTestId("digest-title")).toHaveText("Today's digest");
    const items = page.getByTestId("digest-item");
    const total = await items.count();
    expect(total).toBeGreaterThanOrEqual(8);
    // the keys go into the page: its first row is the cursor
    await expect(page.getByTestId("digest-open").first()).toBeFocused();
    // j and k move through its rows, never Today's behind it; x ticks the cursor's row
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
    await expect(page.locator('[data-keep-scroll="list"] [data-checked]')).toHaveCount(0);
    const unread = (subject: string) => db.get<{ u: number }>("SELECT unread_count u FROM threads WHERE subject = ?", subject)!.u;
    const subjectOf = async (i: number) => (await items.nth(i).getByTestId("digest-subject").innerText()).trim();
    // each way back, straight back (under the reader's dwell): the row opened stays, said so, and isn't counted
    const ways: [string, () => Promise<void>][] = [
      ["Enter, then Esc", async () => page.keyboard.press("Escape")],
      ["Back to the digest", async () => page.getByTestId("back-to-digest").click()],
      ["the digest's way in", async () => page.getByTestId("digest-row").click()],
    ];
    let kept = 0;
    for (const [i, [way, back]] of ways.entries()) {
      const at = i * 3;
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
    // the page's scroll is kept on the way back, and the cursor stays above the foot bar
    const scroller = page.getByTestId("digest-scroller");
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
    // Esc on the page gives the keys back to the list, at the digest's way in; j then moves Today's list
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("digest-row")).toBeFocused();
    // Archive takes only the ticked; the snack stands on the page's foot bar, not over it
    await page.getByTestId("digest-row").click();
    await page.getByTestId("digest-archive").click();
    await expect(page.getByTestId("snack")).toContainText(`Archived ${total - kept} newsletters`);
    const snackBox = (await page.getByTestId("snack").first().boundingBox())!;
    const footAfter = (await page.getByTestId("digest-actions").boundingBox())!;
    expect(snackBox.y + snackBox.height).toBeLessThanOrEqual(footAfter.y);
    await expect(page.getByTestId("digest-item").filter({ hasText: "Opened · stays in Inbox" })).toHaveCount(kept);
    for (let i = 0; i < 3; i++) expect(db.get<{ n: number }>("SELECT in_inbox n FROM threads WHERE subject = ?", await subjectOf(i))!.n).toBe(1);
  });

  test("plan 162 (after ai162-r02, Codex review): the digest's way in ends a bulk selection, as opening any row does", async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("digest-row")).toContainText("today's digest", { timeout: 15_000 });
    await page.getByTestId("thread-row").nth(0).click({ modifiers: ["ControlOrMeta"] });
    await page.getByTestId("thread-row").nth(1).click({ modifiers: ["ControlOrMeta"] });
    await expect(page.locator('[data-keep-scroll="list"] [data-checked]')).not.toHaveCount(0);
    await page.getByTestId("digest-row").click();
    await expect(page.getByTestId("digest-page")).toBeVisible();
    await expect(page.locator('[data-keep-scroll="list"] [data-checked]')).toHaveCount(0);
  });

  test("ai-r03: the digest scrolls in its pane, so its last row and its box are reachable by the wheel in a short window", async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.setViewportSize({ width: 1100, height: 340 });
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("digest-row")).toContainText("today's digest", { timeout: 15_000 });
    await page.getByTestId("digest-row").click();
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

  test("the row's selection and keys stay on threads: Select All never takes the digest", async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("digest-row")).toBeVisible();
    const asked: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || /Too small/.test(m.text())) asked.push(m.text());
    });
    await page.getByTestId("digest-row").click();
    await page.keyboard.press("e");
    await expect(page.getByTestId("digest-page")).toBeVisible();
    // a refresh with the digest's row selected: it's not a thread, and the rows stay
    server.backend.notifyChanged([]);
    await expect(page.getByTestId("digest-row")).toBeVisible();
    expect(asked.filter((a) => /Too small|VALIDATION|invalid/i.test(a))).toEqual([]);
    await page.locator('[data-keep-scroll="list"]').focus();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(page.getByTestId("digest-row")).not.toHaveAttribute("data-checked");
  });
});

test.describe("Today in List (plan 162, after ai162-r02, Codex review)", () => {
  test.use({ layout: "list" });
  test("the digest is a page over the list: Esc closes it, back to the list at its way in", async ({ app: page, server }) => {
    await withMail(server);
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, today: { digest: true, prepareAt: "00:00" } });
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("digest-row")).toContainText("today's digest", { timeout: 15_000 });
    await page.getByTestId("digest-row").click();
    await expect(page.getByTestId("digest-page")).toBeVisible();
    // its keys while it's open: j moves its cursor, not the list under it
    await expect(page.getByTestId("digest-open").first()).toBeFocused();
    await page.keyboard.press("j");
    await expect(page.getByTestId("digest-open").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("digest-page")).toHaveCount(0);
    await expect(page.getByTestId("digest-row")).toBeVisible();
  });
});

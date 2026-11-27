/**
 * Plan 142 in the page, on the offline fake model and the demo's provider: nothing here reaches a real provider. A promise
 * is sent, comes due on the Inbox's top, is opened, done and undone; a wait is nudged without anything being sent.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { SettingsPatch } from "@terno/core/rpc";
import { expect, fresh, focusList, ingestConversation, rows, scenario, test, type DevServerFixture } from "./fixtures";
import { E2E_NOW } from "./constants";
import { unclipped } from "./helpers/unclipped";
import { fakeDraft } from "../../../packages/ai/src/fake";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const SHOTS = process.env.FOLLOWUP_SHOTS;

async function settingUp(page: Page, server: DevServerFixture, patch: SettingsPatch) {
  await server.backend.server.invoke("settings.update", patch, dev);
  await fresh(page);
}

/** What the worker found, written as it would be: the same store path, with no wait for the fake's timing. */
async function tracked(server: DevServerFixture, subject: string, kind: "promise" | "awaiting", due: boolean) {
  await ingestConversation(server, { subject, count: 2, now: E2E_NOW });
  const store = server.backend.store;
  const { items } = await store.threads.searchText({ query: `subject:"${subject}"`, limit: 1, now: E2E_NOW });
  const threadId = items[0]!.id;
  const thread = await store.threads.get(threadId);
  const message = thread!.messages.at(-1)!;
  await store.followups.marks.queueScan([message.id], E2E_NOW);
  // a live one, as far as the top goes: not from a check
  await store.followups.finish({ messageId: message.id, threadId, fromScan: false, rows: [{ kind, item: kind === "promise" ? 0 : 100, text: "send the contract", quote: kind === "promise" ? "I'll send the contract" : null, personName: "Tom Reed", personEmail: "tom.reed@example.com", dueAt: due ? E2E_NOW - 1000 : E2E_NOW + 86_400_000, dated: false }], kept: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
  await server.backend.followups.look();
  return threadId;
}

/**
 * Plan 280: a promise of theirs the worker found in Yuki's mail, written as it would be. `later`: Yuki wrote again after it.
 * `debtor`: someone else promised it, the conversation going on with you and Yuki (its last sender)
 */
async function owedTracked(server: DevServerFixture, subject: string, o: { firm: boolean; later?: boolean; debtor?: { name: string; email: string }; unread?: boolean }) {
  await ingestConversation(server, { subject, count: o.later || o.debtor ? 3 : 1, ...(o.debtor ? { from: { 0: o.debtor } } : {}), ...(o.unread ? { unread: 1 } : {}), now: E2E_NOW });
  const store = server.backend.store;
  const { items } = await store.threads.searchText({ query: `subject:"${subject}"`, limit: 1, now: E2E_NOW });
  const threadId = items[0]!.id;
  const message = (await store.threads.get(threadId))!.messages[0]!;
  await store.followups.owed.marks.queueScan([message.id], E2E_NOW);
  const day = new Date(E2E_NOW - 3 * 86_400_000);
  const dueDay = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  await store.followups.owed.finish({ messageId: message.id, threadId, fromScan: false, rows: [{ item: 200, text: "send you the contract", quote: "te mando el contrato", personName: message.from.name, personEmail: message.from.email, dueAt: E2E_NOW - 1000, dated: true, dueDay, firm: o.firm }], kept: [], moved: [], withdrawn: [], hints: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
  await server.backend.followups.look();
  return threadId;
}

test.describe("follow-ups (plan 142)", () => {
  test("a due promise: on the Inbox's top with its line, opening ends the row and the list keeps it, Done and Undo, the thread's line", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true } });
    await tracked(server, "The contract", "promise", true);
    await fresh(page);

    await scenario("on top, under the heading, saying what's owed", async () => {
      await expect(page.getByTestId("inbox-reminders-label")).toBeVisible();
      await expect(rows(page).first()).toContainText("You told Tom Reed you’d send the contract");
      // a reminder set for next month on the same thread doesn't speak for it: what brought it here does
      const id = Number(await rows(page).first().getAttribute("data-thread-id"));
      await server.backend.server.invoke("reminders.set", { threadIds: [id], dueAt: E2E_NOW + 30 * 86_400_000, kind: "always" }, dev);
      await expect(rows(page).first().getByTestId("row-date")).toHaveAttribute("data-due-at", /\d+/);
      await expect(rows(page).first().getByTestId("row-reminder")).toHaveCount(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-top-light.png` });
    });

    await scenario("the thread's line: the promise on the reader's one line, with its actions", async () => {
      await rows(page).first().click();
      // plan 210 (iteration 3, Codex revision 10): a promise is one of the conversation's items, in the dated line's one
      // design; the nudges' card isn't drawn for it
      const line = page.getByTestId("thread-dated-item");
      await expect(line).toHaveAttribute("data-source", "promise");
      await expect(page.getByTestId("followup-line")).toHaveCount(0);
      // the fourth panel round (revision 10): a promise that named no day says none, never the moment it's placed at; the
      // person once, by their first name
      await expect(line.getByTestId("thread-dated-text")).toHaveText("You told Tom you’d send the contract");
      // one vocabulary with the conversation's dated line, in its weights: Done outlined, Later and Remove quiet
      await expect(line.getByTestId("thread-dated-done")).toHaveText("Done");
      await expect(line.getByTestId("thread-dated-later")).toHaveText("Later");
      await expect(line.getByTestId("thread-dated-dismiss")).toHaveText("Remove");
      const look = (id: string) => page.getByTestId(id).evaluate((el) => { const s = getComputedStyle(el); return { color: s.color, border: s.borderTopColor, background: s.backgroundColor }; });
      expect(await look("thread-dated-later")).toEqual(await look("thread-dated-dismiss"));
      expect((await look("thread-dated-done")).border).not.toBe("rgba(0, 0, 0, 0)");
      expect((await look("thread-dated-dismiss")).border).toBe("rgba(0, 0, 0, 0)");
      // plan 161, pass 3: on the AI card, as Reply ready is: its edge on the subject's line, its text inset
      const left = async (id: string) => (await page.getByTestId(id).first().boundingBox())!.x;
      expect(Math.abs((await left("thread-dated")) - (await left("reader-subject")))).toBeLessThanOrEqual(1);
      expect((await left("thread-dated-text")) - (await left("thread-dated"))).toBeGreaterThanOrEqual(12);
      if (SHOTS) {
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-thread-light.png` });
        await page.emulateMedia({ colorScheme: "dark" });
        await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-thread-dark.png` });
        await page.emulateMedia({ colorScheme: "light" });
      }
      expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=thread-dated]").analyze()).violations).toEqual([]);
    });

    await scenario("opening ended the top; Follow-ups keeps it", async () => {
      await expect.poll(async () => (await server.backend.store.followups.active())[0]!.inboxState).toBe("seen");
      await page.getByTestId("palette-go-followups").or(page.getByTestId("nav-followups")).first().click();
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText("You told Tom Reed");
    });

    await scenario("Done, with Undo that puts the row back", async () => {
      await rows(page).first().click();
      await page.getByTestId("thread-dated-done").click();
      await expect(page.getByTestId("thread-dated")).toHaveCount(0);
      await page.locator("[data-testid=snack]").getByRole("button", { name: /undo/i }).click();
      await expect(page.getByTestId("thread-dated-item")).toBeVisible();
    });

    await scenario("plan 277: archived from Follow-ups, it stays in the list and its count; deleted, both go and Undo brings them back", async () => {
      const count = page.getByTestId("nav-followups").locator("[data-slot=nav-count]");
      await expect(count).toHaveText("1");
      // (plan 280, the QA panel: what it counts, said)
      await expect(page.getByTestId("nav-followups")).toHaveAccessibleDescription("1 late");
      const threadId = (await server.backend.store.followups.active())[0]!.threadId;
      await page.getByTestId("action-archive").click();
      // the archive landed: the conversation is out of the Inbox, its follow-up still tracked
      await expect.poll(async () => (await server.backend.store.threads.get(threadId))!.thread.inInbox).toBe(false);
      await expect.poll(async () => (await server.backend.store.followups.active()).map((r) => r.threadId)).toEqual([threadId]);
      // read afresh, not the list from before the archive (Codex code review)
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("palette-go-followups").or(page.getByTestId("nav-followups")).first().click();
      await expect(rows(page)).toHaveCount(1);
      await expect(count).toHaveText("1");
      await rows(page).first().click();
      await page.getByTestId("action-trash").click();
      await expect(rows(page)).toHaveCount(0);
      await expect(count).toHaveCount(0);
      await page.locator("[data-testid=snack]").getByRole("button", { name: /undo/i }).click();
      await expect(rows(page)).toHaveCount(1);
      await expect(count).toHaveText("1");
    });
  });

  test("a wait: its line says how long, Nudge opens a draft on the thread and sends nothing", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true } });
    await tracked(server, "Are you in", "awaiting", true);
    await fresh(page);
    await rows(page).first().click();
    // sent moments ago in this conversation: "yet", never "in 1 day" (plan 161; whole days are a unit test)
    await expect(page.getByTestId("followup-text")).toHaveText("Waiting for Tom Reed’s reply");
    const sends = (await server.backend.store.debug.snapshot()).messages.filter((m) => m.isSent).length;
    await expect(page.getByTestId("followup-nudge")).toHaveText("Write a follow-up");
    await page.getByTestId("followup-nudge").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("composer")).toContainText("Tom Reed");
    expect((await server.backend.store.debug.snapshot()).messages.filter((m) => m.isSent).length).toBe(sends);
  });

  test.describe("plan 161: the line's anatomy", () => {
    test.use({ tips: true });
    test("a fresh wait: when it comes back and what does, buttons at 28 px, Open message named, and a tip for a wait under the line", async ({ app: page, server }) => {
      await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true } });
      const threadId = await tracked(server, "Coffee next week", "awaiting", false);
      await fresh(page);
      await page.locator(`[data-thread-id="${threadId}"]`).first().click();
      // pass 3: the fact first, as the card's title; when it comes back, and on what, under it
      await expect(page.getByTestId("followup-header")).toHaveText("Waiting for Tom Reed’s reply");
      await expect(page.getByTestId("followup-due")).toHaveText(/^Comes back to your Inbox (Tomorrow|Today) \d.* if there’s no reply$/);
      expect((await page.getByTestId("followup-header").boundingBox())!.y).toBeLessThan((await page.getByTestId("followup-due").boundingBox())!.y);
      await expect(page.getByTestId("followup-nudge")).toHaveText("Write a follow-up");
      // pass 3: the source named for where it goes, whose message and when
      await expect(page.getByTestId("followup-go")).toHaveText(/^Your message, /);
      for (const id of ["followup-nudge", "followup-later", "followup-dismiss", "followup-go"]) {
        expect((await page.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(28);
      }
      // the tip teaches this kind (no Done on a wait) and sits under the line, not over the list
      const tip = page.getByTestId("tip-followups-first");
      await expect(tip).toBeVisible();
      await expect(tip).toContainText("Terno watches for replies");
      await expect(tip).toContainText("Write a follow-up");
      await expect(tip).not.toContainText("Done");
      const line = (await page.getByTestId("followup-line").boundingBox())!;
      const box = (await tip.boundingBox())!;
      expect(box.y).toBeGreaterThan(line.y);
      expect(box.x).toBeGreaterThanOrEqual(line.x - 24);
      await page.getByTestId("tip-done").click();
      // who found it, at the row's end: the one provenance control, its popover the model and when
      await page.getByTestId("followup-provenance").click();
      await expect(page.getByTestId("followup-provenance-popover")).toContainText(/^Found by demo in mail you sent, .*It can make mistakes\.$/);
      await page.keyboard.press("Escape");
      // one hairline under the section at most: the message's own
      expect(await page.getByTestId("thread-followups").evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("0px");
      // the owner, 2026-11-19: Your message marks the message it goes to, already on screen as here (the scroll alone
      // showed nothing): a ring breathes around it, then goes
      const ring = (el: Element) => getComputedStyle(el, "::after").content;
      const mine = page.locator("article[data-message-id]").last();
      expect(await mine.evaluate(ring)).toBe("none");
      await page.getByTestId("followup-go").click();
      await expect.poll(() => mine.evaluate(ring)).toBe('""');
      await expect.poll(() => mine.evaluate(ring), { timeout: 4000 }).toBe("none");
      // again: the ring comes back, its breaths starting over
      await page.getByTestId("followup-go").click();
      await expect.poll(() => mine.evaluate(ring)).toBe('""');
    });
  });

  test("plan 161, pass 2: Later shows its times, and a drafted nudge is offered rather than another", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true } });
    const threadId = await tracked(server, "Lunch on Friday", "awaiting", false);
    await fresh(page);
    await scenario("Later's choices each say when they resolve to", async () => {
      await page.locator(`[data-thread-id="${threadId}"]`).first().click();
      await page.getByTestId("followup-later").click();
      const items = page.getByTestId("followup-later-menu").getByRole("menuitem").filter({ has: page.getByTestId("followup-later-when") });
      await expect(items.first()).toBeVisible();
      for (const when of await page.getByTestId("followup-later-when").all()) await expect(when).toHaveText(/\d{1,2}:\d{2}/);
      expect(await page.getByTestId("followup-later-when").count()).toBe(await items.count());
      await page.keyboard.press("Escape");
    });
    await scenario("plan 162: Later to any moment, through the reminder's own date and time", async () => {
      await page.getByTestId("followup-later").click();
      await page.getByTestId("followup-later-pick").click();
      await expect(page.getByTestId("followup-later-custom")).toBeVisible();
      await expect(page.getByTestId("followup-later-date")).toBeVisible();
      await expect(page.getByTestId("followup-later-time")).toBeVisible();
      const before = (await server.backend.server.invoke("followups.list", {}, dev)) as { rows: { threadId: number; dueAt: number }[] };
      const was = before.rows.find((r) => r.threadId === threadId)!.dueAt;
      await page.getByTestId("followup-later-set").click();
      await expect(page.getByTestId("followup-later-custom")).toHaveCount(0);
      await expect(page.locator("[data-testid=snack]").filter({ hasText: /^Back on top of your Inbox/ })).toBeVisible();
      await expect.poll(async () => ((await server.backend.server.invoke("followups.list", {}, dev)) as { rows: { threadId: number; dueAt: number }[] }).rows.find((r) => r.threadId === threadId)?.dueAt).not.toBe(was);
      // Codex review: a moment that passes while the picker is open says so, and isn't set
      await page.getByTestId("followup-later").click();
      await page.getByTestId("followup-later-pick").click();
      await expect(page.getByTestId("followup-later-set")).toBeEnabled();
      const now = (await server.backend.server.invoke("followups.list", {}, dev)) as { rows: { threadId: number; dueAt: number }[] };
      await page.clock.setFixedTime(new Date(E2E_NOW + 3 * 86_400_000));
      await page.getByTestId("followup-later-set").click();
      await expect(page.getByTestId("followup-later-past")).toHaveText("Pick a time in the future.");
      await expect(page.getByTestId("followup-later-set")).toBeDisabled();
      await expect(page.getByTestId("followup-later-custom")).toBeVisible();
      expect(((await server.backend.server.invoke("followups.list", {}, dev)) as typeof now).rows.find((r) => r.threadId === threadId)?.dueAt).toBe(now.rows.find((r) => r.threadId === threadId)?.dueAt);
      await page.keyboard.press("Escape");
      await page.clock.setFixedTime(new Date(E2E_NOW));
    });
    await scenario("Write a follow-up, then the line offers that draft; discarded, it's Write a follow-up again", async () => {
      // plan 162 (after ai162-r05): while it's written, the card's button says so in words, with no spinner of its own:
      // the composer's is the one working mark
      fakeDraft.firstTokenMs = 3_000;
      try {
        await page.getByTestId("followup-nudge").click();
        // read at one moment: the card's button and the composer's row, while both say it's writing
        const seen = await (await page.waitForFunction(() => {
          const button = document.querySelector('[data-testid="followup-nudging"]');
          const row = document.querySelector('[data-testid="ai-row-status"]');
          return button && row && { text: button.textContent, disabled: button.getAttribute("aria-disabled"), buttonSpinners: button.querySelectorAll("[data-slot=spinner]").length, rowSpinners: row.querySelectorAll("[data-slot=spinner]").length };
        })).jsonValue();
        expect(seen).toEqual({ text: "Writing your follow-up…", disabled: "true", buttonSpinners: 0, rowSpinners: 1 });
      } finally {
        fakeDraft.firstTokenMs = 0;
      }
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(page.getByTestId("ai-strip")).toBeVisible();
      await expect(page.getByTestId("followup-nudge")).toHaveCount(0);
      await expect(page.getByTestId("followup-open-nudge")).toHaveText("Open your follow-up");
      await page.locator("[data-reader-scroller]").evaluate((el) => { el.scrollTop = 0; });
      await page.getByTestId("followup-open-nudge").click();
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await expect(page.getByTestId("composer")).toBeInViewport();
      await page.getByTestId("compose-discard").click();
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await expect(page.getByTestId("followup-nudge")).toHaveText("Write a follow-up");
    });
  });

  test("on: Settings asks nothing (the backend checks each account itself; the demo's counts as checked); off hides the row, the list and the lines", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" } });
    await expect(page.getByTestId("nav-followups")).toHaveCount(0);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    const group = page.getByTestId("ai-followups");
    await group.scrollIntoViewIfNeeded();
    await expect(group).toContainText("Sends the text of each message you send, the message it answers, and mail people send you, to Offline demo.");
    await page.getByTestId("ai-followups-switch").click();
    // the Nudge row comes with the switch, and nothing else: no offer, and nothing old read (plan 211)
    await expect(page.getByTestId("ai-followups-nudge")).toBeVisible();
    await expect(group.locator("button:not([role=switch]):not([role=combobox])")).toHaveCount(0);
    expect(await server.backend.store.followups.marks.count()).toBe(0);
    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=ai-followups]").analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await focusList(page);
    await tracked(server, "Hidden when off", "promise", true);
    await server.backend.server.invoke("settings.update", { followups: { enabled: false } }, dev);
    await fresh(page);
    await expect(page.getByTestId("nav-followups")).toHaveCount(0);
    await expect(rows(page).first()).not.toContainText("You told");
  });

  test("the wide list says what's owed too, and when; turning it off leaves the list", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, layout: "list", followups: { enabled: true } });
    await tracked(server, "The contract", "promise", true);
    await fresh(page);
    await expect(rows(page).first()).toContainText("You told Tom Reed you’d send the contract");
    // one owed: the row sits above More, not behind it
    const top = async (id: string) => (await page.getByTestId(id).boundingBox())!.y;
    expect(await top("nav-followups")).toBeLessThan(await top("nav-more"));
    expect(await top("nav-followups")).toBeGreaterThan(await top("nav-sent"));
    await page.getByTestId("nav-followups").click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().getByTestId("row-date")).toHaveAttribute("data-due-at", /\d+/);
    // plan 285: List's row says it's late too
    await expect(rows(page).first().getByTestId("row-late")).toBeVisible();
    // Follow-ups is "all" underneath, but All Mail isn't where you are: it stays behind More
    await expect(page.getByTestId("nav-followups")).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-more-slot="all"]')).toHaveAttribute("inert", "");
    await expect(page.getByTestId("nav-all")).toBeHidden();
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    await page.getByTestId("ai-followups-switch").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("nav-followups")).toHaveCount(0);
    await expect(page.getByTestId("list-title")).toHaveText("Inbox");
    await expect(rows(page).first()).not.toContainText("You told");
  });

  test("Spanish: the list and the line in Spanish", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, language: "es", followups: { enabled: true } });
    await tracked(server, "El contrato", "promise", true);
    await fresh(page);
    await expect(rows(page).first()).toContainText("Le dijiste a Tom Reed que ibas a send the contract");
    await expect(page.getByTestId("nav-followups")).toContainText("Seguimientos");
  });

  test("the line beside its neighbours in every design; plan 161, pass 3: nothing in its menu or popover is clipped, light and dark, 1440 and 1100", { tag: "@design" }, async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true } });
    // plan 210 (iteration 3): a wait's card (a promise is on the reader's line, its Later today.spec's)
    await tracked(server, "The contract", "awaiting", true);
    await fresh(page);
    await rows(page).first().click();
    await expect(page.getByTestId("followup-line")).toBeVisible();
    // ai-r02: Later's menu (Reschedule's then) was its trigger's 128 px, and cut "Later today" to "Lat…" and Next week to nothing
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const size of [{ width: 1440, height: 900 }, { width: 1100, height: 700 }]) {
        await page.setViewportSize(size);
        const where = `${scheme} ${size.width}`;
        await page.getByTestId("followup-later").click();
        const menu = page.getByTestId("followup-later-menu");
        await expect(menu).toBeVisible();
        // plan 162: and any moment, with the reminder's own fields
        await expect(menu.getByRole("menuitem")).toHaveText([/^Later today/, /^Tomorrow/, /^This weekend/, /^Next week/, "Pick date & time…"]);
        expect(await unclipped(menu), where).toEqual([]);
        await page.getByTestId("followup-later-pick").click();
        const custom = page.getByTestId("followup-later-custom");
        await expect(custom).toBeVisible();
        expect(await unclipped(custom), where).toEqual([]);
        // its Esc closes it alone, and the keys go back to Later
        await page.keyboard.press("Escape");
        await expect(custom).toHaveCount(0);
        await expect(page.getByTestId("followup-later")).toBeFocused();
        await page.getByTestId("followup-provenance").click();
        expect(await unclipped(page.getByTestId("followup-provenance-popover")), where).toEqual([]);
        await page.keyboard.press("Escape");
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 900 });
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dark.png` });
    }
    expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=thread-followups]").analyze()).violations).toEqual([]);
  });

  test("plan 280: owed to you: a late promise of theirs on top with its card, Done and Undo; a tentative one off the top, quiet, under its debtor's name; one they wrote after asks first", async ({ app: page, server }) => {
    await settingUp(page, server, { ai: { provider: "fake", model: "demo" }, followups: { enabled: true } });
    await owedTracked(server, "Signed contract", { firm: true });
    await owedTracked(server, "Draft budget", { firm: false, debtor: { name: "Tom Reed", email: "tom.reed@example.com" }, unread: true });
    await owedTracked(server, "Venue deposit", { firm: true, later: true });
    await fresh(page);

    await scenario("a firm one, late, is on the Inbox's top saying what's owed; a tentative one isn't", async () => {
      await expect(page.getByTestId("inbox-reminders-label")).toBeVisible();
      await expect(page.getByTestId("thread-row").filter({ hasText: "Promised to send you the contract" }).first()).toBeVisible();
      // the two firm ones are the top's; the tentative one stays in its place in the Inbox
      await expect(page.getByTestId("inbox-reminders-label")).toHaveText(/\(2\)/);
    });

    await scenario("its card: what was promised and when, Done first, the reminder the one filled button, Later and Not a promise", async () => {
      await page.getByTestId("thread-row").filter({ hasText: "Signed contract" }).first().click();
      const card = page.getByTestId("followup-line");
      await expect(card).toHaveAttribute("data-kind", "theirs");
      await expect(card.getByTestId("followup-text")).toHaveText("Yuki Gutiérrez promised to send you the contract");
      await expect(card.getByTestId("followup-due")).toHaveText(/^Was due /);
      await expect(card.getByTestId("followup-done")).toHaveText("Done");
      await expect(card.getByTestId("followup-nudge")).toHaveText("Write a follow-up");
      // (the QA panel: one filled button, the likeliest step; nothing says it arrived, so the reminder)
      await expect(card.getByTestId("followup-done")).not.toHaveClass(/\btext-primary-foreground\b/);
      await expect(card.getByTestId("followup-nudge")).toHaveClass(/\btext-primary-foreground\b/);
      await expect(card.getByTestId("followup-dismiss")).toHaveText("Not a promise");
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=followup-line]").analyze()).violations).toEqual([]);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-owed-${scheme}.png` });
      }
      await page.emulateMedia({ colorScheme: "light" });
    });

    await scenario("Done closes it with Undo, which puts it back exactly", async () => {
      await page.getByTestId("followup-done").click();
      await expect(page.getByTestId("followup-line")).toHaveCount(0);
      await expect(page.getByTestId("snack-message")).toHaveText("Marked as done");
      await page.getByRole("button", { name: "Undo this follow-up" }).click();
      await expect(page.getByTestId("followup-line")).toHaveAttribute("data-kind", "theirs");
    });

    await scenario("they wrote after it: the card asks whether it arrived, Done filled, the reminder still there (the QA panel)", async () => {
      await page.getByTestId("thread-row").filter({ hasText: "Venue deposit" }).first().click();
      const card = page.getByTestId("followup-line");
      await expect(card).toHaveAttribute("data-arrived", "wrote");
      await expect(card.getByTestId("followup-text")).toHaveText("Yuki wrote since. Is it done?");
      await expect(card.getByTestId("followup-promised")).toHaveText("Yuki Gutiérrez promised to send you the contract");
      await expect(card.getByTestId("followup-done")).toHaveClass(/\btext-primary-foreground\b/);
      await expect(card.getByTestId("followup-nudge")).not.toHaveClass(/\btext-primary-foreground\b/);
    });

    await scenario("the tentative one is in Follow-ups, saying what they hope, quietly, under the name of who owes it", async () => {
      await page.getByTestId("palette-go-followups").or(page.getByTestId("nav-followups")).first().click();
      const row = page.getByTestId("thread-row").filter({ hasText: "Hopes to send you the contract" });
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId("row-from")).toHaveText("Tom Reed");
      await expect(row.getByTestId("row-snippet")).not.toHaveClass(/text-draft-foreground/);
      // a firm, late one keeps the owed ink
      await expect(page.getByTestId("thread-row").filter({ hasText: "Signed contract" }).getByTestId("row-snippet")).toHaveClass(/text-draft-foreground/);
    });

    await scenario("plan 285: a Late tag on what the sidebar counts, read or not; the dot stays unread's", async () => {
      const row = (subject: string) => page.getByTestId("thread-row").filter({ has: page.getByTestId("row-subject").getByText(subject, { exact: true }) });
      // the two firm ones are late (one they wrote after still is: nothing says it came), both read
      await expect(page.getByTestId("nav-followups").locator("[data-slot=nav-count]")).toHaveText("2");
      for (const subject of ["Signed contract", "Venue deposit"]) {
        await expect(row(subject).getByTestId("row-late")).toHaveText("Late");
        await expect(row(subject).getByTestId("row-unread-dot")).toHaveCount(0);
        await expect(row(subject)).toHaveAccessibleName(/, late,/);
        await expect(row(subject)).not.toHaveAccessibleName(/unread/);
      }
      // the tentative one: unread, its dot as anywhere, not late
      await expect(row("Draft budget").getByTestId("row-unread-dot")).toBeVisible();
      await expect(row("Draft budget").getByTestId("row-late")).toHaveCount(0);
      await expect(row("Draft budget")).toHaveAccessibleName(/, unread,/);
      await expect(row("Draft budget")).not.toHaveAccessibleName(/late/);
      await expect(page.getByTestId("row-late")).toHaveCount(2);
      if (SHOTS) {
        for (const scheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          expect((await new AxeBuilder({ page }).setLegacyMode().include("[data-testid=thread-row]").analyze()).violations).toEqual([]);
          await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-late-tags-${scheme}.png` });
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      // only Follow-ups says it
      await page.getByTestId("nav-inbox").click();
      await expect(row("Draft budget")).toBeVisible();
      await expect(page.getByTestId("row-late")).toHaveCount(0);
    });
  });
});

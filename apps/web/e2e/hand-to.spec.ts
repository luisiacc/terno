/**
 * Plan 210 (iteration 4, the owner's "Hand to someone"): Hand to… from an item's menu opens an inline forward of its
 * conversation in the reader with one line asking the person to take care of it, To focused for the recipient; Undo send
 * leaves the item open and the draft back; sent and confirmed, the item leaves the open part and Earlier says "Handed to
 * Jess today"; the forward waits on Jess in Follow-ups. The reader's line has it too.
 */
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { addRecipients, axeBothModes, expect, fresh, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };
const DAY = 86_400_000;
const SHOTS = process.env.HAND_TO_SHOTS;
const jess = "jess@home.test";

/** The school's mail, in the Inbox, and the reader's item from it: sign the form, due today, two hours from now */
async function seed(server: DevServerFixture): Promise<{ id: number; revision: number }> {
  const store = server.backend.store;
  const db = sqlDb(store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const m = { accountId: acct.id, providerMsgId: "trip", providerThreadId: "trip", rfcMessageId: "<trip@e2e.test>", inReplyTo: null, references: [], from: { name: "Maple School", email: "office@maple.test" }, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject: "Field trip form", date: E2E_NOW - 3_600_000, snippet: "Please sign the field trip form.", bodyText: "Please sign the field trip form by Sunday.", bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 900 } as unknown as IncomingMessage;
  await store.sync.ingest([m], { applyFilters: false, now: E2E_NOW, classifier: null });
  const row = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = 'trip'")!;
  await store.dated.marks.queueScan([row.id], E2E_NOW);
  const due = new Date(E2E_NOW + 2 * 3_600_000);
  const day = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  await store.dated.finish({ messageId: row.id, threadId: row.thread_id, fromScan: true, rows: [{ kind: "respond", item: 0, text: "Sign the field trip form", quote: "sign the field trip form by Sunday", dueDay: day, dueAt: due.getTime(), timed: true, dated: true, actAt: E2E_NOW - DAY }], settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
  const [item] = await store.dated.ofThread(row.thread_id);
  return item!;
}

const FEED = '[data-testid="wm-feed"]';
const openItem = (page: Page) => page.locator(`${FEED} [data-testid=wm-item]:not([data-history])`).filter({ hasText: "Sign the field trip form" });
const historyItem = (page: Page) => page.locator(`${FEED} [data-testid=wm-item][data-history]`).filter({ hasText: "Sign the field trip form" });

/** To the virtualized feed's end until the history's line is drawn (Earlier is the feed's last part, read again as it comes). */
async function reachEarlier(page: Page): Promise<void> {
  const scroller = page.locator(`${FEED} [data-keep-scroll="list"]`);
  await expect
    .poll(async () => {
      await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
      return historyItem(page).count();
    }, { timeout: 30_000 })
    .toBe(1);
  await historyItem(page).scrollIntoViewIfNeeded();
  await expect(historyItem(page)).toBeVisible();
}

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  // the dock's notes away, so the line under them shows
  for (const close of await page.getByTestId("snack-close").all()) await close.click().catch(() => {});
  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}-${mode}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("Hand to… from the item's menu: an inline forward with its line; Undo send leaves it open; confirmed, it's handed and Earlier says to whom", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true }, followups: { enabled: true, scanAnswered: true }, undoSend: true }, dev);
  const form = await seed(server);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(openItem(page)).toBeVisible({ timeout: 15_000 });
  const composer = page.getByTestId("composer");
  const body = page.getByTestId("compose-body");
  const held = page.getByTestId("held-message");
  // round 14's faults: a timed item says its time too
  const line = /^Could you take care of this: sign the field trip form \(by today \d{1,2}:\d{2}\s?[AP]M\)\?$/;

  await scenario("the palette's Hand to… on the open item: the forward in the reader with its line; put away, it waits as a draft", async () => {
    await openItem(page).getByTestId("wm-item-open").click();
    await expect(page.getByTestId("reader")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-dated-hand").click();
    await expect(composer).toBeVisible();
    await expect(body.locator("p").first()).toHaveText(line);
    await page.getByTestId("reader-close").click();
    await expect(composer).toHaveCount(0);
  });

  await scenario("the item's menu: Hand to… after Later; it opens the conversation's forward again (resumed: its line once), To taking the recipient", async () => {
    await openItem(page).click({ button: "right" });
    const hand = page.getByTestId("menu-dated-hand");
    await expect(hand).toHaveText(/^Hand to…⇧F$/);
    await hand.click();
    await expect(composer).toBeVisible();
    await expect(body.locator("p").filter({ hasText: "Could you take care of this" })).toHaveCount(1);
    await expect(page.getByTestId("reader").getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("compose-subject")).toHaveValue(/^Fwd: Field trip form/);
    await expect(body.locator("p").first()).toHaveText(line);
    await expect(page.getByTestId("compose-to")).toBeFocused();
    await addRecipients(page, "compose-to", jess);
    // nothing claimed by opening it, nor by the draft it saves
    expect((await server.backend.store.dated.get(form.id))!.state).toBe("open");
    await expect.poll(async () => (await server.backend.store.drafts.list()).some((d) => d.mode === "forward" && d.handoff_json !== null && d.handoff_json !== undefined)).toBe(true);
    await axeBothModes(page, '[data-testid="composer"]');
    await shoot(page, "forward-en");
  });

  await scenario("Undo send: the draft back with its line, the item still open in What matters", async () => {
    await body.click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(held).toBeVisible();
    await held.getByTestId("held-undo").click();
    await expect(composer).toBeVisible();
    await expect(body.locator("p").first()).toHaveText(line);
    await expect(openItem(page)).toBeVisible();
    expect((await server.backend.store.dated.get(form.id))!).toMatchObject({ state: "open", revision: form.revision });
  });

  await scenario("sent and confirmed: the item leaves the open part, Earlier says it was handed to Jess, and the forward waits on her", async () => {
    await body.click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(held).toBeVisible();
    // held, then queued: nothing claimed until the provider confirms
    expect((await server.backend.store.dated.get(form.id))!.state).toBe("open");
    await expect.poll(async () => (await server.backend.store.scheduled.list()).length).toBe(1);
    const { draftId } = (await server.backend.store.scheduled.list())[0]!;
    await server.backend.server.invoke("scheduled.reschedule", { draftId, sendAt: E2E_NOW - 1 }, dev);
    await expect.poll(async () => (await server.backend.store.dated.get(form.id))!.closedReason, { timeout: 15_000 }).toBe("handed");
    expect((await server.backend.store.dated.get(form.id))!.handedTo).toEqual({ name: "", email: jess });
    // its row is held in place while its conversation stays open (the feed's rule for what leaves on its own); put away, gone
    await page.getByTestId("reader-close").click();
    await expect(openItem(page)).toHaveCount(0);
    await reachEarlier(page);
    await expect(historyItem(page).getByTestId("wm-when")).toHaveText("Handed to jess today");
    const waits = (await server.backend.store.followups.active()).filter((r) => r.kind === "awaiting" && r.personEmail === jess);
    expect(waits).toHaveLength(1);
    await shoot(page, "earlier-en");
  });
});

test("Hand to… from the reader's line, in Spanish: the forward's line and Earlier's in Spanish", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { language: "es", ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true }, followups: { enabled: true, scanAnswered: true } }, dev);
  const form = await seed(server);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(openItem(page)).toBeVisible({ timeout: 15_000 });
  await openItem(page).getByTestId("wm-item-open").click();
  const hand = page.getByTestId("thread-dated-hand");
  await expect(hand).toHaveText("Delegar…");
  await expect(hand).toHaveAccessibleName("Delegar: Sign the field trip form");
  await hand.click();
  const body = page.getByTestId("compose-body");
  await expect(body.locator("p").first()).toHaveText(/^¿Puedes encargarte de esto: sign the field trip form \(para hoy \d{1,2}:\d{2}\)\?$/);
  await addRecipients(page, "compose-to", `Jess Okafor <${jess}>`);
  await shoot(page, "forward-es");
  await body.click();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await server.backend.store.dated.get(form.id))!.closedReason, { timeout: 15_000 }).toBe("handed");
  await page.getByTestId("reader-close").click();
  await expect(openItem(page)).toHaveCount(0);
  await reachEarlier(page);
  await expect(historyItem(page).getByTestId("wm-when")).toHaveText("Delegado a Jess hoy");
  await shoot(page, "earlier-es");
  await server.backend.server.invoke("settings.update", { language: "en" }, dev);
});

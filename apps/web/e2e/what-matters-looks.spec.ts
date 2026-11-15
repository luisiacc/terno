/**
 * Plan 204, the UI experiment: Today as a chat-like feed or a briefing (Settings → Dev, or `?wm=`), drawn from the list's
 * own rows: an item said in one sentence, its conversation opened beside the feed and put away with Esc, D and its Undo,
 * and axe in light and dark.
 */
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, expect, fresh, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };

/** a bill due today at 1 PM, written as the dated reader would have (its time to act already come) */
async function payroll(server: DevServerFixture) {
  const store = server.backend.store;
  const db = sqlDb(store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const message = { accountId: acct.id, providerMsgId: "payroll-1", providerThreadId: "payroll-1", rfcMessageId: "<payroll-1@e2e.test>", inReplyTo: null, references: [], from: { name: "PayBridge", email: "billing@paybridge.test" }, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject: "Payroll run", date: E2E_NOW, snippet: "Wire payroll by 1 pm.", bodyText: "Wire payroll by 1 pm.", bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200 } as unknown as IncomingMessage;
  await store.sync.ingest([message], { applyFilters: false, now: E2E_NOW, classifier: null });
  const m = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = ?", "payroll-1")!;
  await store.dated.marks.queueScan([m.id], E2E_NOW);
  const due = new Date(E2E_NOW);
  due.setHours(13, 0, 0, 0);
  const day = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  await store.dated.finish({ messageId: m.id, threadId: m.thread_id, fromScan: true, rows: [{ kind: "pay", item: 0, text: "Wire payroll", quote: "Wire payroll by 1 pm.", dueDay: day, dueAt: due.getTime(), timed: true, dated: true, actAt: E2E_NOW - 86_400_000 }], settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
}

for (const look of ["chat", "brief"] as const) {
  test(`${look}: the item in a sentence, its conversation beside the feed, Esc, D and Undo, axe in light and dark`, async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
    await payroll(server);
    await page.evaluate((l) => localStorage.setItem("terno.wm.look", l), look);
    await fresh(page);
    await page.getByTestId("nav-today").click();
    const feed = page.getByTestId("wm-feed");
    await expect(feed).toHaveAttribute("data-look", look);
    const item = feed.locator("[data-thread-id]").filter({ hasText: "Wire payroll" });
    const open = item.getByTestId(look === "chat" ? "wm-open" : "wm-item-open");

    await scenario("one plain sentence, under its group; nothing opens by itself, so the feed has the reader's room", async () => {
      await expect(item).toContainText("Wire payroll.", { timeout: 15_000 });
      if (look === "chat") await expect(item).toContainText(/1:00\sPM · PayBridge/);
      else {
        // after the UI panel: when in a column of its own, the list's words, the accent for today; who under the sentence,
        // never the email's date
        await expect(item.getByTestId("wm-when")).toHaveText(/^1:00\sPM$/);
        await expect(item).toHaveAttribute("data-tone", "today");
        await expect(item.getByTestId("wm-meta")).toHaveText("PayBridge");
        // Done and Later in words, out of sight (and out of the pointer's way) until the item is hovered, focused or open
        const controls = item.getByTestId("wm-controls");
        await expect(controls).toHaveCSS("opacity", "0");
        await item.hover();
        await expect(controls).toHaveCSS("opacity", "1");
        await expect(item.getByTestId("wm-done")).toHaveAccessibleName("Done");
        await expect(item.getByTestId("wm-done")).toHaveAccessibleDescription("Wire payroll.");
        await expect(item.getByTestId("wm-later")).toHaveAccessibleName("Later");
        await page.mouse.move(0, 0);
      }
      await expect(feed.getByTestId(look === "chat" ? "wm-divider" : "wm-heading").first()).toBeVisible();
      await expect(page.getByTestId("reader")).toHaveCount(0);
      await axeBothModes(page, '[data-testid="wm-feed"]');
    });

    await scenario("its conversation opens beside the feed, and Esc puts it away", async () => {
      await open.click();
      await expect(page.getByTestId("reader")).toBeVisible();
      await expect(page.locator("#reader-subject")).toHaveText("Payroll run");
      await expect(item).toHaveAttribute("data-open");
      await expect(feed).toBeVisible();
      if (look === "brief") await expect(item.getByTestId("wm-controls")).toHaveCSS("opacity", "1");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("reader")).toHaveCount(0);
      await expect(item).not.toHaveAttribute("data-open");
    });

    await scenario("D on the open item is its Done, and z brings it back", async () => {
      await open.click();
      await expect(item).toHaveAttribute("data-open");
      await page.keyboard.press("d");
      await expect(item).toHaveCount(0);
      await expect(page.getByTestId("snack")).toContainText("Done: Wire payroll");
      await page.keyboard.press("z");
      await expect(item).toBeVisible();
    });
  });
}

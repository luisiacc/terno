/**
 * Plan 248: What matters in the user's words. Settings' box, typed and saved (the fake provider compiles each sentence into a
 * rule), says back what it understood; the feed follows at once (a kind hidden, bills first); Clear brings everything back
 * and its Undo hides it again; the gear on What matters goes straight to the box. Axe in light and dark.
 */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, expect, fresh, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };

/** an open item due today at `hour`, on its own conversation, written as the reader writes one */
async function item(server: DevServerFixture, key: string, text: string, kind: "pay" | "delivery" | "event", from: { name: string; email: string }, hour: number) {
  const store = server.backend.store;
  const db = sqlDb(store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const m: IncomingMessage = { accountId: acct.id, providerMsgId: key, providerThreadId: key, rfcMessageId: `<${key}@e2e.test>`, inReplyTo: null, references: [], from, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject: `${text} (${key})`, date: E2E_NOW, snippet: `${text}.`, bodyText: `${text}.`, bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200 } as unknown as IncomingMessage;
  await store.sync.ingest([m], { applyFilters: false, now: E2E_NOW, classifier: null });
  const row = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = ?", key)!;
  await store.dated.marks.queueScan([row.id], E2E_NOW);
  const due = new Date(E2E_NOW);
  due.setHours(hour, 0, 0, 0);
  const day = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  await store.dated.finish({ messageId: row.id, threadId: row.thread_id, fromScan: true, rows: [{ kind, item: 0, text, quote: `${text}.`, dueDay: day, dueAt: due.getTime(), timed: true, dated: true, actAt: E2E_NOW - 86_400_000 }], settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
}

const feed = (page: Page) => page.getByTestId("wm-feed");
const line = (page: Page, text: string) => feed(page).locator("[data-thread-id]:not([data-history])").filter({ hasText: text });
const lines = (page: Page) => feed(page).locator("[data-thread-id]:not([data-history])");

async function openWords(page: Page) {
  await page.getByTestId("wm-options").click();
  await page.getByTestId("wm-options-words").click();
  await expect(page.getByTestId("wm-words-field")).toBeFocused();
}

test("plan 248: the words saved say what they understood, the feed follows at once, Clear and its Undo, the gear's way in; axe", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
  await item(server, "rally", "School rally", "event", { name: "Lincoln Elementary", email: "office@lincoln.test" }, 11);
  await item(server, "box", "Parcel arrives", "delivery", { name: "Parcelo", email: "track@parcelo.test" }, 14);
  await item(server, "rent", "Pay the rent", "pay", { name: "Billing", email: "rent@bills.test" }, 16);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(line(page, "Parcel arrives")).toBeVisible({ timeout: 15_000 });

  await scenario("the gear opens Settings at the box, its field focused; an empty box says how to write one", async () => {
    await openWords(page);
    await expect(page.getByTestId("wm-words-field")).toHaveAttribute("placeholder", /Never show package deliveries/);
    await expect(page.getByTestId("wm-words-save")).toBeDisabled();
    await expect(page.getByTestId("wm-words-understood")).toHaveCount(0);
  });

  await scenario("typed, it's not saved yet; ⌘↩ saves, and what Terno understood is a line per rule, with what it can't do", async () => {
    const field = page.getByTestId("wm-words-field");
    await field.fill("Never show package deliveries. Bills first. Text me when a bill is due.");
    await expect(page.getByTestId("wm-words-unsaved")).toBeVisible();
    await field.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("snack")).toContainText("“What matters” follows your words now");
    await expect(page.getByTestId("wm-words-unsaved")).toHaveCount(0);
    const rules = page.getByTestId("wm-words-rule");
    await expect(rules).toHaveCount(2);
    await expect(rules.nth(0)).toHaveAttribute("data-effect", "hide");
    await expect(rules.nth(1)).toHaveAttribute("data-effect", "first");
    await expect(page.getByTestId("wm-words-note")).toHaveAttribute("data-kind", "unsupported");
    await axeBothModes(page, '[data-testid="today-words"]');
    const shots = process.env.WM_WORDS_SHOTS;
    if (shots)
      for (const mode of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await page.getByTestId("today-words").screenshot({ path: join(shots, `words-${mode}.png`) });
      }
    await page.emulateMedia({ colorScheme: "light" });
  });

  await scenario("the feed follows: deliveries gone, bills first in their section", async () => {
    await page.keyboard.press("Escape");
    await expect(line(page, "Parcel arrives")).toHaveCount(0);
    await expect(line(page, "Pay the rent")).toBeVisible();
    await expect(lines(page).first()).toContainText("Pay the rent");
  });

  await scenario("Clear brings everything back at once; its Undo puts the words and their rules back", async () => {
    await openWords(page);
    await page.getByTestId("wm-words-clear").click();
    await expect(page.getByTestId("snack")).toContainText("Your words are cleared");
    await expect(page.getByTestId("wm-words-field")).toHaveValue("");
    await page.getByTestId("snack-action").click();
    await expect(page.getByTestId("wm-words-rule")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(line(page, "Parcel arrives")).toHaveCount(0);
  });
});

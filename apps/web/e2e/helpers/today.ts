import { expect, type Locator, type Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../../backend-dev/src/server";
import { E2E_NOW } from "../constants";
import type { DevServerFixture } from "../fixtures";

const HOUR = 3_600_000;

/** the feed's digest item */
export const DIGEST = '[data-testid="wm-item"][data-digest]';

/**
 * Plan 204 (after the panel, revision 10): the digest's way in is What matters' last open item, so the virtualized feed is
 * scrolled to its end until the item is drawn (and the digest has come, `timeout` long). Plan 210: the feed's item.
 */
export async function digestRow(page: Page, timeout = 15_000): Promise<Locator> {
  const list = page.locator('[data-keep-scroll="list"]');
  await expect
    .poll(
      async () => {
        await list.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        return page.locator(DIGEST).count();
      },
      { timeout },
    )
    .toBe(1);
  return page.locator(DIGEST);
}

export function message(server: DevServerFixture, key: string, from: { name: string; email: string }, subject: string, text: string, date = E2E_NOW, over: Partial<IncomingMessage> = {}): IncomingMessage {
  const db = sqlDb(server.backend.store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  return { accountId: acct.id, providerMsgId: key, providerThreadId: key, rfcMessageId: `<${key}@e2e.test>`, inReplyTo: null, references: [], from, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject, date, snippet: text, bodyText: text, bodyHtml: null, bodyState: "full", listId: null, isRead: true, isStarred: false, inInbox: false, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200, ...over } as unknown as IncomingMessage;
}

/** a dated item on its own conversation, written as the reader writes one; closed at `closedAt`, or left open (due today 1 PM) */
export async function item(server: DevServerFixture, key: string, text: string, closedAt: number | null, inbox = false) {
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

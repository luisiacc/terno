import type { MockDataset } from "@terno/mock-data";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";

let counter = 0;

/** One plausible incoming message; tests override what they assert on. */
export function msg(over: Partial<IncomingMessage> & { accountId: number }): IncomingMessage {
  counter++;
  return {
    providerMsgId: `p${counter}`,
    providerThreadId: null,
    rfcMessageId: `m${counter}@test`,
    inReplyTo: null,
    references: [],
    from: { name: "Ana Pérez", email: "ana@example.com" },
    to: [{ name: "Me", email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: `Subject ${counter}`,
    date: 1_700_000_000_000 + counter * 1000,
    snippet: "",
    bodyText: `body ${counter}`,
    bodyHtml: null,
    bodyState: "full",
    listId: null,
    isRead: false,
    isStarred: false,
    inInbox: true,
    isSent: false,
    isDraft: false,
    isTrash: false,
    isSpam: false,
    hasAttachments: false,
    size: 100,
    ...over,
  };
}

export async function withAccounts(store: MailStore, n = 2): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const { account } = await store.accounts.create({ kind: i % 2 ? "imap" : "gmail", email: `me${i}@example.com`, displayName: `Account ${i}`, color: "indigo", now: 0 });
    ids.push(account.id);
  }
  return ids;
}

/** Runs plan 17's facts backfill to the end, a slice at a time (what the backend's runner does). */
export async function backfillFacts(store: MailStore, limit = 500): Promise<number> {
  let slices = 0;
  for (;;) {
    const r = await store.facts.backfill({ limit });
    slices++;
    if (!r.more) return slices;
  }
}

export async function ingest(store: MailStore, messages: IncomingMessage[], now = 0) {
  return store.sync.ingest(messages, { applyFilters: true, now, classifier: null });
}

/** The thread of a message by provider id, read through the store's snapshot. */
export async function threadOf(store: MailStore, providerMsgId: string): Promise<number> {
  const m = (await store.debug.snapshot()).messages.find((x) => x.providerMsgId === providerMsgId);
  if (!m) throw new Error(`no message ${providerMsgId}`);
  return m.threadId;
}

/**
 * Loads a mock dataset through store commands only (what seedDataset does on
 * SQL): accounts, categories, ingestion in slices and deterministic filing.
 */
export async function seedThroughCommands(store: MailStore, data: MockDataset, now: number, rate = 0.7) {
  const accountIds: number[] = [];
  for (const a of data.accounts) accountIds.push((await store.accounts.create({ kind: a.kind, email: a.email, displayName: a.displayName, color: a.color, now })).account.id);
  // plan 68: listed before the mail, so IMAP locations in them are membership as they're written
  for (const [i, a] of data.accounts.entries()) if (a.folders) await store.folders.replace(accountIds[i]!, a.folders.map(({ key, path, selectable }) => ({ key, path, selectable })));
  const categories: { id: number; tags: readonly string[] }[] = [];
  for (const c of data.categories) categories.push({ id: (await store.categories.create(c.name, c.color)).id, tags: c.tags });
  for (let i = 0; i < data.messages.length; i += 1000) {
    await store.sync.ingest(
      data.messages.slice(i, i + 1000).map((m) => ({ ...m, accountId: accountIds[m.accountIndex]! })),
      { applyFilters: false, now, classifier: null },
    );
  }
  const threadOfMessage = new Map((await store.debug.snapshot()).messages.map((m) => [m.providerMsgId, m.threadId]));
  const threadTags = new Map<number, Set<string>>();
  for (const m of data.messages) {
    const t = threadOfMessage.get(m.providerMsgId)!;
    const tags = threadTags.get(t) ?? new Set();
    for (const tag of m.tags) tags.add(tag);
    threadTags.set(t, tags);
  }
  const keep = (threadId: number) => ((threadId * 2654435761) >>> 0) / 4294967296 < rate;
  for (const cat of categories) {
    const ids = [...threadTags].filter(([id, tags]) => keep(id) && cat.tags.some((t) => tags.has(t))).map(([id]) => id);
    for (let i = 0; i < ids.length; i += 500) await store.categories.add({ categoryId: cat.id, threadIds: ids.slice(i, i + 500), addedBy: "user", now });
  }
  return { accountIds, categoryIds: categories.map((c) => c.id) };
}

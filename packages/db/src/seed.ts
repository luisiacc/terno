import type { MockDataset } from "@terno/mock-data";
import { ingestMessages } from "./ingest";
import { replaceFolders } from "./folders";
import { addThreadsToCategory, createAccount, createCategory, recordUserActions } from "./repos";
import { placeholders, type Db } from "./sqlite";

export interface SeedOptions {
  chunkSize?: number;
  /** probability a thread with a category tag is pre-categorized (rest feed suggestions) */
  categorizeRate?: number;
  /** add explicit archive actions so a learned-filter proposal exists */
  learningSignals?: boolean;
  now?: number;
}

export interface SeedResult {
  accountIds: number[];
  categoryIds: number[];
  messageCount: number;
  threadCount: number;
}

/** Deterministically loads a mock dataset into an empty database. */
export function seedDataset(db: Db, data: MockDataset, options: SeedOptions = {}): SeedResult {
  const chunkSize = options.chunkSize ?? 1000;
  const rate = options.categorizeRate ?? 0.7;
  const now = options.now ?? Date.now();
  const accountIds = data.accounts.map(
    (a) => createAccount(db, { kind: a.kind, email: a.email, displayName: a.displayName, color: a.color }, now).id,
  );
  // plan 68: listed before the mail, so IMAP locations in them are membership as they're written
  data.accounts.forEach((a, i) => a.folders && replaceFolders(db, accountIds[i]!, a.folders.map(({ key, path, selectable }) => ({ key, path, selectable }))));
  const categories = data.categories.map((c) => ({ ...c, id: createCategory(db, c.name, c.color).id }));

  const threadTags = new Map<number, Set<string>>();
  for (let i = 0; i < data.messages.length; i += chunkSize) {
    const chunk = data.messages.slice(i, i + chunkSize);
    const result = ingestMessages(
      db,
      chunk.map((m) => ({ ...m, accountId: accountIds[m.accountIndex]! })),
      now,
    );
    const rows = db.all<{ id: number; thread_id: number }>(
      `SELECT id, thread_id FROM messages WHERE id IN (${placeholders(result.inserted.length)})`,
      ...result.inserted,
    );
    const threadOf = new Map(rows.map((r) => [r.id, r.thread_id]));
    result.inserted.forEach((messageId, j) => {
      const threadId = threadOf.get(messageId)!;
      const tags = threadTags.get(threadId) ?? new Set();
      for (const t of chunk[j]!.tags) tags.add(t);
      threadTags.set(threadId, tags);
    });
  }

  // deterministic pseudo-random categorization (hash of thread id)
  const keep = (threadId: number) => ((threadId * 2654435761) >>> 0) / 4294967296 < rate;
  for (const cat of categories) {
    const ids = [...threadTags].filter(([id, tags]) => keep(id) && cat.tags.some((t) => tags.has(t))).map(([id]) => id);
    addThreadsToCategory(db, cat.id, ids, "user", now);
  }

  if (options.learningSignals) {
    const brew = db.all<{ thread_id: number }>(
      "SELECT DISTINCT thread_id FROM messages WHERE from_email = 'crew@morningbrew.com' ORDER BY date DESC LIMIT 8",
    );
    db.tx(() => recordUserActions(db, brew.map((r) => r.thread_id), "archive", now - 86_400_000));
  }

  db.exec("PRAGMA optimize");
  return {
    accountIds,
    categoryIds: categories.map((c) => c.id),
    messageCount: db.get<{ c: number }>("SELECT count(*) AS c FROM messages")!.c,
    threadCount: db.get<{ c: number }>("SELECT count(*) AS c FROM threads")!.c,
  };
}

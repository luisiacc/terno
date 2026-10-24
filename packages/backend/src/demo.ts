import { generateDataset, printFixtures, type PrintFixtureKey } from "@terno/mock-data";
import type { IncomingMessage, MailStore } from "@terno/store";

export interface DemoOptions {
  threads?: number;
  accounts?: number;
  now?: number;
}

/** Seeds an empty store with the deterministic demo mailbox (no-op if accounts exist). */
export async function seedDemo(store: MailStore, options: DemoOptions = {}): Promise<boolean> {
  if ((await store.accounts.list()).length > 0) return false;
  const now = options.now ?? Date.UTC(2026, 9, 22, 15, 30);
  const data = generateDataset({ threads: options.threads ?? 3000, accounts: options.accounts ?? 4, now, seed: 42, bodyScale: 2 });
  const seeded = await store.dev.seed(data, { now, learningSignals: true });
  for (const [i, id] of seeded.accountIds.entries()) await store.accounts.setProviderConfig(id, { demo: true, senderName: data.accounts[i]!.ownerName });
  await store.filters.save(
    {
      name: "Notificaciones de GitHub → Desarrollo",
      enabled: true,
      source: "manual",
      rule: {
        match: "all",
        conditions: [{ field: "from", op: "equals", value: "notifications@github.com" }],
        actions: [{ type: "addCategory", categoryId: seeded.categoryIds[4]! }],
      },
    },
    now,
  );
  return true;
}

/**
 * Adds the print fixtures (plan 09) to the first account's inbox, read, the
 * newest `now` minus a few hours. Returns each fixture's first provider
 * message id, so callers can find its thread.
 */
export async function seedPrintFixtures(store: MailStore, options: { now: number; ownerName?: string }): Promise<Record<PrintFixtureKey, string>> {
  const account = (await store.accounts.list())[0];
  if (!account) throw new Error("seedPrintFixtures needs an account");
  // the account's display name is a label ("Personal"), not who writes
  const me = { name: options.ownerName ?? "Luis Cordero", email: account.email };
  const firstIds = {} as Record<PrintFixtureKey, string>;
  const messages: IncomingMessage[] = printFixtures(me).flatMap((f) => {
    const id = (i: number) => `<print-${f.key}-${i}@fixtures.terno.test>`;
    firstIds[f.key] = `print-${f.key}-0`;
    return f.messages.map((m, i) => {
      const text = m.bodyText ?? (m.bodyHtml ?? "").replace(/<[^>]+>/g, " ");
      return {
        accountId: account.id,
        providerMsgId: `print-${f.key}-${i}`,
        providerThreadId: `print-${f.key}`,
        rfcMessageId: id(i),
        inReplyTo: i ? id(i - 1) : null,
        references: Array.from({ length: i }, (_, j) => id(j)),
        from: m.from,
        to: m.to,
        cc: m.cc ?? [],
        bcc: [],
        subject: i ? `Re: ${f.subject}` : f.subject,
        date: options.now - m.hoursAgo * 3_600_000,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 140),
        bodyText: m.bodyText,
        bodyHtml: m.bodyHtml ?? null,
        bodyState: "full" as const,
        listId: null,
        isRead: true,
        isStarred: false,
        inInbox: true,
        isSent: m.from.email === me.email,
        isDraft: false,
        isTrash: false,
        isSpam: false,
        hasAttachments: Boolean(m.attachments?.length),
        attachments: m.attachments?.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size, contentId: a.contentId ?? null })),
        size: text.length + (m.bodyHtml?.length ?? 0),
      };
    });
  });
  await store.sync.ingest(messages, { applyFilters: false, now: options.now, classifier: null });
  return firstIds;
}

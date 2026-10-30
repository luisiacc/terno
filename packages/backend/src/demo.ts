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

/**
 * A verification code dated `now` in the first account's inbox, so the list's code chip (plan 69) is there on every
 * dev demo launch: the demo mailbox is seeded once, dated in the past, and a code shows only for two hours. Every
 * launch adds one message to the same thread, with a new code, as a service sends a new one each sign-in.
 */
export async function seedDemoCode(store: MailStore, now: number): Promise<string> {
  const account = (await store.accounts.list())[0];
  if (!account) throw new Error("seedDemoCode needs an account");
  const code = String(100_000 + (now % 900_000)).padStart(6, "0");
  const text = `Hi,\n\nUse this code to finish signing in to Acme: ${code}\n\nIt expires in 10 minutes. If you didn’t ask for it, you can ignore this email.\n\nThe Acme team`;
  const html = `<div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.5"><p>Hi,</p><p>Use this code to finish signing in to Acme:</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn’t ask for it, you can ignore this email.</p><p>The Acme team</p></div>`;
  await store.sync.ingest(
    [
      {
        accountId: account.id,
        providerMsgId: `demo-code-${now}`,
        providerThreadId: "demo-code",
        rfcMessageId: `<demo-code-${now}@acme.test>`,
        inReplyTo: null,
        references: [],
        from: { name: "Acme", email: "no-reply@acme.test" },
        replyTo: [],
        to: [{ name: "", email: account.email }],
        cc: [],
        bcc: [],
        subject: "Your Acme sign-in code",
        date: now,
        snippet: text.replace(/\s+/g, " ").trim(),
        bodyText: text,
        bodyHtml: html,
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
        size: text.length + html.length,
      },
    ],
    { applyFilters: false, now, classifier: null },
  );
  return code;
}

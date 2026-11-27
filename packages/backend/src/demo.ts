import { DEMO_DATASET, generateDataset, printFixtures, type Edition, type MockDataset, type PrintFixtureKey } from "@terno/mock-data";
import type { IncomingMessage, MailStore } from "@terno/store";

/**
 * Plan 292: a demo mailbox other than the generated one (the written corpus): its dataset, and the starter rule and
 * learning example it seeds with, by sender and category name.
 */
export interface DemoMailbox {
  dataset: MockDataset;
  rule: { name: string; from: string; category: string };
  learningSender: string;
}

export interface DemoOptions {
  threads?: number;
  accounts?: number;
  now?: number;
  /** plan 289: `demo` for what people look at (English, one Spanish account); the tests' fixture by default */
  edition?: Edition;
  /** plan 292: the written mailbox instead, read only when the store is empty (a disk read and a few hundred ms) */
  mailbox?: () => DemoMailbox;
}

/**
 * Plan 289: set on a profile seeded with the demo edition (seeding is once per profile: an older one keeps its mailbox);
 * plan 292: "corpus" on one seeded with the written mailbox. "seeding" from before the first write until after the last
 * (Codex code review): a profile still saying so stopped part way, and the backend won't start on it.
 */
export const DEMO_EDITION_KEY = "demo.edition";
export type DemoEdition = "demo" | "corpus" | "seeding";

/** What seeded a demo profile: null for the fixture or a profile from before plan 289; "seeding" for one that stopped. */
export const demoEditionOf = (store: MailStore) => store.settings.get<DemoEdition | null>(DEMO_EDITION_KEY, null);

/** Seeds an empty store with the demo mailbox (no-op if accounts exist): the written one when given, else the generated. */
export async function seedDemo(store: MailStore, options: DemoOptions = {}): Promise<boolean> {
  if ((await store.accounts.list()).length > 0) return false;
  const now = options.now ?? Date.UTC(2026, 9, 22, 15, 30);
  const edition = options.edition ?? "fixture";
  const written = options.mailbox?.();
  const data = written?.dataset ?? generateDataset({ ...DEMO_DATASET, threads: options.threads ?? DEMO_DATASET.threads, accounts: options.accounts ?? DEMO_DATASET.accounts, now, edition });
  const rule = written?.rule ?? { name: edition === "demo" ? "GitHub notifications → Dev" : "Notificaciones de GitHub → Desarrollo", from: "notifications@github.com", category: data.categories[4]!.name };
  const category = data.categories.findIndex((c) => c.name === rule.category);
  if (category < 0) throw new Error(`the demo's rule names a category it doesn't have: ${rule.category}`);
  // only the demo's: the fixture's profiles stay as they were (a profile without it holds the fixture's mailbox)
  const recorded = Boolean(written) || edition === "demo";
  if (recorded) await store.settings.set(DEMO_EDITION_KEY, "seeding");
  const seeded = await store.dev.seed(data, { now, learningSignals: true, ...(written && { learningSender: written.learningSender }) });
  for (const [i, id] of seeded.accountIds.entries()) await store.accounts.setProviderConfig(id, { demo: true, senderName: data.accounts[i]!.ownerName });
  await store.filters.save(
    {
      name: rule.name,
      enabled: true,
      source: "manual",
      rule: {
        match: "all",
        conditions: [{ field: "from", op: "equals", value: rule.from }],
        actions: [{ type: "addCategory", categoryId: seeded.categoryIds[category]! }],
      },
    },
    now,
  );
  if (recorded) await store.settings.set(DEMO_EDITION_KEY, written ? "corpus" : "demo");
  return true;
}

/** A demo profile whose seed stopped part way: what to tell the person, or null when it's whole. */
export async function demoSeedProblem(store: MailStore): Promise<string | null> {
  return (await demoEditionOf(store)) === "seeding" ? "the demo mailbox stopped seeding part way: start over with --cleandb (dev:desktop:demo) or --fresh (dev:demo-ai)" : null;
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
 * A verification code dated `now` in the first account's inbox, so the list's code chip (plan 72) is there on every
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

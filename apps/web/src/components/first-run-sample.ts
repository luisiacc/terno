import type { Category, CategoryColor, ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";

/**
 * Plan 98: the mailbox the first-run preview shows, before there's any mail.
 * Written in the user's language (firstRun.sample.*), dated relative to now.
 * Ids are negative so nothing in the stores (selection, drafts, codes,
 * reminders) can ever match one; the preview reads none of them anyway.
 */
export interface SampleMailbox {
  threads: ThreadSummary[];
  categories: Category[];
  /** the open conversation: the first thread's newest message */
  open: { thread: ThreadSummary; to: string; body: string };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const SAMPLES = [
  { n: 1, email: "maya.chen@example.com", ago: 12 * MIN, unread: true, cats: [] as number[] },
  { n: 2, email: "trips@northwind.example", ago: 1 * HOUR + 20 * MIN, unread: true, attachments: true, cats: [-1] },
  { n: 3, email: "daniel@ortiz.example", ago: 3 * HOUR, starred: true, messages: 3, cats: [-2] },
  { n: 4, email: "hello@studio-weekly.example", ago: 1 * DAY + 2 * HOUR, cats: [] },
  { n: 5, email: "ana.souza@example.com", ago: 2 * DAY, attachments: true, cats: [] },
  { n: 6, email: "statements@harborbank.example", ago: 4 * DAY, cats: [] },
  { n: 7, email: "leo.martin@example.com", ago: 6 * DAY, messages: 2, cats: [-2] },
] as const satisfies readonly { n: number; email: string; ago: number; unread?: boolean; starred?: boolean; attachments?: boolean; messages?: number; cats: readonly number[] }[];

type N = (typeof SAMPLES)[number]["n"];
const from = (n: N) => t(`firstRun.sample.${n}.from`);
const subject = (n: N) => t(`firstRun.sample.${n}.subject`);
const snippet = (n: N) => t(`firstRun.sample.${n}.snippet`);

const CATEGORIES: { id: number; key: "firstRun.sample.category.travel" | "firstRun.sample.category.work"; color: CategoryColor }[] = [
  { id: -1, key: "firstRun.sample.category.travel", color: "cyan" },
  { id: -2, key: "firstRun.sample.category.work", color: "brown" },
];

/** Built once when the preview opens (no timer: its dates don't move while it shows). */
export function sampleMailbox(now = Date.now()): SampleMailbox {
  const threads: ThreadSummary[] = SAMPLES.map((s) => ({
    id: -s.n,
    accountId: -1,
    subject: subject(s.n),
    snippet: snippet(s.n),
    lastDate: now - s.ago,
    fromName: from(s.n),
    fromEmail: s.email,
    messageCount: "messages" in s ? s.messages : 1,
    unread: "unread" in s && s.unread,
    starred: "starred" in s && s.starred,
    hasAttachments: "attachments" in s && s.attachments,
    categoryIds: [...s.cats],
    inInbox: true,
  }));
  const categories: Category[] = CATEGORIES.map((c, i) => ({ id: c.id, name: t(c.key), color: c.color, position: i, autoApply: false, showInInbox: true }));
  return { threads, categories, open: { thread: threads[0]!, to: t("firstRun.sample.to"), body: t("firstRun.sample.1.body") } };
}

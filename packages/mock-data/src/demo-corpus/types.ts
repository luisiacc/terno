/**
 * Plan 292: the written demo mailbox's sources. A world of people (`world.json`), the briefs each batch was written
 * from (`seeds/`), the threads the writers wrote (`threads/*.jsonl`) and the machine mail's templates (`bulk/`). Every
 * name, address, company and brand is invented. Type-only module: `scripts/demo-corpus/check.mjs` runs `rules.ts`
 * under Node's type stripping, so nothing here may exist at runtime.
 */
import type { CategoryColor } from "@terno/core";
import type { ThreadTag } from "../generate";

export type Lang = "en" | "es";
export type AccountKey = "personal" | "acme" | "freelance" | "icloud";

/** How someone writes. Writers follow it; the critic holds them to it. */
export interface StyleCard {
  /** e.g. "warm and chatty", "terse, corporate", "formal usted" */
  register: string;
  /** e.g. "one or two lines", "three short paragraphs" */
  length: string;
  /** how they open, or "none" */
  greeting: string;
  /** how they close, or "none" */
  signoff: string;
  /** the block their mail client appends to every message they write, or null */
  signature: string | null;
  /** where their client puts the quoted history when they reply */
  quoting: "bottom" | "top" | "none";
  /** "no capital letters", "Sent from my iPhone", "the odd typo", "bullet lists", "one emoji at most" … */
  quirks: string[];
}

export interface Person {
  /** kebab-case, unique across the world and every thread's one-off people */
  id: string;
  name: string;
  email: string;
  /** the language they write the owner in */
  lang: Lang;
  /** IANA zone: their mail is dated in their own day */
  timezone: string;
  /** which of the owner's addresses they write to */
  accounts: AccountKey[];
  /** to the owner: "older sister", "his manager at Acme", "client (Lumbre Café)" */
  relationship: string;
  /** an `Org.id` */
  org?: string;
  style: StyleCard;
  /** what writers must keep true about them */
  facts: string[];
}

export interface Org {
  id: string;
  name: string;
  domain: string;
  /** "design studio", "coffee roaster", "accounting firm" … */
  kind: string;
  lang: Lang;
  about: string;
}

export type BrandKind = "newsletter" | "receipt" | "shipping" | "bank" | "card" | "travel" | "dev" | "tool" | "telecom" | "utility" | "social" | "security" | "promo";

export interface Brand {
  id: string;
  name: string;
  domain: string;
  fromName: string;
  fromEmail: string;
  kind: BrandKind;
  lang: Lang;
  accounts: AccountKey[];
  /** the categories' gold label for its mail */
  tag: ThreadTag;
  /** newsletters and list mail */
  listId?: string;
  about: string;
  /** in words, e.g. "weekdays at 06:30 London", "after each ride, 2–5 a week", "monthly on the 3rd" */
  cadence: string;
}

export interface AccountDef {
  key: AccountKey;
  kind: "gmail" | "imap";
  email: string;
  displayName: string;
  ownerName: string;
  color: string;
  lang: Lang;
  /** relative share of the human threads */
  weight: number;
  /** Gmail labels or IMAP folders: key, path, which threads a writer may file there */
  folders: { key: string; path: string[]; selectable: boolean; tags: ThreadTag[] }[];
}

export interface Storyline {
  id: string;
  account: AccountKey;
  title: string;
  /** what happens, start to end, with dates: the threads that belong to it must agree with it */
  summary: string;
  people: string[];
  from: string;
  to: string;
}

export interface World {
  /** the newest mail's instant, ISO; nothing is dated after it */
  anchor: string;
  owner: {
    name: string;
    bio: string;
    timezone: string;
    style: Record<Lang, StyleCard>;
  };
  accounts: AccountDef[];
  categories: { name: string; color: CategoryColor; tags: ThreadTag[] }[];
  /** the owner's two years, in order: every writer reads it so threads agree */
  timeline: { date: string; fact: string }[];
  people: Person[];
  orgs: Org[];
  brands: Brand[];
  /** arcs that run through several threads */
  storylines: Storyline[];
}

export interface Attachment {
  filename: string;
  mime: string;
  size: number;
}

/** One message as its sender typed it. The loader adds the quoted history, the headers and the HTML. */
export interface MessageRecord {
  /** a person id, a one-off person's id, or "me" */
  from: string;
  /** the same, or "list" for the thread's mailing list */
  to: string[];
  cc?: string[];
  bcc?: string[];
  /** ISO 8601 with the sender's UTC offset, e.g. 2026-10-21T09:14:00+01:00 */
  date: string;
  /** the owner has read it; ignored on his own mail */
  read: boolean;
  /** only when it differs from "Re: <thread subject>" (a forward, a changed subject) */
  subject?: string;
  /** what the sender typed, signature included; never the quoted history */
  text: string;
  attachments?: Attachment[];
  /**
   * A forward: `true` forwards the message before it in the thread; an object is mail from outside the thread (the
   * loader appends it as the forwarded block, headers and all). `text` is only the line typed on top.
   */
  forward?: true | { from: string; date: string; subject: string; to?: string; text: string };
}

/** What is true at the anchor: the answer key the AI features are judged against. */
export interface Truth {
  summary: string;
  /** what the owner still has to do */
  ownerOwes: string[];
  /** what others still owe the owner or each other, "who: what" */
  othersOwe: string[];
  promisesByOwner: { text: string; due?: string; kept: boolean }[];
  promisesToOwner: { who: string; text: string; due?: string; kept: boolean }[];
  keyDates: { date: string; what: string }[];
  /** facts a question could be answered from: amounts, addresses, names, times */
  facts: string[];
}

export interface ThreadRecord {
  /** the seed's id */
  id: string;
  account: AccountKey;
  storyline?: string;
  lang: Lang;
  tags: ThreadTag[];
  subject: string;
  /** a folder key of its account */
  folder?: string;
  /** where the thread is at the anchor */
  state: { inbox: boolean; starred?: boolean; trash?: boolean; spam?: boolean };
  /** a mailing list's id, for list discussions */
  listId?: string;
  /** people who appear only here (a recruiter, a cold pitch, a stranger on a list) */
  people?: Person[];
  messages: MessageRecord[];
  truth: Truth;
}

/** A slot's values: a list to pick from, an amount, a whole number, or a reference like "HR-####-??" (# digit, ? letter). */
export type BulkSlot = string[] | { money: [number, number] } | { int: [number, number] } | { ref: string };

export interface BulkTemplate {
  weight?: number;
  /** `{slot}`s from `slots`, plus the built-ins {date} {time} {weekday} {month} {year} {first} */
  subject: string;
  text: string;
  /** the HTML part; links and images only on .example hosts */
  html?: string;
  slots?: Record<string, BulkSlot>;
  attachments?: Attachment[];
}

/** When a sender mails, in its own zone. */
export interface BulkSchedule {
  every: "daily" | "weekdays" | "weekly" | "fortnightly" | "monthly" | "random";
  /** "HH:MM" local; random schedules pick an hour in business time */
  at?: string;
  zone: string;
  /** weekly and fortnightly: 0–6, Sunday 0; monthly: the day of the month */
  day?: number;
  /** monthly on a weekday instead of a date: [which, weekday], e.g. [1, 4] the first Thursday */
  nth?: [number, number];
  /** random: messages a week, a range */
  perWeek?: [number, number];
  /** random: Monday to Friday only (work tools) */
  workdays?: boolean;
  /** ISO dates; default the whole two years */
  from?: string;
  to?: string;
}

/** One brand's machine mail to one account (`bulk/<brand>.json`, an array when it writes to several). */
export interface BulkSource {
  brand: string;
  account: AccountKey;
  schedule: BulkSchedule;
  templates: BulkTemplate[];
  /** newsletters: written issues, newest first; the newest dates get one each, older dates reuse them in turn */
  issues?: { subject: string; text: string; html?: string }[];
  /** money's currency symbol for {money} slots, e.g. "£", "MXN $" */
  currency?: string;
}

/** Spam and phishing that reached the Spam folder (`bulk/spam.json`). */
export interface SpamSource {
  account: AccountKey;
  fromName: string;
  fromEmail: string;
  subject: string;
  text: string;
  html?: string;
  /** days before the anchor */
  daysAgo: number;
}

export interface MailingList {
  id: string;
  account: AccountKey;
  name: string;
  address: string;
  listId: string;
  about: string;
}

/**
 * `demo.json`: what the demo seeds beside the mail (the starter rule, the learning example) and what `pnpm dev:demo-ai`
 * prepares and checks on it (plan 292, revision 8), by subject, never by position.
 */
export interface DemoManifest {
  rule: { name: string; from: string; category: string };
  learningSender: string;
  prepare: {
    /** plan 279: opened first, each must show a "Since" view, except `sinceWhole` (nothing changed) */
    since: string[];
    sinceWhole: string;
    /** summarised and given Reply ready */
    summaries: string[];
    /** Spanish conversations whose Reply ready must come back in Spanish */
    spanishReply: string[];
    /** each answer must cite one of `cites` (subjects) and say `facts` */
    ask: { q: string; followUp?: string; cites: string[]; facts: string[] }[];
    ruleRequest: string;
    /** sent only if the follow-up scan found nothing (`to` is a name the composer suggests) */
    followup?: { to: string; subject: string; body: string };
  };
}

/** Everything the loader reads. */
export interface CorpusSources {
  world: World;
  lists: MailingList[];
  threads: ThreadRecord[];
  bulk: BulkSource[];
  spam: SpamSource[];
}

/** A brief for one thread, sampled in code (seeds.ts). */
export interface Seed {
  id: string;
  account: AccountKey;
  lang: Lang;
  kind: string;
  storyline?: string;
  /** people the thread is with, by id; the writer may add one-off people when the kind calls for them */
  people: string[];
  shape: string;
  outcome: string;
  messages: [number, number];
  /** every message's date falls in it, ISO dates */
  window: [string, string];
  /** per message, "short" (≤ 40 words), "medium" (40–150), "long" (150+); a tendency, not a rule */
  length: "short" | "medium" | "long" | "mixed";
  attachments: "none" | "some" | "forgotten";
  /** suggested gold labels; the writer may refine them */
  tags: ThreadTag[];
  /** state at the anchor */
  inbox: boolean;
  trash?: boolean;
  /** a taxonomy list's id: a discussion on that mailing list */
  list?: string;
  /** who sends the first and the last message */
  firstFrom?: "me" | "them";
  lastFrom?: "me" | "them";
  /** messages from others dated at or after it are unread, before it read; absent, every message is read */
  unreadFrom?: string;
  /** planted scenario for an AI feature, e.g. "since", "owner-promise" */
  plant?: string;
  /** what the thread must contain, in words */
  must: string[];
}

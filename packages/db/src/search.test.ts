import {
  evaluateRule,
  isFullEmail,
  normalizeText,
  parseSearch,
  tokenize,
  VIEWS,
  type FilterRule,
  type MessageTerm,
  type RuleMessage,
  type View,
} from "@unica/core";
import { generateDataset } from "@unica/mock-data";
import { beforeAll, describe, expect, it } from "vitest";
import { listThreads, getCounts, VIEW_WHERE, type Cursor } from "./queries";
import { findRuleMatches } from "./rules";
import { searchThreads, type SearchStrategy } from "./search";
import { seedDataset } from "./seed";
import type { Db } from "./sqlite";
import { openDatabase } from "./index";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.UTC(2026, 9, 22, 15, 30);

interface OracleMessage {
  id: number;
  thread_id: number;
  account_id: number;
  from_name: string;
  from_email: string;
  recipients_text: string;
  subject: string;
  body_text: string | null;
  list_id: string | null;
  has_attachments: number;
  date: number;
  is_trash: number;
}
interface OracleThread {
  id: number;
  account_id: number;
  last_date: number;
  unread_count: number;
  is_starred: number;
  in_inbox: number;
  has_sent: number;
  in_trash: number;
  in_spam: number;
}

let db: Db;
let messages: OracleMessage[];
let threads: Map<number, OracleThread>;
let threadCategories: Map<number, Set<number>>;

beforeAll(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), "unica-search-")), "s.db"));
  seedDataset(db, generateDataset({ threads: 2500, accounts: 4, seed: 11, now: NOW }), { now: NOW });
  messages = db.all<OracleMessage>(
    "SELECT id, thread_id, account_id, from_name, from_email, recipients_text, subject, body_text, list_id, has_attachments, date, is_trash FROM messages",
  );
  threads = new Map(db.all<OracleThread>("SELECT * FROM threads").map((t) => [t.id, t]));
  threadCategories = new Map();
  for (const r of db.all<{ thread_id: number; category_id: number }>("SELECT * FROM thread_categories")) {
    const set = threadCategories.get(r.thread_id) ?? new Set();
    set.add(r.category_id);
    threadCategories.set(r.thread_id, set);
  }
});

// ───────────── oracle: an independent implementation of search semantics ─────────────

function phraseIn(columnText: string, term: MessageTerm): boolean {
  const tokens = tokenize(columnText);
  const needle = tokenize(term.value);
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= tokens.length; i++) {
    if (
      needle.every((t, j) =>
        term.prefix && j === needle.length - 1 ? tokens[i + j]!.startsWith(t) : tokens[i + j] === t,
      )
    ) {
      return true;
    }
  }
  return false;
}

function termMatches(m: OracleMessage, term: MessageTerm): boolean {
  const columns = {
    subject: m.subject,
    from: `${m.from_name} ${m.from_email}`,
    to: m.recipients_text,
    body: m.body_text ?? "",
  };
  if (term.field === "text") return Object.values(columns).some((c) => phraseIn(c, term));
  return phraseIn(columns[term.field], term);
}

const VIEW_TEST: Record<View, (t: OracleThread) => boolean> = {
  inbox: (t) => t.in_inbox === 1,
  starred: (t) => t.is_starred === 1 && !t.in_trash && !t.in_spam,
  sent: (t) => t.has_sent === 1 && !t.in_trash && !t.in_spam,
  archive: (t) => !t.in_inbox && !t.in_trash && !t.in_spam,
  spam: (t) => t.in_spam === 1 && !t.in_trash,
  trash: (t) => t.in_trash === 1,
  all: (t) => !t.in_trash && !t.in_spam,
};

function oracle(query: string, scope: { accountId?: number; categoryId?: number } = {}): number[] {
  const q = parseSearch(query, NOW);
  const accounts = db.all<{ id: number; email: string; display_name: string }>("SELECT id, email, display_name FROM accounts");
  const categories = db.all<{ id: number; name: string }>("SELECT id, name FROM categories");
  const emailTerms = q.terms.filter((t) => t.field === "from" && isFullEmail(t.value));
  const ftsTerms = q.terms.filter((t) => !(t.field === "from" && isFullEmail(t.value)) && tokenize(t.value).length > 0);
  const positive = ftsTerms.filter((t) => !t.negate);
  const negative = ftsTerms.filter((t) => t.negate);
  const hasMessagePredicate =
    positive.length > 0 || emailTerms.length > 0 || q.hasAttachment !== undefined || q.before !== undefined || q.after !== undefined;

  const messageOk = (m: OracleMessage) =>
    positive.every((t) => termMatches(m, t)) &&
    // negatives are message-level whenever any message predicate exists
    (!hasMessagePredicate || negative.every((t) => !termMatches(m, t))) &&
    emailTerms.every((t) => (normalizeText(t.value) === m.from_email) !== t.negate) &&
    (q.hasAttachment === undefined || (m.has_attachments === 1) === q.hasAttachment) &&
    (q.before === undefined || m.date < q.before) &&
    (q.after === undefined || m.date >= q.after);

  const candidate = new Set<number>();
  if (hasMessagePredicate) {
    for (const m of messages) if (messageOk(m)) candidate.add(m.thread_id);
  } else {
    for (const id of threads.keys()) candidate.add(id);
  }
  if (!hasMessagePredicate && negative.length > 0) {
    // negative-only: threads with no message matching any negated term
    for (const m of messages) if (negative.some((t) => termMatches(m, t))) candidate.delete(m.thread_id);
  }

  const accountIds = new Set<number>(scope.accountId ? [scope.accountId] : []);
  let impossible = false;
  for (const token of q.accounts) {
    const matches = accounts.filter((a) => normalizeText(a.email).includes(token) || normalizeText(a.display_name).includes(token));
    if (!matches.length) impossible = true;
    for (const a of matches) accountIds.add(a.id);
  }
  const excludedAccounts = new Set(
    q.excludeAccounts.flatMap((token) => accounts.filter((a) => normalizeText(a.email).includes(token) || normalizeText(a.display_name).includes(token)).map((a) => a.id)),
  );
  const excludedCategories = q.excludeCategories
    .map((token) => (categories.find((x) => normalizeText(x.name) === token) ?? categories.find((x) => normalizeText(x.name).startsWith(token)))?.id)
    .filter((x): x is number => x !== undefined);
  const categoryIds = scope.categoryId ? [scope.categoryId] : [];
  for (const token of q.categories) {
    const c = categories.find((x) => normalizeText(x.name) === token) ?? categories.find((x) => normalizeText(x.name).startsWith(token));
    if (!c) impossible = true;
    else categoryIds.push(c.id);
  }
  if (impossible) return [];
  const view = q.view ?? "all";
  return [...candidate]
    .map((id) => threads.get(id)!)
    .filter(
      (t) =>
        VIEW_TEST[view](t) &&
        (accountIds.size === 0 || accountIds.has(t.account_id)) &&
        !excludedAccounts.has(t.account_id) &&
        excludedCategories.every((c) => !threadCategories.get(t.id)?.has(c)) &&
        categoryIds.every((c) => threadCategories.get(t.id)?.has(c)) &&
        (q.unread === undefined || t.unread_count > 0 === q.unread) &&
        (q.starred === undefined || (t.is_starred === 1) === q.starred),
    )
    .sort((a, b) => b.last_date - a.last_date || b.id - a.id)
    .map((t) => t.id);
}

function searchAll(query: string, scope: { accountId?: number; categoryId?: number } = {}, pageSize = 37) {
  const ids: number[] = [];
  const strategies = new Set<SearchStrategy>();
  let cursor: Cursor | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = searchThreads(db, { query, limit: pageSize, cursor, now: NOW, ...scope });
    strategies.add(page.strategy);
    ids.push(...page.items.map((t) => t.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { ids, strategies };
}

// ───────────────────────────── tests ─────────────────────────────

describe("search matches the oracle (all pages)", () => {
  const cases: [string, SearchStrategy][] = [
    ["factura", "fts"],
    ["reunión", "fts"],
    ["reunion", "fts"], // accent-insensitive
    ["REUNIÓN", "fts"],
    ["propu", "fts"], // prefix while typing
    ['"darse de baja"', "fts"],
    ['"baja darse"', "fts"],
    ["from:lucia", "fts"],
    ["de:garcía", "fts"],
    ["to:luis", "fts"],
    ["subject:propuesta", "fts"],
    ["subject:propuesta from:lucia", "fts"],
    ["factura -uber", "fts"],
    ["in:inbox factura", "fts"],
    ["factura has:attachment", "fts"],
    ["checkout from:notifications@github.com", "fts"],
    ["from:crew@morningbrew.com", "sender-index"],
    ["from:crew@morningbrew.com is:unread", "sender-index"],
    ["from:crew@morningbrew.com from:hola@platzi.com", "empty"],
    ["has:attachment", "walk"],
    ["is:unread", "walk"],
    ["is:starred", "walk"],
    ["in:spam", "walk"],
    ["in:trash", "walk"],
    ["in:sent", "walk"],
    ["category:facturas", "walk"],
    ["account:acme", "walk"],
    ["account:nonexistent", "empty"],
    ["category:nonexistent factura", "empty"],
    ["before:2025-06-01", "date-index"],
    ["after:30d", "walk"],
    ["after:90d has:attachment", "walk"],
    ["-factura", "fts-exclude"],
    ["-from:crew@morningbrew.com", "walk"],
    ["from:crew@morningbrew.com -markets", "sender-index"],
    ["has:attachment -factura", "walk"],
    ["before:2025-06-01 -factura", "date-index"],
    ["-account:acme", "walk"],
    ["factura -category:facturas", "fts"],
    ["-before:2025-06-01 has:attachment", "walk"],
    ["zzzqqqxx", "fts"],
    ["!!!", "walk"],
  ];

  it.each(cases)("%s", (query, strategy) => {
    const expected = oracle(query);
    const { ids, strategies } = searchAll(query);
    expect([...strategies]).toEqual([strategy]);
    expect(ids).toEqual(expected);
  });

  it("finds a meaningful number of results for common queries (fixture sanity)", () => {
    expect(oracle("factura").length).toBeGreaterThan(50);
    expect(oracle("from:crew@morningbrew.com").length).toBeGreaterThan(10);
    expect(oracle("factura -uber").length).toBeLessThan(oracle("factura").length);
  });

  it("respects account and category scope from the UI", () => {
    const account = db.get<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1 OFFSET 1")!.id;
    expect(searchAll("factura", { accountId: account }).ids).toEqual(oracle("factura", { accountId: account }));
    expect(searchAll("factura", { categoryId: 1 }).ids).toEqual(oracle("factura", { categoryId: 1 }));
  });

  it("requires message predicates to match the same message", () => {
    // thread where X sent a message, and a *different* message (not from X) mentions "presupuesto"
    const row = db.get<{ thread_id: number; from_email: string }>(
      `SELECT a.thread_id, a.from_email FROM messages a JOIN messages b ON a.thread_id = b.thread_id AND a.from_email != b.from_email
       WHERE b.body_text LIKE '%presupuesto%' AND a.from_email LIKE '%@%.%'
         AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.thread_id = a.thread_id AND c.from_email = a.from_email
                         AND (c.body_text LIKE '%presupuesto%' OR c.subject LIKE '%presupuesto%'))
       LIMIT 1`,
    );
    expect(row).toBeTruthy();
    expect(searchAll("presupuesto").ids).toContain(row!.thread_id); // positive control
    expect(searchAll(`from:${row!.from_email}`).ids).toContain(row!.thread_id); // positive control
    expect(searchAll(`from:${row!.from_email} presupuesto`).ids).not.toContain(row!.thread_id);
  });
});

describe("thread lists", () => {
  it("keyset pagination returns every thread exactly once, in order, despite shared timestamps", () => {
    const dupes = db.get<{ c: number }>("SELECT count(*) c FROM (SELECT last_date FROM threads GROUP BY last_date HAVING count(*) > 1)")!.c;
    expect(dupes).toBeGreaterThan(0); // fixture has ties
    for (const view of VIEWS) {
      const ids: number[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = listThreads(db, { view, limit: 53, cursor });
        ids.push(...page.items.map((t) => t.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const expected = [...threads.values()]
        .filter(VIEW_TEST[view])
        .sort((a, b) => b.last_date - a.last_date || b.id - a.id)
        .map((t) => t.id);
      expect(ids, view).toEqual(expected);
    }
  });

  it("hot list queries walk their partial index with no sort step", () => {
    const plan = (sql: string, ...params: (number | string)[]) =>
      db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join(" | ");
    const expectations: [View, string][] = [
      ["inbox", "threads_inbox"],
      ["all", "threads_all"],
      ["archive", "threads_archive"],
      ["starred", "threads_starred"],
      ["sent", "threads_sent"],
      ["trash", "threads_trash"],
      ["spam", "threads_spam"],
    ];
    for (const [view, index] of expectations) {
      const p = plan(`SELECT t.id FROM threads t WHERE ${VIEW_WHERE[view]} ORDER BY t.last_date DESC, t.id DESC LIMIT 100`);
      expect(p, view).toContain(index);
      expect(p, view).not.toContain("TEMP B-TREE");
      const paged = plan(
        `SELECT t.id FROM threads t WHERE ${VIEW_WHERE[view]} AND (t.last_date, t.id) < (?, ?) ORDER BY t.last_date DESC, t.id DESC LIMIT 100`,
        NOW,
        1e9,
      );
      expect(paged, `${view} paged`).toContain(index);
      expect(paged, `${view} paged`).not.toContain("TEMP B-TREE");
    }
    const acct = plan(`SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.account_id = ? ORDER BY t.last_date DESC, t.id DESC LIMIT 100`, 1);
    expect(acct).toContain("threads_acct_inbox");
    expect(acct).not.toContain("TEMP B-TREE");
  });

  it("sidebar counts equal a brute-force count of unread threads", () => {
    const counts = getCounts(db);
    const inbox = [...threads.values()].filter((t) => t.in_inbox && t.unread_count > 0);
    expect(counts.inboxUnread).toBe(inbox.length);
    for (const [accountId, n] of Object.entries(counts.inboxUnreadByAccount)) {
      expect(n).toBe(inbox.filter((t) => t.account_id === Number(accountId)).length);
    }
    for (const [categoryId, total] of Object.entries(counts.categoryTotal)) {
      const members = [...threads.values()].filter((t) => threadCategories.get(t.id)?.has(Number(categoryId)) && !t.in_trash && !t.in_spam);
      expect(total).toBe(members.length);
      expect(counts.categoryUnread[Number(categoryId)]).toBe(members.filter((t) => t.unread_count > 0).length);
    }
  });
});

describe("filter rules: JS evaluator and SQL compiler agree", () => {
  function toRuleMessage(m: OracleMessage): RuleMessage {
    return {
      accountId: m.account_id,
      fromName: m.from_name,
      fromEmail: m.from_email,
      recipients: m.recipients_text,
      subject: m.subject,
      bodyText: m.body_text,
      listId: m.list_id,
      hasAttachments: m.has_attachments === 1,
      date: m.date,
    };
  }

  /** Rules built from real values in the fixture so they actually match things. */
  function generateRules(): FilterRule[] {
    let seed = 3;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const ops = ["contains", "equals", "startsWith", "endsWith"] as const;
    const rules: FilterRule[] = [];
    for (let i = 0; i < 120; i++) {
      const conditions: FilterRule["conditions"] = [];
      const n = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < n; j++) {
        const m = pick(messages);
        const words = tokenize(m.body_text ?? "x");
        const start = Math.floor(rand() * Math.max(1, words.length - 2));
        const kind = Math.floor(rand() * 9);
        const negate = rand() < 0.2;
        const op = pick(ops);
        const sub = (s: string) => {
          if (op === "equals") return s;
          if (op === "startsWith") return s.slice(0, Math.max(1, Math.ceil(s.length / 2)));
          if (op === "endsWith") return s.slice(Math.floor(s.length / 2));
          const a = Math.floor(rand() * Math.max(1, s.length - 3));
          return s.slice(a, a + 3 + Math.floor(rand() * 5)) || s;
        };
        switch (kind) {
          case 0:
            conditions.push({ field: "from", op, value: sub(rand() < 0.5 ? m.from_name : m.from_email) || "a", negate });
            break;
          case 1:
            conditions.push({ field: "fromDomain", op, value: sub(m.from_email.split("@")[1] ?? "x") || "x", negate });
            break;
          case 2:
            conditions.push({ field: "subject", op, value: sub(m.subject).trim() || "re", negate });
            break;
          case 3:
            conditions.push({ field: "body", op, value: words.slice(start, start + 1 + Math.floor(rand() * 3)).join(" ") || "hola", negate });
            break;
          case 4:
            conditions.push({ field: "listId", op, value: sub(m.list_id ?? "news.platzi.com") || "news", negate });
            break;
          case 5:
            conditions.push({ field: "recipients", op: "contains", value: sub(m.recipients_text).trim() || "luis", negate });
            break;
          case 6:
            conditions.push({ field: "hasAttachment", op: "is", value: rand() < 0.5, negate });
            break;
          case 7:
            conditions.push({ field: "ageDays", op: rand() < 0.5 ? "gt" : "lt", value: Math.floor(rand() * 400), negate });
            break;
          default:
            conditions.push({ field: "account", op: "is", value: m.account_id, negate });
        }
      }
      rules.push({ match: rand() < 0.7 ? "all" : "any", conditions, actions: [{ type: "archive" }] });
    }
    // anchored body ops exercise the UDF verification path
    rules.push({ match: "all", conditions: [{ field: "body", op: "startsWith", value: "Hola" }], actions: [{ type: "star" }] });
    rules.push({ match: "all", conditions: [{ field: "body", op: "endsWith", value: "Saludos" }], actions: [{ type: "star" }] });
    // > BODY_TAIL_TOKENS tokens: exercises the FTS + UDF fallback instead of the tail column
    const longBody = messages.find((m) => tokenize(m.body_text ?? "").length > 45)!;
    const longTail = tokenize(longBody.body_text!).slice(-40).join(" ");
    rules.push({ match: "all", conditions: [{ field: "body", op: "endsWith", value: longTail }], actions: [{ type: "star" }] });
    rules.push({ match: "all", conditions: [{ field: "body", op: "equals", value: tokenize(longBody.body_text!).join(" ").slice(0, 400) }], actions: [{ type: "star" }] });
    return rules;
  }

  it("agree on every message for 120+ generated rules", () => {
    const live = messages.filter((m) => !m.is_trash);
    let nonTrivial = 0;
    for (const rule of generateRules()) {
      const expected = live.filter((m) => evaluateRule(rule, toRuleMessage(m), NOW)).map((m) => m.id).sort((a, b) => a - b);
      const actual = findRuleMatches(db, rule, NOW).messageIds.sort((a, b) => a - b);
      expect(actual, JSON.stringify(rule)).toEqual(expected);
      if (expected.length > 0 && expected.length < live.length) nonTrivial++;
    }
    expect(nonTrivial).toBeGreaterThan(60); // the generator must produce discriminating rules
  });
});

import { evaluateRule, tokenize, VIEWS, type FilterRule, type RuleMessage, type View } from "@unica/core";
import { generateDataset } from "@unica/mock-data";
import { UNVERSIONED } from "@unica/store";
import { byRecency, defineSearchConformance, VIEW_TEST, type SearchCorpus, type SearchHarness } from "@unica/store/conformance";
import { beforeAll, describe, expect, it } from "vitest";
import { listThreads, getCounts, VIEW_WHERE, type Cursor } from "./queries";
import { findRuleMatches } from "./rules";
import { resolveQuery } from "./search";
import { messageDocs, threadDocs } from "./search-docs";
import { Fts5SearchEngine } from "./search-engine";
import { seedDataset } from "./seed";
import type { Db } from "./sqlite";
import { openDatabase } from "./index";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.UTC(2026, 9, 22, 15, 30);

interface RuleRow {
  id: number;
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

let db: Db;
let corpus: SearchCorpus;
let messages: RuleRow[];

function open(): Db {
  db ??= (() => {
    const d = openDatabase(join(mkdtempSync(join(tmpdir(), "unica-search-")), "s.db"));
    seedDataset(d, generateDataset({ threads: 2500, accounts: 4, seed: 11, now: NOW }), { now: NOW });
    return d;
  })();
  return db;
}

function snapshot(d: Db): SearchCorpus {
  return {
    messages: messageDocs(d),
    threads: threadDocs(d),
    accounts: d.all("SELECT id, email, display_name FROM accounts"),
    categories: d.all("SELECT id, name FROM categories"),
  };
}

beforeAll(() => {
  open();
  corpus = snapshot(db);
  messages = db.all<RuleRow>(
    "SELECT id, account_id, from_name, from_email, recipients_text, subject, body_text, list_id, has_attachments, date, is_trash FROM messages",
  );
});

function harness(mode: "ids" | "fused"): () => Promise<SearchHarness> {
  return async () => {
    const d = open();
    const engine = new Fts5SearchEngine(d);
    return {
      now: NOW,
      corpus: async () => snapshot(d),
      search: async (query, scope, cursor, limit) => {
        const req = { search: resolveQuery(d, { query, ...scope, now: NOW }), cursor, limit };
        if (mode === "ids") return engine.query(req, UNVERSIONED);
        const page = engine.page(req, UNVERSIONED);
        return { threadIds: page.items.map((t) => t.id), nextCursor: page.nextCursor, strategy: page.strategy };
      },
    };
  };
}

defineSearchConformance("FTS5 engine (thread ids)", harness("ids"), { strategies: true });
defineSearchConformance("FTS5 engine (fused summaries)", harness("fused"), { strategies: true });

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
      const expected = corpus.threads.filter(VIEW_TEST[view]).sort(byRecency).map((t) => t.threadId);
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
    const inbox = corpus.threads.filter((t) => t.inInbox && t.unreadCount > 0);
    expect(counts.inboxUnread).toBe(inbox.length);
    for (const [accountId, n] of Object.entries(counts.inboxUnreadByAccount)) {
      expect(n).toBe(inbox.filter((t) => t.accountId === Number(accountId)).length);
    }
    for (const [categoryId, total] of Object.entries(counts.categoryTotal)) {
      const members = corpus.threads.filter((t) => t.categoryIds.includes(Number(categoryId)) && !t.inTrash && !t.inSpam);
      expect(total).toBe(members.length);
      expect(counts.categoryUnread[Number(categoryId)]).toBe(members.filter((t) => t.unreadCount > 0).length);
    }
  });
});

describe("filter rules: JS evaluator and SQL compiler agree", () => {
  function toRuleMessage(m: RuleRow): RuleMessage {
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

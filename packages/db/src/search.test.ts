import { generateDataset } from "@terno/mock-data";
import { UNVERSIONED } from "@terno/store";
import { defineSearchConformance, type SearchCorpus, type SearchHarness } from "@terno/store/conformance";
import { describe, expect, it } from "vitest";
import { VIEW_WHERE } from "./queries";
import { resolveQuery } from "./search";
import { messageDocs, threadDocs } from "./search-docs";
import { Fts5SearchEngine } from "./search-engine";
import { seedDataset } from "./seed";
import type { Db } from "./sqlite";
import { openDatabase } from "./index";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { View } from "@terno/core";

const NOW = Date.UTC(2026, 9, 22, 15, 30);

let db: Db;

function open(): Db {
  db ??= (() => {
    const d = openDatabase(join(mkdtempSync(join(tmpdir(), "terno-search-")), "s.db"));
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
  it("hot list queries walk their partial index with no sort step", () => {
    open();
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
});

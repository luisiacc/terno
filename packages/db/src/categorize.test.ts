import { CategorizerModel, contentTokens, encodeFeatures, extractFeatures, termsQuery } from "@terno/core";
import { describe, expect, it } from "vitest";
import {
  addToCategory,
  backfillExamples,
  backgroundCandidates,
  classifyNewThreads,
  loadExamples,
  matureDecisions,
  rejectSuggestion,
  removeFromCategory,
  threadFeatures,
} from "./categorize";
import { countScope, quickActions, resolveScope, scopeCountSql } from "./categorize-bulk";
import { ingestMessages, type IncomingMessage } from "./ingest";
import { createCategory } from "./repos";
import { msg, testDb, threadOf, withAccounts } from "./test/helpers";

describe("categorization features vs the FTS index", () => {
  it("content tokens are the FTS tokens (diacritics, case, scripts), so explanations and search agree", () => {
    const db = testDb();
    db.exec("CREATE VIRTUAL TABLE tok USING fts5(x, tokenize = 'unicode61 remove_diacritics 2')");
    db.exec("CREATE VIRTUAL TABLE tok_v USING fts5vocab(tok, 'instance')");
    const text = "Facturación ÁRBOL niño Ünïcödé São-Paulo e-mail café Ελληνικά кириллица";
    db.run("INSERT INTO tok (x) VALUES (?)", text);
    const fts = db.all<{ term: string }>("SELECT term FROM tok_v ORDER BY offset").map((r) => r.term);
    expect(fts).toContain("facturacion");
    expect(contentTokens(text)).toEqual(fts.filter((t) => t.length > 1));
  });
});

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;

describe("categorization training signals", () => {
  function setup() {
    const db = testDb();
    const [acct] = withAccounts(db, 1);
    const cat = createCategory(db, "Facturas", "amber").id;
    const other = createCategory(db, "Lecturas", "violet").id;
    const thread = (over: Partial<IncomingMessage> = {}) => {
      const m = msg({ accountId: acct!, from: { name: "Uber Receipts", email: "uber.receipts@uber.com" }, subject: "Tu recibo · $10.00", bodyText: "Total $10.00 MXN. Factura 12.", date: NOW - 10 * DAY, ...over });
      ingestMessages(db, [m]);
      return threadOf(db, m.providerMsgId!);
    };
    const examples = () => db.all<{ thread_id: number; category_id: number; label: number; weight: number; source: string; content: number; sender: string; batch_id: number | null }>(
      "SELECT thread_id, category_id, label, weight, source, content, sender, batch_id FROM cls_examples ORDER BY thread_id, category_id",
    );
    return { db, acct: acct!, cat, other, thread, examples };
  }

  it("removing an auto add reverts its decision within 30 days; filter rows become negatives too", () => {
    const { db, cat, thread, examples } = setup();
    const [a, b, c] = [thread(), thread(), thread()];
    for (const [t, at] of [[a, NOW - DAY], [b, NOW - 40 * DAY]] as const) {
      addToCategory(db, { categoryId: cat, threadIds: [t], addedBy: "auto", now: at });
      db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'auto', 0.99, '[]', ?)", t, cat, at);
    }
    addToCategory(db, { categoryId: cat, threadIds: [c], addedBy: "filter", now: NOW });
    removeFromCategory(db, { categoryId: cat, threadIds: [a, b, c], reason: "user", now: NOW });
    const outcome = (t: number) => db.get<{ outcome: string | null }>("SELECT outcome FROM cls_decisions WHERE thread_id = ?", t)!.outcome;
    expect(outcome(a)).toBe("reverted");
    expect(outcome(b)).toBeNull();
    expect(examples().map((e) => [e.thread_id, e.label])).toEqual([[a, -1], [b, -1], [c, -1]]);
  });

  it("accepting a suggestion records it; rejecting one is a weight-1 negative", () => {
    const { db, cat, thread, examples } = setup();
    const [a, b] = [thread(), thread()];
    for (const t of [a, b]) db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.9, '[]', ?)", t, cat, NOW);
    addToCategory(db, { categoryId: cat, threadIds: [a], addedBy: "suggestion", now: NOW });
    const rejected = rejectSuggestion(db, b, cat, NOW);
    expect(rejected.map((d) => d.op)).toEqual(["train"]);
    expect(db.all("SELECT thread_id, outcome FROM cls_decisions ORDER BY thread_id")).toEqual([{ thread_id: a, outcome: "accepted" }, { thread_id: b, outcome: "rejected" }]);
    expect(examples()).toMatchObject([{ thread_id: a, label: 1, weight: 1, source: "suggestion" }, { thread_id: b, label: -1, weight: 1, source: "reject" }]);
  });

  it("features come from the root inbound message, never from the user's own mail", () => {
    const { db, acct, cat } = setup();
    const mine = msg({ accountId: acct, from: { name: "Me", email: "me0@example.com" }, isSent: true, subject: "Propuesta", date: NOW - 5 * DAY });
    const reply = msg({ accountId: acct, from: { name: "Ana (Café Altura)", email: "ana@cafealtura.mx" }, subject: "Re: Propuesta", inReplyTo: mine.rfcMessageId, date: NOW - 4 * DAY });
    const later = msg({ accountId: acct, from: { name: "Beto", email: "beto@cafealtura.mx" }, subject: "Re: Propuesta", inReplyTo: reply.rfcMessageId, date: NOW - 3 * DAY });
    ingestMessages(db, [mine, reply, later]);
    const t = threadOf(db, mine.providerMsgId!);
    const set = threadFeatures(db, [t]).get(t)!;
    expect(set.features).toMatchObject({ sender: "ana@cafealtura.mx", domain: "cafealtura.mx" });
    expect(set.features.intents).toContain("replied");
    // a conversation only the user wrote has nothing to learn from
    const solo = msg({ accountId: acct, from: { name: "Me", email: "me0@example.com" }, isSent: true });
    ingestMessages(db, [solo]);
    const s = threadOf(db, solo.providerMsgId!);
    expect(addToCategory(db, { categoryId: cat, threadIds: [s], addedBy: "user", now: NOW }).deltas.map((d) => d.op)).toEqual(["unbackground"]);
  });

  it("backfills examples for category rows from before v4, once", () => {
    const { db, acct, cat, thread, examples } = setup();
    const [a, b] = [thread(), thread()];
    const solo = msg({ accountId: acct, from: { name: "Me", email: "me0@example.com" }, isSent: true });
    ingestMessages(db, [solo]);
    const s = threadOf(db, solo.providerMsgId!);
    for (const [t, by] of [[a, "user"], [b, "filter"], [s, "user"]] as const) db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) VALUES (?, ?, ?, ?)", t, cat, by, NOW - 100 * DAY);
    expect(backfillExamples(db)).toBe(2);
    expect(backfillExamples(db)).toBe(0);
    expect(examples().filter((e) => e.weight > 0)).toMatchObject([{ thread_id: a, label: 1, source: "user" }]);
    expect(loadExamples(db).filter((e) => e.features.length > 0)).toHaveLength(1);
  });

  it("background = uncategorized inbound mail at least 3 days old, outside spam and trash", () => {
    const { db, acct, cat, thread } = setup();
    const old = thread({ date: NOW - 10 * DAY });
    thread({ date: NOW - DAY });
    const filed = thread({ date: NOW - 10 * DAY });
    thread({ date: NOW - 10 * DAY, isSpam: true, inInbox: false });
    const sent = msg({ accountId: acct, from: { name: "Me", email: "me0@example.com" }, isSent: true, date: NOW - 10 * DAY });
    ingestMessages(db, [sent]);
    addToCategory(db, { categoryId: cat, threadIds: [filed], addedBy: "filter", now: NOW });
    expect(backgroundCandidates(db, NOW)).toEqual([old]);
  });

  it("thread merges carry examples and decisions to the surviving thread", () => {
    const { db, acct, cat } = setup();
    const a = msg({ accountId: acct, rfcMessageId: "a@x", from: { name: "Ana", email: "ana@cafealtura.mx" } });
    const c = msg({ accountId: acct, rfcMessageId: "c@x", references: ["b@x"], from: { name: "Ana", email: "ana@cafealtura.mx" } });
    ingestMessages(db, [a, c]);
    const [ta, tc] = [threadOf(db, a.providerMsgId!), threadOf(db, c.providerMsgId!)];
    addToCategory(db, { categoryId: cat, threadIds: [tc], addedBy: "user", now: NOW });
    db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.9, '[]', ?)", tc, cat, NOW);
    // b references a and is referenced by c: the two threads merge
    ingestMessages(db, [msg({ accountId: acct, rfcMessageId: "b@x", references: ["a@x"], from: { name: "Ana", email: "ana@cafealtura.mx" } })]);
    const survivor = Math.min(ta, tc);
    expect(db.all<{ thread_id: number }>("SELECT thread_id FROM cls_examples").map((r) => r.thread_id)).toEqual([survivor]);
    expect(db.all<{ thread_id: number }>("SELECT thread_id FROM cls_decisions").map((r) => r.thread_id)).toEqual([survivor]);
  });

  it("auto decisions mature as kept after 30 days", () => {
    const { db, cat, thread } = setup();
    const [a, b] = [thread(), thread()];
    db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'auto', 0.99, '[]', ?), (?, ?, 'auto', 0.99, '[]', ?)", a, cat, NOW - 31 * DAY, b, cat, NOW - 5 * DAY);
    expect(matureDecisions(db, NOW)).toBe(1);
    expect(db.all("SELECT thread_id, outcome FROM cls_decisions ORDER BY thread_id")).toEqual([{ thread_id: a, outcome: "kept" }, { thread_id: b, outcome: null }]);
  });
});

describe("bulk scopes, counts and quick actions", () => {
  function mailbox() {
    const db = testDb();
    const [acct] = withAccounts(db, 1);
    const cat = createCategory(db, "Facturas", "amber").id;
    let n = 0;
    const add = (over: Partial<IncomingMessage>) => {
      const m = msg({ accountId: acct!, date: NOW - ++n * 60_000, ...over });
      ingestMessages(db, [m]);
      return threadOf(db, m.providerMsgId!);
    };
    const uber = (over: Partial<IncomingMessage> = {}) =>
      add({ from: { name: "Uber Receipts", email: "uber.receipts@uber.com" }, subject: "Tu recibo de Uber", bodyText: "Total $10.00 MXN. Factura disponible. Viaje al aeropuerto.", ...over });
    return { db, acct: acct!, cat, add, uber };
  }

  it("domain and list scopes match their column (not free text), uncapped", () => {
    const { db, cat, add } = mailbox();
    const list = Array.from({ length: 620 }, (_, i) => add({ from: { name: "Xataka", email: `boletin${i % 3}@xataka.com` }, listId: "boletin.xataka.com", subject: "Lo mejor de la semana" }));
    // mentions the list id in its text, but isn't on the list
    add({ from: { name: "Ana", email: "ana@gmail.com" }, subject: "boletin.xataka.com", bodyText: "mira boletin.xataka.com" });
    const eats = add({ from: { name: "Uber Eats", email: "eats@uber.com" }, subject: "Tu pedido" });
    const receipts = add({ from: { name: "Uber", email: "uber.receipts@uber.com" }, subject: "Recibo" });
    expect(resolveScope(db, cat, { kind: "list", listId: "boletin.xataka.com" }, NOW)).toHaveLength(620);
    expect(new Set(resolveScope(db, cat, { kind: "list", listId: "Boletin.Xataka.com" }, NOW))).toEqual(new Set(list));
    expect(resolveScope(db, cat, { kind: "domain", domain: "@uber.com" }, NOW).sort()).toEqual([eats, receipts].sort());
  });

  it("counts are capped at 1 000 (\"1 000+\")", () => {
    const { db, cat, add } = mailbox();
    for (let i = 0; i < 1003; i++) add({ from: { name: "Morning Brew", email: "crew@morningbrew.com" }, listId: "daily.morningbrew.com" });
    expect(countScope(db, cat, { kind: "list", listId: "daily.morningbrew.com" }, NOW)).toEqual({ count: 1000, capped: true });
    expect(countScope(db, cat, { kind: "query", query: "from:crew@morningbrew.com" }, NOW)).toEqual({ count: 1000, capped: true });
    expect(resolveScope(db, cat, { kind: "list", listId: "daily.morningbrew.com" }, NOW)).toHaveLength(1003);
  });

  it("query scope uses the search language, minus what is filed or removed", () => {
    const { db, cat, uber, add } = mailbox();
    const [a, b] = [uber(), uber()];
    uber({ subject: "Promo", bodyText: "Descuento en tu próximo viaje" });
    const other = add({ from: { name: "Ana", email: "ana@cafealtura.mx" }, subject: "Te mando la factura", bodyText: "Adjunto" });
    addToCategory(db, { categoryId: cat, threadIds: [a], addedBy: "user", now: NOW });
    expect(resolveScope(db, cat, { kind: "query", query: termsQuery(["factura"], "Facturas") }, NOW).sort()).toEqual([b, other].sort());
    expect(resolveScope(db, cat, { kind: "query", query: '"factura" from:uber.receipts@uber.com' }, NOW)).toEqual([b]);
  });

  it("counts walk the sender, domain and list indexes and exclude filed threads through thread_categories_c", () => {
    const { db, cat } = mailbox();
    const plan = (scope: Parameters<typeof scopeCountSql>[2]) => {
      const { sql, params } = scopeCountSql(db, cat, scope);
      return db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join(" | ");
    };
    for (const [scope, index] of [
      [{ kind: "sender", email: "a@b.co" }, "messages_from"],
      [{ kind: "domain", domain: "b.co" }, "messages_domain"],
      [{ kind: "list", listId: "l.b.co" }, "messages_list"],
    ] as const) {
      const p = plan(scope);
      expect(p, scope.kind).toMatch(new RegExp(`USING (COVERING )?INDEX ${index}`));
      expect(p, scope.kind).toMatch(/thread_categories_c/);
      expect(p, scope.kind).not.toMatch(/SCAN t\b|SCAN threads/);
    }
  });

  it("quick actions: what the threads share, distinguishing words without the sender's brand, and a filter draft", () => {
    const { db, cat, uber, add } = mailbox();
    const t = uber({ subject: "Tu recibo de Uber · viaje 4821", bodyText: "Gracias por tu viaje. Total: $10.00 MXN. Factura CFDI disponible." });
    const qa = quickActions(db, cat, [t], null);
    expect(qa.sender).toEqual({ email: "uber.receipts@uber.com", name: "Uber Receipts" });
    expect(qa.domain).toBe("uber.com");
    expect(qa.list).toBeNull();
    const words = qa.terms.map((x) => x.term);
    expect(words).not.toContain("uber");
    expect(words).not.toContain("receipts");
    expect(words.some((w) => w.startsWith("#"))).toBe(false);
    expect(qa.terms.filter((x) => x.preselected)).toHaveLength(Math.min(2, words.length));
    expect(qa.filterDraft).toEqual({
      name: "Uber Receipts",
      rule: { match: "all", conditions: [{ field: "from", op: "equals", value: "uber.receipts@uber.com" }], actions: [{ type: "addCategory", categoryId: cat }] },
    });
    // several threads: only what all of them share
    const eats = add({ from: { name: "Uber Eats", email: "eats@uber.com" }, subject: "Tu recibo de Uber Eats", bodyText: "Factura disponible" });
    const both = quickActions(db, cat, [t, eats], null);
    expect(both.sender).toBeNull();
    expect(both.domain).toBe("uber.com");
    expect(both.filterDraft?.rule.conditions).toEqual([{ field: "fromDomain", op: "equals", value: "uber.com" }]);
    // consumer domains are not a group
    const friend = add({ from: { name: "Ana", email: "ana@gmail.com" }, subject: "Hola" });
    expect(quickActions(db, cat, [friend], null).domain).toBeNull();
  });
});

describe("classification when a body arrives", () => {
  /** Two content-learned categories (receipts in subjects, trips in bodies) and personal background mail. */
  function setupModel() {
    const db = testDb();
    const [acct] = withAccounts(db, 1);
    const recibos = createCategory(db, "Recibos", "amber").id;
    const viajes = createCategory(db, "Viajes", "cyan").id;
    const model = new CategorizerModel({ decayRef: NOW });
    const enc = (from: string, subject: string, bodyText: string) =>
      encodeFeatures(extractFeatures({ fromEmail: from, fromName: from, listId: null, subject, bodyText, replied: false, attachmentNames: [] }, { ownDomains: new Set(["example.com"]) }));
    for (let i = 0; i < 40; i++) {
      model.train({ categoryId: recibos, label: 1, weight: 1, at: NOW, content: true, features: enc(`r${i % 6}@shop${i % 6}.com`, "Tu recibo total pago", "") });
      model.train({ categoryId: viajes, label: 1, weight: 1, at: NOW, content: true, features: enc(`v${i % 6}@air${i % 6}.com`, "", "Tu vuelo reservacion aeropuerto hospedaje") });
    }
    for (let i = 0; i < 200; i++) model.addBackground(10_000 + i, enc(`amigo${i % 20}@gmail.com`, "Comida el sabado", "Hola amigo, un abrazo"));
    const classify = (r: { inserted?: number[]; bodyCompleted?: number[] }) =>
      db.tx(() => classifyNewThreads(db, { inserted: r.inserted ?? [], bodyCompleted: r.bodyCompleted ?? [], now: NOW, mode: "auto", model }));
    return { db, acct: acct!, recibos, viajes, classify };
  }

  it("an early auto add doesn't stop the body from deciding the remaining categories", () => {
    const { db, acct, recibos, viajes, classify } = setupModel();
    const m = msg({ accountId: acct, from: { name: "Nuevo", email: "hola@nuevo.io" }, subject: "Tu recibo total pago", bodyText: null, bodyState: "partial", date: NOW - 3_600_000 });
    const first = ingestMessages(db, [m], NOW);
    classify({ inserted: first.inserted });
    const t = threadOf(db, m.providerMsgId!);
    expect(db.all("SELECT category_id, added_by FROM thread_categories WHERE thread_id = ?", t)).toEqual([{ category_id: recibos, added_by: "auto" }]);
    const second = ingestMessages(db, [{ ...m, bodyState: "full", bodyText: "Tu vuelo reservacion aeropuerto hospedaje" }], NOW);
    expect(second.bodyCompleted).toHaveLength(1);
    classify({ bodyCompleted: second.bodyCompleted });
    expect(db.all("SELECT category_id FROM thread_categories WHERE thread_id = ? ORDER BY category_id", t)).toEqual([{ category_id: recibos }, { category_id: viajes }]);
    // the first auto decision keeps its date (maturing isn't reset)
    expect(db.all("SELECT category_id, kind FROM cls_decisions WHERE thread_id = ? ORDER BY category_id", t)).toEqual([
      { category_id: recibos, kind: "auto" },
      { category_id: viajes, kind: "auto" },
    ]);
  });

  it("rescoring replaces the pending suggestions: one the new evidence no longer supports is withdrawn", () => {
    const { db, acct, viajes, classify } = setupModel();
    const m = msg({ accountId: acct, from: { name: "Ana", email: "ana@gmail.com" }, subject: "Hola", bodyText: null, bodyState: "partial", date: NOW - 3_600_000 });
    ingestMessages(db, [m], NOW);
    const t = threadOf(db, m.providerMsgId!);
    db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.85, '[]', ?)", t, viajes, NOW);
    const second = ingestMessages(db, [{ ...m, bodyState: "full", bodyText: "Hola amigo, un abrazo" }], NOW);
    classify({ bodyCompleted: second.bodyCompleted });
    expect(db.get("SELECT 1 FROM cls_decisions WHERE thread_id = ?", t)).toBeUndefined();
  });

  it("explicit user decisions still close the thread to the engine", () => {
    const { db, acct, recibos, classify } = setupModel();
    const m = msg({ accountId: acct, from: { name: "Nuevo", email: "hola@nuevo.io" }, subject: "Tu recibo total pago", bodyText: null, bodyState: "partial", date: NOW - 3_600_000 });
    ingestMessages(db, [m], NOW);
    const t = threadOf(db, m.providerMsgId!);
    addToCategory(db, { categoryId: recibos, threadIds: [t], addedBy: "user", now: NOW });
    const second = ingestMessages(db, [{ ...m, bodyState: "full", bodyText: "Tu vuelo reservacion aeropuerto hospedaje" }], NOW);
    expect(classify({ bodyCompleted: second.bodyCompleted }).touched.size).toBe(0);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@unica/core/rpc";
import { addToCategory, createAccount, createCategory, ingestMessages, seedDataset, type IncomingMessage } from "@unica/db";
import { demoRegistry } from "@unica/mail";
import { generateDataset } from "@unica/mock-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function open(dir: string, now: () => number = () => NOW) {
  const backend = new Backend({ dbPath: join(dir, "unica.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  return { backend, client: new RpcClient(c) };
}

function setup(options: { seed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "unica-cat-"));
  const { backend, client } = open(dir);
  let stopped = false;
  cleanups.push(async () => {
    if (!stopped) await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  if (options.seed) seedDataset(backend.db, generateDataset({ threads: 600, accounts: 2, seed: 9, now: NOW }), { now: NOW });
  const stop = async () => {
    stopped = true;
    await backend.stop();
  };
  return { backend, client, dir, stop };
}

let n = 0;
function incoming(accountId: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  n++;
  return {
    accountId,
    providerMsgId: `c${n}`,
    providerThreadId: null,
    rfcMessageId: `c${n}@x`,
    inReplyTo: null,
    references: [],
    from: { name: "Uber Receipts", email: "uber.receipts@uber.com" },
    to: [{ name: "Me", email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: `Tu recibo de Uber · $${n}.00 MXN`,
    date: NOW - DAY,
    snippet: "",
    bodyText: `Gracias por tu viaje. Total: $${n}.00 MXN. Factura ${n} disponible.`,
    bodyHtml: null,
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
    size: 10,
    ...over,
  };
}

describe("categorizer: training hooks", () => {
  it("UI adds train the in-memory model only after their transaction commits", async () => {
    const { backend, client } = setup();
    const acct = createAccount(backend.db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(backend.db, "Facturas", "amber").id;
    const r = ingestMessages(backend.db, [incoming(acct), incoming(acct), incoming(acct)]);
    const threads = [...r.touchedThreads];
    backend.categorizer.rebuildSync();
    const model = backend.categorizer.model!;

    const res = await client.call("categories.addThreads", { categoryId: cat, threadIds: threads.slice(0, 2) });
    expect(res).toEqual({ added: 2, addedIds: threads.slice(0, 2), batchId: expect.any(Number) });
    expect(model.positives(cat)).toBe(2);

    // a store command that rolls back leaves RAM untouched
    expect(() =>
      backend.db.tx(() => {
        const out = addToCategory(backend.db, { categoryId: cat, threadIds: [threads[2]!], addedBy: "user", now: NOW });
        backend.categorizer.apply(out.deltas);
      }),
    ).toThrow(/after the transaction commits/);
    expect(model.positives(cat)).toBe(2);
    expect(backend.db.get("SELECT 1 FROM cls_examples WHERE thread_id = ?", threads[2]!)).toBeUndefined();

    // removal: positive untrained, strong negative trained
    await client.call("categories.removeThreads", { categoryId: cat, threadIds: [threads[0]!] });
    expect(model.positives(cat)).toBe(1);
    expect(backend.db.get("SELECT label, weight FROM cls_examples WHERE thread_id = ?", threads[0]!)).toEqual({ label: -1, weight: 3 });
  });

  it("snackbar adds are bulk (half weight) and the whole batch undoes exactly", async () => {
    const { backend, client } = setup();
    const acct = createAccount(backend.db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(backend.db, "Facturas", "amber").id;
    const threads = [...ingestMessages(backend.db, [incoming(acct), incoming(acct), incoming(acct)]).touchedThreads];
    backend.categorizer.rebuildSync();
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [threads[0]!] });
    const bulk = await client.call("categories.addThreads", { categoryId: cat, threadIds: threads, source: "snackbar" });
    expect(bulk.addedIds).toEqual(threads.slice(1));
    expect(backend.db.all<{ source: string; weight: number }>("SELECT source, weight FROM cls_examples ORDER BY thread_id").map((r) => [r.source, r.weight])).toEqual([["user", 1], ["bulk", 0.5], ["bulk", 0.5]]);
    expect(await client.call("categorize.undo", { batchId: bulk.batchId! })).toEqual({ removed: 2 });
    expect(backend.categorizer.model!.positives(cat)).toBe(1);
    expect(backend.db.all<{ thread_id: number }>("SELECT thread_id FROM thread_categories").map((r) => r.thread_id)).toEqual([threads[0]]);
    // undoing the picker add (reason "undo") forgets it without a negative
    await client.call("categories.removeThreads", { categoryId: cat, threadIds: [threads[0]!], reason: "undo" });
    expect(backend.categorizer.model!.positives(cat)).toBe(0);
    expect(backend.db.get("SELECT 1 FROM cls_examples")).toBeUndefined();
  });

  it("an add that changes nothing returns no undo handle", async () => {
    const { backend, client } = setup();
    const acct = createAccount(backend.db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(backend.db, "Facturas", "amber").id;
    const [t] = [...ingestMessages(backend.db, [incoming(acct)]).touchedThreads];
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [t!] });
    expect(await client.call("categories.addThreads", { categoryId: cat, threadIds: [t!] })).toEqual({ added: 0, addedIds: [], batchId: null });
    await expect(client.call("categories.addThreads", { categoryId: 999, threadIds: [t!] })).rejects.toThrow(/not found/);
  });

  it("a seeded mailbox starts warm: the rebuild trains every user-filed thread", async () => {
    const { backend } = setup({ seed: true });
    expect(backend.categorizer.ready).toBe(false);
    backend.start();
    await backend.categorizer.rebuild();
    const model = backend.categorizer.model!;
    for (const { id } of backend.db.all<{ id: number }>("SELECT id FROM categories")) {
      const filed = backend.db.get<{ c: number }>("SELECT count(*) AS c FROM cls_examples WHERE category_id = ? AND label = 1 AND weight > 0", id)!.c;
      expect(filed).toBeGreaterThan(0);
      expect(model.positives(id)).toBe(filed);
    }
    expect(model.backgroundSize).toBeGreaterThan(50);
  });

  it("persists a snapshot on stop and adopts it on the next start; a stale one is rebuilt", async () => {
    const { backend, dir, stop } = setup({ seed: true });
    backend.categorizer.rebuildSync();
    const probe = backend.db.all<{ features: Uint8Array }>("SELECT features FROM cls_examples LIMIT 5");
    const { featuresFromBlob } = await import("@unica/core");
    const scores = probe.map((p) => backend.categorizer.model!.score(featuresFromBlob(p.features)));
    await stop();

    const again = open(dir);
    expect(again.backend.categorizer.ready).toBe(true);
    expect(probe.map((p) => again.backend.categorizer.model!.score(featuresFromBlob(p.features)))).toEqual(scores);
    // an example written behind the model's back (a crash before the snapshot) makes it stale
    again.backend.db.run("UPDATE cls_examples SET weight = 0.5 WHERE thread_id = (SELECT min(thread_id) FROM cls_examples)");
    await again.backend.stop();
    const third = open(dir);
    expect(third.backend.categorizer.ready).toBe(false);
    await third.backend.stop();
  });

  it("writes committed during a sliced rebuild are replayed onto the new model", async () => {
    const { backend, client } = setup({ seed: true });
    const cat = backend.db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
    backend.categorizer.rebuildSync();
    const target = backend.db.get<{ id: number }>(
      "SELECT id FROM threads t WHERE NOT EXISTS (SELECT 1 FROM thread_categories tc WHERE tc.thread_id = t.id) AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.is_sent = 0) LIMIT 1",
    )!.id;
    const before = backend.categorizer.model!.positives(cat);
    const rebuilding = backend.categorizer.rebuild();
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [target] });
    await rebuilding;
    expect(backend.categorizer.model!.positives(cat)).toBe(before + 1);
    expect(backend.categorizer.model!.hasBackground(target)).toBe(false);
  });
});

describe("categorizer: auto-apply at ingestion", () => {
  const SENDERS = [
    { name: "Uber Receipts", email: "uber.receipts@uber.com" },
    { name: "Rappi", email: "recibos@rappi.com" },
    { name: "Stripe", email: "receipts@stripe.com" },
    { name: "Vercel", email: "billing@vercel.com" },
    { name: "BBVA", email: "alertas@bbva.mx" },
    { name: "CFE Recibos", email: "recibos@cfe.mx" },
  ];
  const receipt = (from: { name: string; email: string }, i: number): Partial<IncomingMessage> => ({
    from,
    subject: `Tu recibo de ${from.name} · $${100 + i}.00 MXN`,
    bodyText: `Gracias por tu pago. Total: $${100 + i}.00 MXN. Factura ${1000 + i} disponible.`,
  });

  /** A mailbox where the user filed 6 receipt senders into Facturas (examples 120 days old) next to uncategorized personal mail and promotions. */
  async function trained(options: { examplesAt?: number } = {}) {
    const { backend, client } = setup();
    const acct = createAccount(backend.db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(backend.db, "Facturas", "amber").id;
    const old: IncomingMessage[] = [];
    SENDERS.forEach((s, k) => {
      for (let i = 0; i < 6; i++) old.push(incoming(acct, { ...receipt(s, k * 10 + i), date: NOW - (40 + k * 6 + i) * DAY, inInbox: false }));
    });
    for (let i = 0; i < 300; i++) {
      const topic = ["¿Comida el sábado?", "Fotos del viaje", "Plan para el puente", "Te mando el documento", "Cumpleaños de mamá"][i % 5]!;
      old.push(incoming(acct, { from: { name: `Amigo ${i % 30}`, email: `amigo${i % 30}@gmail.com` }, subject: topic, bodyText: `Hola, ${topic.toLowerCase()} Un abrazo`, date: NOW - (20 + (i % 200)) * DAY, inInbox: false }));
    }
    // promotions nobody files: bulk mail is not a Facturas signal by itself
    for (let i = 0; i < 100; i++) {
      old.push(incoming(acct, { from: { name: `Tienda ${i % 10}`, email: `info@tienda${i % 10}.com` }, listId: `ofertas.tienda${i % 10}.com`, subject: "Ofertas de la semana en tu cuenta", bodyText: "Descuentos en toda la tienda. Darse de baja", date: NOW - (20 + (i % 150)) * DAY, inInbox: false }));
    }
    const r = ingestMessages(backend.db, old, NOW);
    const filed = backend.db
      .all<{ thread_id: number }>(
        "SELECT DISTINCT thread_id FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND from_email IN (SELECT value FROM json_each(?))",
        JSON.stringify(r.inserted),
        JSON.stringify(SENDERS.map((x) => x.email)),
      )
      .map((x) => x.thread_id);
    addToCategory(backend.db, { categoryId: cat, threadIds: filed, addedBy: "user", now: options.examplesAt ?? NOW - 120 * DAY });
    backend.categorizer.rebuildSync();
    const arrive = async (over: Partial<IncomingMessage>) => {
      const m = incoming(acct, { date: NOW - 3_600_000, ...over });
      await backend.ingestSliced([m]);
      return { thread: backend.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", m.providerMsgId)!.thread_id, message: m };
    };
    const decision = (thread: number) => backend.db.get<{ kind: string; outcome: string | null; explain_json: string }>("SELECT kind, outcome, explain_json FROM cls_decisions WHERE thread_id = ? AND category_id = ?", thread, cat);
    const inCategory = (thread: number) => backend.db.get<{ added_by: string }>("SELECT added_by FROM thread_categories WHERE thread_id = ? AND category_id = ?", thread, cat)?.added_by ?? null;
    return { backend, client, acct, cat, arrive, decision, inCategory };
  }

  it("files new inbox mail from a filed sender, explains why, and never trains on it", async () => {
    const { backend, cat, arrive, decision, inCategory } = await trained();
    const positives = backend.categorizer.model!.positives(cat);
    const { thread } = await arrive(receipt(SENDERS[0]!, 99));
    expect(inCategory(thread)).toBe("auto");
    const d = decision(thread)!;
    expect(d.kind).toBe("auto");
    expect(JSON.parse(d.explain_json)[0]).toMatch(/^mismo remitente que \d+ conversaciones en Facturas$/);
    // auto adds never train the model (no feedback loop)
    expect(backend.categorizer.model!.positives(cat)).toBe(positives);
    expect(backend.db.get("SELECT 1 FROM cls_examples WHERE thread_id = ?", thread)).toBeUndefined();
  });

  it("only evaluates new inbound inbox mail: not archived, spam, drafts, old backfill or replies", async () => {
    const { backend, arrive, decision, inCategory } = await trained();
    const archived = await arrive({ ...receipt(SENDERS[1]!, 1), inInbox: false });
    const spam = await arrive({ ...receipt(SENDERS[1]!, 2), inInbox: false, isSpam: true });
    const backfill = await arrive({ ...receipt(SENDERS[1]!, 3), date: NOW - 20 * DAY });
    for (const t of [archived.thread, spam.thread]) {
      expect(decision(t)).toBeUndefined();
      expect(inCategory(t)).toBeNull();
    }
    // older than the auto window (backfill): nothing during the import, a suggestion once it settles
    expect(decision(backfill.thread)).toBeUndefined();
    await backend.categorizer.rebuild();
    expect(decision(backfill.thread)?.kind).toBe("suggest");
    expect(inCategory(backfill.thread)).toBeNull();
    // a reply on an old, unfiled conversation is not new mail
    const friend = await arrive({ from: { name: "Amigo 1", email: "amigo1@gmail.com" }, subject: "Hola", bodyText: "¿Cómo vas?", inInbox: false });
    const reply = await arrive({ ...receipt(SENDERS[1]!, 4), inReplyTo: friend.message.rfcMessageId });
    expect(reply.thread).toBe(friend.thread);
    expect(decision(friend.thread)).toBeUndefined();
  });

  it("respects the global switch", async () => {
    const { client, arrive, decision, inCategory } = await trained();
    await client.call("settings.update", { autoCategorize: "suggest" });
    const s = await arrive(receipt(SENDERS[2]!, 1));
    expect(decision(s.thread)?.kind).toBe("suggest");
    expect(inCategory(s.thread)).toBeNull();
    await client.call("settings.update", { autoCategorize: "off" });
    const o = await arrive(receipt(SENDERS[2]!, 2));
    expect(decision(o.thread)).toBeUndefined();
  });

  it("never re-adds a thread the user removed, even when its body or a reply arrives", async () => {
    const { backend, client, cat, arrive, decision, inCategory } = await trained();
    const { thread, message } = await arrive({ ...receipt(SENDERS[3]!, 1), bodyState: "partial" });
    expect(inCategory(thread)).toBe("auto");
    await client.call("categories.removeThreads", { categoryId: cat, threadIds: [thread] });
    expect(decision(thread)!.outcome).toBe("reverted");
    // the same message again, now complete: reclassified at most... but never back in
    await backend.ingestSliced([{ ...message, bodyState: "full" }]);
    await arrive({ ...receipt(SENDERS[3]!, 2), inReplyTo: message.rfcMessageId });
    expect(inCategory(thread)).toBeNull();
    expect(backend.db.get("SELECT label FROM cls_examples WHERE thread_id = ?", thread)).toEqual({ label: -1 });
  });

  it("backs off a sender after the user removes two of its threads", async () => {
    const { client, cat, arrive, decision, inCategory } = await trained();
    const a = await arrive(receipt(SENDERS[4]!, 1));
    const b = await arrive(receipt(SENDERS[4]!, 2));
    expect([inCategory(a.thread), inCategory(b.thread)]).toEqual(["auto", "auto"]);
    await client.call("categories.removeThreads", { categoryId: cat, threadIds: [a.thread, b.thread] });
    const c = await arrive(receipt(SENDERS[4]!, 3));
    expect(inCategory(c.thread)).toBeNull();
    expect(decision(c.thread)).toBeUndefined();
    // other senders are unaffected
    expect(inCategory((await arrive(receipt(SENDERS[0]!, 3))).thread)).toBe("auto");
  });

  it("pauses auto for a category whose matured outcomes fail the safety valve", async () => {
    const { backend, cat, arrive, decision, inCategory } = await trained();
    const threads = backend.db.all<{ thread_id: number }>("SELECT thread_id FROM cls_examples LIMIT 12").map((r) => r.thread_id);
    threads.forEach((t, i) =>
      backend.db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at, outcome) VALUES (?, ?, 'auto', 0.99, '[]', ?, ?)", t, cat, NOW - 40 * DAY, i < 4 ? "reverted" : "kept"),
    );
    const { thread } = await arrive(receipt(SENDERS[0]!, 7));
    expect(inCategory(thread)).toBeNull();
    expect(decision(thread)?.kind).toBe("suggest");
  });

  it("vetoes look-alikes: a trained display name from another domain is neither filed nor suggested", async () => {
    const { arrive, decision, inCategory } = await trained();
    const { thread } = await arrive({ from: { name: "BBVA", email: "alertas@bbva-mx-seguridad.com" }, subject: "Cargo por $8,450.00 en tu tarjeta", bodyText: "Se realizó un movimiento por $8,450.00 MXN. Factura 1. Verifica tu cuenta." });
    expect(inCategory(thread)).toBeNull();
    expect(decision(thread)).toBeUndefined();
  });

  it("filters run first: mail they categorize is left alone", async () => {
    const { backend, client, cat, arrive, decision, inCategory } = await trained();
    await client.call("filters.save", {
      name: "Uber",
      enabled: true,
      source: "manual",
      rule: { match: "all", conditions: [{ field: "from", op: "equals", value: "uber.receipts@uber.com" }], actions: [{ type: "addCategory", categoryId: cat }] },
    });
    const { thread } = await arrive(receipt(SENDERS[0]!, 8));
    expect(inCategory(thread)).toBe("filter");
    expect(decision(thread)).toBeUndefined();
    expect(backend.db.get("SELECT 1 FROM cls_examples WHERE thread_id = ?", thread)).toBeUndefined();
  });

  it("reclassifies once when the body arrives; an unknown sender gets in on content alone", async () => {
    const { backend, arrive, decision, inCategory } = await trained({ examplesAt: NOW - 30 * DAY });
    const { thread, message } = await arrive({ from: { name: "Netflix", email: "info@account.netflix.com" }, subject: "Aviso de tu cuenta", bodyText: null, bodyState: "none" });
    expect(decision(thread)).toBeUndefined();
    await backend.ingestSliced([{ ...message, bodyState: "full", bodyText: "Tu recibo de Netflix. Gracias por tu pago. Total: $199.00 MXN. Factura 77 disponible." }]);
    expect(inCategory(thread)).toBe("auto");
    expect(JSON.parse(decision(thread)!.explain_json)[0]).toBe("remitente nuevo");
  });

  it("announces auto-filed mail once per category, coalesced", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { client, cat, arrive } = await trained();
      const seen: { categoryId: number; threadIds: number[] }[] = [];
      client.on("categorized", (e) => seen.push(e));
      const a = await arrive(receipt(SENDERS[0]!, 11));
      const b = await arrive(receipt(SENDERS[1]!, 12));
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1600);
      await new Promise((r) => setImmediate(r));
      expect(seen).toEqual([{ categoryId: cat, threadIds: [a.thread, b.thread], by: "auto" }]);
      // the next one waits for the 30 s window
      const c = await arrive(receipt(SENDERS[2]!, 13));
      vi.advanceTimersByTime(5000);
      await new Promise((r) => setImmediate(r));
      expect(seen).toHaveLength(1);
      vi.advanceTimersByTime(30_000);
      await new Promise((r) => setImmediate(r));
      expect(seen[1]).toEqual({ categoryId: cat, threadIds: [c.thread], by: "auto" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("categorize RPCs: bulk apply, undo, predictions, suggestions", () => {
  async function mailbox() {
    const { backend, client } = setup();
    const acct = createAccount(backend.db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(backend.db, "Lecturas", "violet").id;
    return { backend, client, acct, cat };
  }

  it("applies a list scope to every matching thread (not a 500-capped text search) and undoes the whole batch", async () => {
    const { backend, client, acct, cat } = await mailbox();
    const news = Array.from({ length: 640 }, (_, i) => incoming(acct, { from: { name: "Xataka", email: "boletin@xataka.com" }, listId: "boletin.xataka.com", subject: `Lo mejor de la semana ${i}`, bodyText: "Tecnología. Darse de baja", date: NOW - (i + 1) * 3_600_000 }));
    // mentions the list in its text: the old card's free-text search would have added it
    const decoy = incoming(acct, { from: { name: "Ana", email: "ana@gmail.com" }, subject: "boletin.xataka.com", bodyText: "¿viste boletin.xataka.com?" });
    ingestMessages(backend.db, [...news, decoy], NOW);
    backend.categorizer.rebuildSync();
    const first = backend.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", news[0]!.providerMsgId)!.thread_id;
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [first] });

    expect(await client.call("categorize.count", { categoryId: cat, scope: { kind: "list", listId: "boletin.xataka.com" } })).toEqual({ count: 639, capped: false });
    const preview = await client.call("categorize.preview", { categoryId: cat, scope: { kind: "list", listId: "boletin.xataka.com" }, limit: 5 });
    expect(preview.sample).toHaveLength(5);
    const applied = await client.call("categorize.apply", { categoryId: cat, scope: { kind: "list", listId: "boletin.xataka.com" } });
    expect(applied).toEqual({ batchId: expect.any(Number), added: 639 });
    const decoyThread = backend.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", decoy.providerMsgId)!.thread_id;
    expect(backend.db.get("SELECT 1 FROM thread_categories WHERE thread_id = ?", decoyThread)).toBeUndefined();
    // bulk adds weigh half and teach content for at most 50 threads of the sender
    expect(backend.db.get<{ n: number; content: number }>("SELECT count(*) AS n, sum(content) AS content FROM cls_examples WHERE source = 'bulk'")).toEqual({ n: 639, content: 50 });
    expect(backend.categorizer.model!.positives(cat)).toBe(640);

    expect(await client.call("categorize.undo", { batchId: applied.batchId! })).toEqual({ removed: 639 });
    expect(backend.db.get<{ n: number }>("SELECT count(*) AS n FROM thread_categories")!.n).toBe(1);
    expect(backend.categorizer.model!.positives(cat)).toBe(1);
    // nothing left to add: no undo handle
    expect(await client.call("categorize.apply", { categoryId: cat, scope: { kind: "sender", email: "nobody@nowhere.io" } })).toEqual({ batchId: null, added: 0 });
  });

  it("quick actions come from the filed threads; topic queries count what is left", async () => {
    const { backend, client, acct, cat } = await mailbox();
    ingestMessages(backend.db, Array.from({ length: 8 }, (_, i) => incoming(acct, { from: { name: "Hacker Newsletter", email: "kale@hackernewsletter.com" }, listId: "hackernewsletter.com", subject: `#${i} SQLite internals and CRDTs`, bodyText: "This week: SQLite internals, CRDTs, local-first. Unsubscribe", date: NOW - (i + 1) * 86_400_000 })), NOW);
    backend.categorizer.rebuildSync();
    const t = backend.db.get<{ id: number }>("SELECT id FROM threads LIMIT 1")!.id;
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [t] });
    const qa = await client.call("categorize.quickActions", { categoryId: cat, threadIds: [t] });
    expect(qa).toMatchObject({ sender: { email: "kale@hackernewsletter.com" }, list: "hackernewsletter.com", domain: "hackernewsletter.com" });
    const count = await client.call("categorize.count", { categoryId: cat, scope: { kind: "query", query: '"sqlite" "crdts" -category:Lecturas' } });
    expect(count).toEqual({ count: 7, capped: false });
  });

  it("predicts with reasons, lists and answers suggestions, and reports per-category stats", async () => {
    const { backend, client, acct, cat } = await mailbox();
    const news = Array.from({ length: 12 }, (_, i) => incoming(acct, { from: { name: "Morning Brew", email: "crew@morningbrew.com" }, listId: "daily.morningbrew.com", subject: `Your brief ${i}`, bodyText: "Markets and streaming wars. Unsubscribe", date: NOW - (40 + i) * 86_400_000, inInbox: false }));
    const friends = Array.from({ length: 80 }, (_, i) => incoming(acct, { from: { name: `Amigo ${i % 10}`, email: `amigo${i % 10}@gmail.com` }, subject: "¿Comida?", bodyText: "Hola, ¿comemos el sábado?", date: NOW - (20 + i) * 86_400_000, inInbox: false }));
    ingestMessages(backend.db, [...news, ...friends], NOW);
    const filed = backend.db.all<{ thread_id: number }>("SELECT DISTINCT thread_id FROM messages WHERE from_email = 'crew@morningbrew.com'").map((r) => r.thread_id);
    await client.call("categories.addThreads", { categoryId: cat, threadIds: filed });
    backend.categorizer.rebuildSync();
    await backend.ingestSliced([incoming(acct, { from: { name: "Morning Brew", email: "crew@morningbrew.com" }, listId: "daily.morningbrew.com", subject: "Your brief", bodyText: "Markets. Unsubscribe", date: NOW - 3_600_000, providerMsgId: "new-brief" })]);
    const fresh = backend.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = 'new-brief'")!.thread_id;
    const [best] = await client.call("categorize.predict", { threadId: fresh });
    expect(best).toMatchObject({ categoryId: cat, decision: "auto" });
    expect(best!.reasons[0]).toMatch(/^mismo remitente que/);
    const detail = await client.call("threads.get", { threadId: fresh });
    expect(detail.categorization?.auto).toEqual([{ categoryId: cat, reasons: expect.arrayContaining([expect.stringMatching(/^mismo remitente/)]) }]);

    // a suggestion waiting for an answer
    const friend = backend.db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE from_email = 'amigo1@gmail.com' LIMIT 1")!.thread_id;
    backend.db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.85, '[\"menciona «brief»\"]', ?)", friend, cat, NOW);
    expect((await client.call("counts.get", {})).categorySuggestions).toEqual({ [cat]: 1 });
    const { items } = await client.call("categorize.suggestions", { categoryId: cat });
    expect(items.map((x) => [x.id, x.prediction.reasons])).toEqual([[friend, ["menciona «brief»"]]]);
    expect((await client.call("threads.get", { threadId: friend })).categorization?.suggestions).toEqual([{ categoryId: cat, p: 0.85, reasons: ["menciona «brief»"] }]);
    await client.call("categorize.feedback", { threadId: friend, categoryId: cat, verdict: "reject" });
    expect(backend.db.get("SELECT label, weight, source FROM cls_examples WHERE thread_id = ?", friend)).toEqual({ label: -1, weight: 1, source: "reject" });
    expect((await client.call("counts.get", {})).categorySuggestions).toEqual({});

    const stats = await client.call("categorize.stats", {});
    expect(stats).toEqual([{ categoryId: cat, examples: 12, autoApply: true, kept: 0, reverted: 0, autoPrecision: null, paused: false, pendingSuggestions: 0 }]);
    await client.call("categories.update", { id: cat, autoApply: false });
    expect((await client.call("categorize.stats", {}))[0]!.autoApply).toBe(false);
  });
});

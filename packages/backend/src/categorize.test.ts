import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import dc from "node:diagnostics_channel";
import { encodeFeatures, extractFeatures } from "@terno/core";
import { createAi, type ModelTransport } from "@terno/ai";
import { addToCategory, createAccount, createCategory, ingestMessages, putSecret, seedDataset, setSetting, type IncomingMessage, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher, type BackendOptions } from "./backend";

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function open(dir: string, now: () => number = () => NOW, options: Pick<BackendOptions, "aiFactory" | "log"> = {}) {
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now, autoSync: false, ...options });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  return { backend, client: new RpcClient(c) };
}

function setup(options: { seed?: boolean } & Pick<BackendOptions, "aiFactory" | "log"> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-cat-"));
  const { backend, client } = open(dir, () => NOW, options);
  let stopped = false;
  cleanups.push(async () => {
    if (!stopped) await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  if (options.seed) seedDataset(sqlDb(backend.store), generateDataset({ threads: 600, accounts: 2, seed: 9, now: NOW }), { now: NOW });
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
    const acct = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(sqlDb(backend.store), "Facturas", "amber").id;
    const r = ingestMessages(sqlDb(backend.store), [incoming(acct), incoming(acct), incoming(acct)]);
    const threads = [...r.touchedThreads];
    await backend.categorizer.rebuildNow();
    const model = backend.categorizer.model!;

    const res = await client.call("categories.addThreads", { categoryId: cat, threadIds: threads.slice(0, 2) });
    expect(res).toEqual({ added: 2, addedIds: threads.slice(0, 2), batchId: expect.any(Number) });
    expect(model.positives(cat)).toBe(2);

    // a store command that rolls back hands back no deltas: RAM stays untouched
    await expect(
      backend.store.categories.add({ categoryId: 987_654, threadIds: [threads[2]!], addedBy: "user", now: NOW }).then((out) => backend.categorizer.apply(out.deltas)),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect(model.positives(cat)).toBe(2);
    expect(sqlDb(backend.store).get("SELECT 1 FROM cls_examples WHERE thread_id = ?", threads[2]!)).toBeUndefined();

    // removal: positive untrained, strong negative trained
    await client.call("categories.removeThreads", { categoryId: cat, threadIds: [threads[0]!] });
    expect(model.positives(cat)).toBe(1);
    expect(sqlDb(backend.store).get("SELECT label, weight FROM cls_examples WHERE thread_id = ?", threads[0]!)).toEqual({ label: -1, weight: 3 });
  });

  it("snackbar adds are bulk (half weight) and the whole batch undoes exactly", async () => {
    const { backend, client } = setup();
    const acct = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(sqlDb(backend.store), "Facturas", "amber").id;
    const threads = [...ingestMessages(sqlDb(backend.store), [incoming(acct), incoming(acct), incoming(acct)]).touchedThreads];
    await backend.categorizer.rebuildNow();
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [threads[0]!] });
    const bulk = await client.call("categories.addThreads", { categoryId: cat, threadIds: threads, source: "snackbar" });
    expect(bulk.addedIds).toEqual(threads.slice(1));
    expect(sqlDb(backend.store).all<{ source: string; weight: number }>("SELECT source, weight FROM cls_examples ORDER BY thread_id").map((r) => [r.source, r.weight])).toEqual([["user", 1], ["bulk", 0.5], ["bulk", 0.5]]);
    expect(await client.call("categorize.undo", { batchId: bulk.batchId! })).toEqual({ removed: 2 });
    expect(backend.categorizer.model!.positives(cat)).toBe(1);
    expect(sqlDb(backend.store).all<{ thread_id: number }>("SELECT thread_id FROM thread_categories").map((r) => r.thread_id)).toEqual([threads[0]]);
    // undoing the picker add (reason "undo") forgets it without a negative
    await client.call("categories.removeThreads", { categoryId: cat, threadIds: [threads[0]!], reason: "undo" });
    expect(backend.categorizer.model!.positives(cat)).toBe(0);
    expect(sqlDb(backend.store).get("SELECT 1 FROM cls_examples")).toBeUndefined();
  });

  it("removing or undoing returns old uncategorized threads to the background", async () => {
    const { backend, client } = setup();
    const acct = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(sqlDb(backend.store), "Facturas", "amber").id;
    const threads = [...ingestMessages(sqlDb(backend.store), Array.from({ length: 6 }, (_, i) => incoming(acct, { date: NOW - (10 + i) * DAY })), NOW).touchedThreads];
    await backend.categorizer.rebuildNow();
    const model = backend.categorizer.model!;
    expect(model.backgroundSize).toBe(6);
    const bulk = await client.call("categories.addThreads", { categoryId: cat, threadIds: threads.slice(0, 4), source: "snackbar" });
    await client.call("categories.addThreads", { categoryId: cat, threadIds: threads.slice(4) });
    expect(model.backgroundSize).toBe(0);
    await client.call("categorize.undo", { batchId: bulk.batchId! });
    expect(model.backgroundSize).toBe(4);
    await client.call("categories.removeThreads", { categoryId: cat, threadIds: threads.slice(4) });
    expect(model.backgroundSize).toBe(6);
    // RAM matches what a rebuild would compute
    const fresh = await backend.categorizer.rebuildNow();
    expect(fresh.backgroundSize).toBe(6);
  });

  it("an add that changes nothing returns no undo handle", async () => {
    const { backend, client } = setup();
    const acct = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(sqlDb(backend.store), "Facturas", "amber").id;
    const [t] = [...ingestMessages(sqlDb(backend.store), [incoming(acct)]).touchedThreads];
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [t!] });
    expect(await client.call("categories.addThreads", { categoryId: cat, threadIds: [t!] })).toEqual({ added: 0, addedIds: [], batchId: null });
    await expect(client.call("categories.addThreads", { categoryId: 999, threadIds: [t!] })).rejects.toThrow(/no longer exists/);
  });

  it("a thread merge reconciles the model after commit (the losing example is untrained)", async () => {
    const { backend, client } = setup();
    const acct = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(sqlDb(backend.store), "Clientes", "emerald").id;
    const a = incoming(acct, { rfcMessageId: "ra@x" });
    const c = incoming(acct, { rfcMessageId: "rc@x", references: ["rb@x"] });
    ingestMessages(sqlDb(backend.store), [a, c], NOW);
    const t = (m: IncomingMessage) => sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", m.providerMsgId)!.thread_id;
    const [ta, tc] = [t(a), t(c)];
    await backend.categorizer.rebuildNow();
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [tc] });
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [ta] });
    await client.call("categories.removeThreads", { categoryId: cat, threadIds: [ta] });
    expect(backend.categorizer.model!.positives(cat)).toBe(1);
    await backend.ingestSliced([incoming(acct, { rfcMessageId: "rb@x", references: ["ra@x"] })]);
    expect(backend.categorizer.model!.positives(cat)).toBe(0);
    expect(sqlDb(backend.store).get("SELECT 1 FROM thread_categories")).toBeUndefined();
  });

  it("a seeded mailbox starts warm: the rebuild trains every user-filed thread", async () => {
    const { backend } = setup({ seed: true });
    expect(backend.categorizer.ready).toBe(false);
    await backend.start();
    await backend.categorizer.rebuild();
    const model = backend.categorizer.model!;
    for (const { id } of sqlDb(backend.store).all<{ id: number }>("SELECT id FROM categories")) {
      const filed = sqlDb(backend.store).get<{ c: number }>("SELECT count(*) AS c FROM cls_examples WHERE category_id = ? AND label = 1 AND weight > 0", id)!.c;
      expect(filed).toBeGreaterThan(0);
      expect(model.positives(id)).toBe(filed);
    }
    expect(model.backgroundSize).toBeGreaterThan(50);
  });

  it("persists a snapshot on stop and adopts it on the next start; a stale one is rebuilt", async () => {
    const { backend, dir, stop } = setup({ seed: true });
    await backend.categorizer.rebuildNow();
    const probe = sqlDb(backend.store).all<{ features: Uint8Array }>("SELECT features FROM cls_examples LIMIT 5");
    const { featuresFromBlob } = await import("@terno/core");
    const scores = probe.map((p) => backend.categorizer.model!.score(featuresFromBlob(p.features)));
    await stop();

    const again = open(dir);
    await again.backend.ready;
    expect(again.backend.categorizer.ready).toBe(true);
    expect(probe.map((p) => again.backend.categorizer.model!.score(featuresFromBlob(p.features)))).toEqual(scores);
    // an example written behind the model's back (a crash before the snapshot) makes it stale
    sqlDb(again.backend.store).run("UPDATE cls_examples SET weight = 0.5 WHERE thread_id = (SELECT min(thread_id) FROM cls_examples)");
    await again.backend.stop();
    const third = open(dir);
    await third.backend.ready;
    expect(third.backend.categorizer.ready).toBe(false);
    await third.backend.stop();
  });

  it("a paged rebuild counts each write once, whether the scan had read that row or not", async () => {
    const { backend, client } = setup({ seed: true });
    const cat = (await client.call("categories.create", { name: "Muchos", color: "rose" })).id;
    const ids = sqlDb(backend.store).all<{ id: number }>("SELECT id FROM threads ORDER BY id").map((r) => r.id);
    addToCategory(sqlDb(backend.store), { categoryId: cat, threadIds: ids.slice(0, 500), addedBy: "user", now: NOW });
    await backend.categorizer.rebuildNow();
    const rebuilding = backend.categorizer.rebuild();
    // one row the first slice has read (lowest key) and one it can't have reached (highest key), plus a new one
    await client.call("categories.removeThreads", { categoryId: cat, threadIds: [ids[0]!, ids[499]!] });
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [ids[550]!] });
    await rebuilding;
    const live = backend.categorizer.model!;
    const probe = sqlDb(backend.store).all<{ features: Uint8Array }>("SELECT features FROM cls_examples LIMIT 3");
    const { featuresFromBlob } = await import("@terno/core");
    const fresh = await backend.categorizer.rebuildNow();
    for (const c of fresh.categoryIds) expect(live.positives(c), `category ${c}`).toBe(fresh.positives(c));
    for (const p of probe) {
      const a = live.score(featuresFromBlob(p.features));
      const b = fresh.score(featuresFromBlob(p.features));
      a.forEach((x, i) => expect(x.p).toBeCloseTo(b[i]!.p, 9));
    }
  });

  it("writes committed during a sliced rebuild are replayed onto the new model", async () => {
    const { backend, client } = setup({ seed: true });
    const cat = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
    await backend.categorizer.rebuildNow();
    const target = sqlDb(backend.store).get<{ id: number }>(
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
  async function trained(options: { examplesAt?: number } & Pick<BackendOptions, "aiFactory" | "log"> = {}) {
    const { backend, client } = setup(options);
    const acct = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(sqlDb(backend.store), "Facturas", "amber").id;
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
    const r = ingestMessages(sqlDb(backend.store), old, NOW);
    const filed = sqlDb(backend.store)
      .all<{ thread_id: number }>(
        "SELECT DISTINCT thread_id FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND from_email IN (SELECT value FROM json_each(?))",
        JSON.stringify(r.inserted),
        JSON.stringify(SENDERS.map((x) => x.email)),
      )
      .map((x) => x.thread_id);
    addToCategory(sqlDb(backend.store), { categoryId: cat, threadIds: filed, addedBy: "user", now: options.examplesAt ?? NOW - 120 * DAY });
    await backend.categorizer.rebuildNow();
    const arrive = async (over: Partial<IncomingMessage>) => {
      const m = incoming(acct, { date: NOW - 3_600_000, ...over });
      await backend.ingestSliced([m]);
      return { thread: sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", m.providerMsgId)!.thread_id, message: m };
    };
    const decision = (thread: number) => sqlDb(backend.store).get<{ kind: string; outcome: string | null; explain_json: string }>("SELECT kind, outcome, explain_json FROM cls_decisions WHERE thread_id = ? AND category_id = ?", thread, cat);
    const inCategory = (thread: number) => sqlDb(backend.store).get<{ added_by: string }>("SELECT added_by FROM thread_categories WHERE thread_id = ? AND category_id = ?", thread, cat)?.added_by ?? null;
    return { backend, client, acct, cat, arrive, decision, inCategory };
  }

  it("files new inbox mail from a filed sender, explains why, and never trains on it", async () => {
    const { backend, cat, arrive, decision, inCategory } = await trained();
    const positives = backend.categorizer.model!.positives(cat);
    const { thread } = await arrive(receipt(SENDERS[0]!, 99));
    expect(inCategory(thread)).toBe("auto");
    const d = decision(thread)!;
    expect(d.kind).toBe("auto");
    expect(JSON.parse(d.explain_json)[0]).toEqual({ k: "reason.sameSender", p: { count: expect.any(Number), category: "Facturas" } });
    // auto adds never train the model (no feedback loop)
    expect(backend.categorizer.model!.positives(cat)).toBe(positives);
    expect(sqlDb(backend.store).get("SELECT 1 FROM cls_examples WHERE thread_id = ?", thread)).toBeUndefined();
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
    expect(sqlDb(backend.store).get("SELECT label FROM cls_examples WHERE thread_id = ?", thread)).toEqual({ label: -1 });
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
    const threads = sqlDb(backend.store).all<{ thread_id: number }>("SELECT thread_id FROM cls_examples LIMIT 12").map((r) => r.thread_id);
    threads.forEach((t, i) =>
      sqlDb(backend.store).run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at, outcome) VALUES (?, ?, 'auto', 0.99, '[]', ?, ?)", t, cat, NOW - 40 * DAY, i < 4 ? "reverted" : "kept"),
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
    expect(sqlDb(backend.store).get("SELECT 1 FROM cls_examples WHERE thread_id = ?", thread)).toBeUndefined();
  });

  it("reclassifies once when the body arrives; an unknown sender gets in on content alone", async () => {
    const { backend, arrive, decision, inCategory } = await trained({ examplesAt: NOW - 30 * DAY });
    const { thread, message } = await arrive({ from: { name: "Netflix", email: "info@account.netflix.com" }, subject: "Aviso de tu cuenta", bodyText: null, bodyState: "none" });
    expect(decision(thread)).toBeUndefined();
    await backend.ingestSliced([{ ...message, bodyState: "full", bodyText: "Tu recibo de Netflix. Gracias por tu pago. Total: $199.00 MXN. Factura 77 disponible." }]);
    expect(inCategory(thread)).toBe("auto");
    expect(JSON.parse(decision(thread)!.explain_json)[0]).toEqual({ k: "reason.newSender" });
  });

  /**
   * A sender the user filed only sometimes: unfiled history is added until a
   * neutral new message from it lands in the uncertain band (0.5 ≤ p < 0.8).
   */
  async function uncertainMail(backend: Backend, acct: number, cat: number, name = "Facturas Servicio"): Promise<Partial<IncomingMessage>> {
    // the offline fake AI picks a label it finds in the text: the display name carries it
    const from = { name, email: "avisos@nuevo-servicio.mx" };
    const filed = [...ingestMessages(sqlDb(backend.store), Array.from({ length: 4 }, (_, i) => incoming(acct, { from, subject: `Aviso ${i}`, bodyText: "Aviso de servicio.", date: NOW - (50 + i) * DAY, inInbox: false })), NOW).touchedThreads];
    addToCategory(sqlDb(backend.store), { categoryId: cat, threadIds: filed, addedBy: "user", now: NOW - 40 * DAY });
    const draft = { from, subject: "Aviso", bodyText: "Aviso de servicio." };
    const features = encodeFeatures(extractFeatures({ fromEmail: from.email, fromName: from.name, listId: null, subject: "Aviso", bodyText: draft.bodyText, replied: false, attachmentNames: [] }, { ownDomains: new Set(["example.com"]) }));
    const seen: string[] = [];
    for (let unfiled = 0; unfiled < 80; unfiled++) {
      await backend.categorizer.rebuildNow();
      const s = backend.categorizer.model!.score(features).find((x) => x.categoryId === cat)!;
      seen.push(s.p.toFixed(2));
      if (s.p >= 0.5 && s.p < 0.8) return draft;
      ingestMessages(sqlDb(backend.store), [incoming(acct, { from, subject: `Aviso viejo ${unfiled}`, bodyText: "Aviso de servicio.", date: NOW - (20 + unfiled) * DAY, inInbox: false })], NOW);
    }
    throw new Error(`no uncertain draft: ${seen.join(" ")}`);
  }

  async function assistMail(count: number, options: Pick<BackendOptions, "aiFactory" | "log"> = {}) {
    const t = await trained(options);
    const draft = await uncertainMail(t.backend, t.acct, t.cat);
    const threads = [...ingestMessages(sqlDb(t.backend.store), Array.from({ length: count }, () => incoming(t.acct, draft)), NOW).touchedThreads];
    return { ...t, threads };
  }

  function classification(req: Parameters<ModelTransport["complete"]>[0]) {
    const items = JSON.parse(req.messages[0]!.content.split("\nItems: ")[1]!) as { id: string }[];
    return { stop: "end" as const, text: JSON.stringify({ results: items.map(({ id }) => ({ id, label: "Facturas", confidence: 0.95 })) }) };
  }

  it.each(["none", "missing-key", "local-mode", "factory-error", "factory-value"] as const)("releases current and queued admission after %s preparation refusal, only on explicit enqueue", async (mode) => {
    let refuse = mode === "factory-error" || mode === "factory-value";
    let calls = 0;
    const sentinel = "synthetic-private-config-model-key-detail";
    const logs: unknown[] = [];
    const t = await assistMail(2, {
      log: (...args) => logs.push(args),
      aiFactory: (config) => {
        if (refuse) throw mode === "factory-value" ? { detail: sentinel } : new Error(sentinel);
        return createAi(config, { transport: { async complete(req) { calls++; return classification(req); } } });
      },
    });
    const { backend, threads } = t;
    const ai = mode === "local-mode" || mode === "missing-key" ? { provider: "openai", model: sentinel } : { provider: mode === "none" ? "none" : "fake", model: sentinel };
    setSetting(sqlDb(backend.store), "app", { aiCategorize: true, localMode: mode !== "missing-key", ai });
    await backend.aiAssist.enqueue(threads);
    await backend.aiAssist.drain();
    expect(calls).toBe(0);
    expect(backend.aiAssist.pending).toBe(0);
    expect.soft(JSON.stringify(logs)).not.toContain(sentinel);
    for (const id of threads) expect(t.decision(id)).toBeUndefined();
    refuse = false;
    setSetting(sqlDb(backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    await backend.aiAssist.drain();
    expect(calls).toBe(0); // fixing settings alone never retries
    await backend.aiAssist.enqueue(threads);
    await backend.aiAssist.drain();
    expect(calls).toBe(2);
    for (const id of threads) {
      expect(t.decision(id)?.kind).toBe("suggest");
      expect(t.inCategory(id)).toBeNull();
    }
  });

  it.each(["assist", "auto"] as const)("releases a queue discarded while %s is disabled for later explicit enqueue", async (setting) => {
    let calls = 0;
    const t = await assistMail(2, { aiFactory: (config) => createAi(config, { transport: { async complete(req) { calls++; return classification(req); } } }) });
    const settings = (enabled: boolean) => setSetting(sqlDb(t.backend.store), "app", { aiCategorize: setting === "assist" ? enabled : true, autoCategorize: setting === "auto" && !enabled ? "off" : "auto", ai: { provider: "fake" } });
    settings(true);
    await t.backend.aiAssist.enqueue(t.threads);
    settings(false);
    await t.backend.aiAssist.drain();
    expect(calls).toBe(0);
    expect(t.backend.aiAssist.pending).toBe(0);
    settings(true);
    await t.backend.aiAssist.drain();
    expect(calls).toBe(0);
    await t.backend.aiAssist.enqueue(t.threads);
    await t.backend.aiAssist.drain();
    expect(calls).toBe(2);
    for (const id of t.threads) expect(t.decision(id)?.kind).toBe("suggest");
  });

  it("does not charge refused preparation against the 20 actual task attempts", async () => {
    let refuse = true;
    let calls = 0;
    const t = await assistMail(25, { aiFactory: (config) => {
      if (refuse) throw new Error("synthetic-refusal");
      return createAi(config, { transport: { async complete(req) { calls++; return classification(req); } } });
    } });
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    await t.backend.aiAssist.enqueue([t.threads[0]!]);
    await t.backend.aiAssist.drain();
    refuse = false;
    await t.backend.aiAssist.enqueue(t.threads.slice(1));
    await t.backend.aiAssist.drain();
    expect(calls).toBe(20);
    expect(t.backend.aiAssist.pending).toBe(4);
    expect(t.threads.filter((id) => t.decision(id)?.kind === "suggest")).toHaveLength(20);
  });

  it.each(["disable", "auto-off", "shutdown"] as const)("does not start tasks after %s during actual preparation", async (interrupt) => {
    let calls = 0;
    const t = await assistMail(2, { aiFactory: (config) => createAi(config, { transport: { async complete(req) { calls++; return classification(req); } } }) });
    const prepared = gate(); const answer = gate();
    const real = t.backend.ai.bind(t.backend);
    t.backend.ai = async () => { const ai = await real(); prepared.release(); await answer.promise; return ai; };
    const settings = (enabled: boolean) => setSetting(sqlDb(t.backend.store), "app", { aiCategorize: enabled, ai: { provider: "fake" } });
    settings(true);
    await t.backend.aiAssist.enqueue(t.threads);
    const running = t.backend.aiAssist.drain();
    await prepared.promise;
    await t.backend.aiAssist.enqueue(t.threads); // in-flight/queued duplicates
    if (interrupt === "disable") settings(false);
    else if (interrupt === "auto-off") setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, autoCategorize: "off", ai: { provider: "fake" } });
    else t.backend.aiAssist.stop();
    answer.release();
    await running;
    expect.soft(calls).toBe(0);
    for (const id of t.threads) expect(t.decision(id)).toBeUndefined();
    settings(true);
    await t.backend.aiAssist.enqueue(t.threads);
    await t.backend.aiAssist.drain();
    expect(calls).toBe(interrupt !== "shutdown" ? 2 : 0);
  });

  it("does not admit an enqueue whose settings read finishes after shutdown", async () => {
    let calls = 0;
    const t = await assistMail(1, { aiFactory: (config) => createAi(config, { transport: { async complete(req) { calls++; return classification(req); } } }) });
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    const started = gate(); const read = gate();
    const get = t.backend.store.settings.get.bind(t.backend.store.settings);
    const spy = vi.spyOn(t.backend.store.settings, "get").mockImplementation(async (key, fallback) => {
      const value = await get(key, fallback);
      if (key === "app") { started.release(); await read.promise; }
      return value;
    });
    const enqueue = t.backend.aiAssist.enqueue(t.threads);
    await started.promise;
    t.backend.aiAssist.stop();
    read.release();
    await enqueue;
    spy.mockRestore();
    await t.backend.aiAssist.drain();
    expect(calls).toBe(0);
    expect(t.backend.aiAssist.pending).toBe(0);
  });

  it("retains completed non-decisions when later queued preparation is refused", async () => {
    let calls = 0;
    const t = await assistMail(3, { aiFactory: (config) => createAi(config, { transport: { async complete(req) {
      calls++;
      const result = classification(req);
      const parsed = JSON.parse(result.text);
      parsed.results[0].label = null;
      return { ...result, text: JSON.stringify(parsed) };
    } } }) });
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    await t.backend.aiAssist.enqueue([t.threads[0]!]);
    await t.backend.aiAssist.drain();
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "none" } });
    await t.backend.aiAssist.enqueue(t.threads.slice(1));
    await t.backend.aiAssist.drain();
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    await t.backend.aiAssist.enqueue(t.threads);
    await t.backend.aiAssist.drain();
    expect(calls).toBe(3); // completed null is retained; only the two discarded IDs run
    await t.backend.aiAssist.enqueue(t.threads);
    await t.backend.aiAssist.drain();
    expect(calls).toBe(3);
    for (const id of t.threads) expect(t.decision(id)).toBeUndefined();
  });

  it.each(["disable", "shutdown"] as const)("does not issue structured repairs after %s during model work", async (interrupt) => {
    let calls = 0;
    const started = gate(); const answer = gate();
    const t = await assistMail(1, { aiFactory: (config) => createAi({ ...config, capabilities: { output: "json_schema", contextTokens: null, embeddings: false, probedAt: null } }, { transport: { async complete() {
      calls++;
      started.release();
      await answer.promise;
      return { stop: "end", text: "{}" };
    } } }) });
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    await t.backend.aiAssist.enqueue(t.threads);
    const running = t.backend.aiAssist.drain();
    await started.promise;
    if (interrupt === "disable") setSetting(sqlDb(t.backend.store), "app", { aiCategorize: false, ai: { provider: "fake" } });
    else t.backend.aiAssist.stop();
    answer.release();
    await running;
    expect(calls).toBe(1);
    expect(t.decision(t.threads[0]!)).toBeUndefined();
  });

  it("timestamps actual task starts after slow preparation and expires at exactly one minute", async () => {
    let calls = 0;
    const prepared = gate(); const answer = gate();
    const t = await assistMail(21, { aiFactory: (config) => createAi(config, { transport: { async complete(req) { calls++; return classification(req); } } }) });
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    const real = t.backend.ai.bind(t.backend);
    let first = true;
    t.backend.ai = async () => {
      const ai = await real();
      if (first) { first = false; prepared.release(); await answer.promise; }
      return ai;
    };
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      vi.setSystemTime(NOW);
      await t.backend.aiAssist.enqueue(t.threads);
      const running = t.backend.aiAssist.drain();
      await prepared.promise;
      vi.setSystemTime(NOW + 60_000);
      answer.release();
      await running;
      expect(calls).toBe(20);
      expect(t.backend.aiAssist.pending).toBe(1);
      vi.setSystemTime(NOW + 119_999);
      await t.backend.aiAssist.drain();
      expect(calls).toBe(20);
      vi.setSystemTime(NOW + 120_000);
      await t.backend.aiAssist.drain();
      expect(calls).toBe(21);
      expect(t.backend.aiAssist.pending).toBe(0);
    } finally { t.backend.aiAssist.stop(); vi.useRealTimers(); }
  });

  it("does not restore rate-wait admission after shutdown during category context", async () => {
    let calls = 0;
    const t = await assistMail(21, { aiFactory: (config) => createAi(config, { transport: { async complete(req) { calls++; return classification(req); } } }) });
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    await t.backend.aiAssist.enqueue(t.threads.slice(0, 20));
    await t.backend.aiAssist.drain();
    const started = gate(); const read = gate();
    const list = t.backend.store.categories.list.bind(t.backend.store.categories);
    t.backend.store.categories.list = async () => { const categories = await list(); started.release(); await read.promise; return categories; };
    await t.backend.aiAssist.enqueue(t.threads.slice(20));
    const running = t.backend.aiAssist.drain();
    await started.promise;
    t.backend.aiAssist.stop();
    read.release();
    await running;
    expect(calls).toBe(20);
    expect(t.backend.aiAssist.pending).toBe(0);
  });

  it("does not persist when shutdown occurs during the final settings read", async () => {
    let armed = false;
    const started = gate(); const read = gate();
    const t = await assistMail(1, { aiFactory: (config) => createAi(config, { transport: { async complete(req) { armed = true; return classification(req); } } }) });
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    const get = t.backend.store.settings.get.bind(t.backend.store.settings);
    const spy = vi.spyOn(t.backend.store.settings, "get").mockImplementation(async (key, fallback) => {
      const value = await get(key, fallback);
      if (key === "app" && armed) { started.release(); await read.promise; }
      return value;
    });
    const record = vi.spyOn(t.backend.store.categorize, "recordAiSuggestion");
    await t.backend.aiAssist.enqueue(t.threads);
    const running = t.backend.aiAssist.drain();
    await started.promise;
    t.backend.aiAssist.stop();
    read.release();
    await running;
    spy.mockRestore();
    expect(record).not.toHaveBeenCalled();
    expect(t.decision(t.threads[0]!)).toBeUndefined();
  });

  it("deduplicates current work and cannot persist or restart after shutdown during a task", async () => {
    let calls = 0;
    const started = gate(); const answer = gate();
    const t = await assistMail(2, { aiFactory: (config) => createAi(config, { transport: { async complete(req) { calls++; started.release(); await answer.promise; return classification(req); } } }) });
    setSetting(sqlDb(t.backend.store), "app", { aiCategorize: true, ai: { provider: "fake" } });
    await t.backend.aiAssist.enqueue(t.threads);
    const running = t.backend.aiAssist.drain();
    await started.promise;
    await t.backend.aiAssist.enqueue(t.threads);
    expect(t.backend.aiAssist.pending).toBe(1);
    t.backend.aiAssist.stop();
    answer.release();
    await running;
    for (const id of t.threads) expect.soft(t.decision(id)).toBeUndefined();
    await t.backend.aiAssist.enqueue(t.threads);
    await t.backend.aiAssist.drain();
    expect(calls).toBe(1);
    expect(t.backend.aiAssist.pending).toBe(0);
  });

  it("the AI assist is off by default: uncertain mail stays undecided and no AI is asked", async () => {
    const { backend, acct, cat, arrive, decision } = await trained();
    let asked = 0;
    const real = backend.ai.bind(backend);
    backend.ai = async () => (asked++, real());
    const { thread } = await arrive(await uncertainMail(backend, acct, cat));
    await backend.aiAssist.drain();
    expect(asked).toBe(0);
    expect(decision(thread)).toBeUndefined();
  });

  it("with the assist on, the AI can turn 'nothing' into a suggestion, never an auto add", async () => {
    const { backend, acct, cat, arrive, decision, inCategory } = await trained();
    setSetting(sqlDb(backend.store), "app", { ai: { provider: "fake" }, aiCategorize: true });
    const { thread } = await arrive(await uncertainMail(backend, acct, cat));
    await backend.aiAssist.drain();
    expect(decision(thread)?.kind).toBe("suggest");
    expect(JSON.parse(decision(thread)!.explain_json)[0]).toEqual({ k: "reason.aiLocal", p: { category: "Facturas" } });
    expect(inCategory(thread)).toBeNull();
  });

  it.each(["label", "id", "duplicate-null", "duplicate-low", "duplicate-claim", "duplicate-identical"] as const)("releases a failed classification %s for a later enqueue after exhausting repairs", async (invalid) => {
    const sentinel = "synthetic-private-model-id";
    let valid = false;
    let calls = 0;
    const logs: unknown[] = [];
    const transport: ModelTransport = {
      async complete(req) {
        calls++;
        const input = JSON.parse(req.messages[0]!.content.split("\nItems: ")[1]!) as { id: string }[];
        const results: { id: string; label: string | null; confidence: number }[] = [{ id: !valid && invalid === "id" ? sentinel : input[0]!.id, label: !valid && invalid === "label" ? sentinel : "Facturas", confidence: 0.95 }];
        if (!valid && invalid.startsWith("duplicate-")) {
          if (invalid === "duplicate-claim") results[0]!.label = null;
          results.push({ id: input[0]!.id, label: invalid === "duplicate-null" ? null : "Facturas", confidence: invalid === "duplicate-low" ? 0.2 : 0.95 });
        }
        return { stop: "end", text: JSON.stringify({ results }) };
      },
    };
    const { backend, acct, cat, arrive, decision, inCategory } = await trained({
      aiFactory: (config) => createAi({ ...config, capabilities: { output: "json_schema", contextTokens: null, embeddings: false, probedAt: null } }, { transport }),
      log: (...args) => logs.push(args),
    });
    const draft = await uncertainMail(backend, acct, cat);
    setSetting(sqlDb(backend.store), "app", { ai: { provider: "fake" }, aiCategorize: true });
    const { thread } = await arrive(draft);
    await backend.aiAssist.drain();
    expect.soft(calls).toBe(2); // initial response and the failed repair
    expect.soft(decision(thread)).toBeUndefined();
    expect(inCategory(thread)).toBeNull();
    expect.soft(await backend.store.categorize.aiCandidate(thread)).toBe(true);
    expect(backend.aiAssist.pending).toBe(0);
    expect.soft(JSON.stringify(logs)).not.toContain(sentinel);
    valid = true;
    await backend.aiAssist.enqueue([thread]);
    await backend.aiAssist.drain();
    expect(calls).toBe(3);
    expect(decision(thread)?.kind).toBe("suggest");
    expect(inCategory(thread)).toBeNull();
    expect(sqlDb(backend.store).get("SELECT count(*) AS n FROM cls_decisions WHERE thread_id = ?", thread)).toEqual({ n: 1 });
  });

  it.each([{ label: null, confidence: 0.95 }, { label: "Facturas", confidence: 0.2 }])("keeps a valid non-decision $label/$confidence once per thread", async (result) => {
    let calls = 0;
    const transport: ModelTransport = {
      async complete(req) {
        calls++;
        const input = JSON.parse(req.messages[0]!.content.split("\nItems: ")[1]!) as { id: string }[];
        return { stop: "end", text: JSON.stringify({ results: [{ id: input[0]!.id, ...result }] }) };
      },
    };
    const { backend, acct, cat, arrive, decision, inCategory } = await trained({ aiFactory: (config) => createAi(config, { transport }) });
    const draft = await uncertainMail(backend, acct, cat);
    setSetting(sqlDb(backend.store), "app", { ai: { provider: "fake" }, aiCategorize: true });
    const { thread } = await arrive(draft);
    await backend.aiAssist.drain();
    await backend.aiAssist.enqueue([thread]);
    await backend.aiAssist.drain();
    expect(calls).toBe(1);
    expect(decision(thread)).toBeUndefined();
    expect(inCategory(thread)).toBeNull();
  });

  it("in local mode a cloud provider is paused: the assist makes no connection and no decision", async () => {
    const { backend, acct, cat, arrive, decision } = await trained();
    const connects: string[] = [];
    const onSocket = () => connects.push("net:socket");
    const onUndici = () => connects.push("undici");
    dc.subscribe("net.client.socket", onSocket);
    dc.subscribe("undici:client:beforeConnect", onUndici);
    try {
      putSecret(sqlDb(backend.store), "ai:anthropic:apiKey", await plaintextCipher.encrypt("sk-test-key-123456"));
      setSetting(sqlDb(backend.store), "app", { localMode: true, ai: { provider: "anthropic" }, aiCategorize: true });
      const { thread } = await arrive(await uncertainMail(backend, acct, cat));
      await backend.aiAssist.drain();
      expect(decision(thread)).toBeUndefined();
      expect(connects).toEqual([]);
    } finally {
      dc.unsubscribe("net.client.socket", onSocket);
      dc.unsubscribe("undici:client:beforeConnect", onUndici);
    }
  });

  it("the AI never suggests past a veto: look-alike senders aren't even asked", async () => {
    const { backend, acct, cat, arrive, decision } = await trained();
    // a trained bank's display name from another domain
    const draft = await uncertainMail(backend, acct, cat, "BBVA Facturas");
    setSetting(sqlDb(backend.store), "app", { ai: { provider: "fake" }, aiCategorize: true });
    let asked = 0;
    const real = backend.ai.bind(backend);
    backend.ai = async () => (asked++, real());
    const { thread } = await arrive(draft);
    await backend.aiAssist.drain();
    expect(asked).toBe(0);
    expect(decision(thread)).toBeUndefined();
  });

  it("re-checks before writing: a removal or switching the assist off while the AI thinks wins", async () => {
    const { backend, client, acct, cat, arrive, decision } = await trained();
    const draft = await uncertainMail(backend, acct, cat);
    setSetting(sqlDb(backend.store), "app", { ai: { provider: "fake" }, aiCategorize: true });
    for (const interrupt of ["removal", "switch-off"] as const) {
      let release!: () => void;
      const answered = new Promise<void>((r) => (release = r));
      backend.ai = async () =>
        ({
          providerId: "fake",
          local: true,
          classify: async (input: { items: { id: string }[] }) => {
            await answered;
            return input.items.map((i) => ({ id: i.id, label: "Facturas", confidence: 0.95 }));
          },
        }) as never;
      const { thread } = await arrive(draft);
      const running = backend.aiAssist.drain();
      await new Promise((r) => setTimeout(r, 5));
      if (interrupt === "removal") {
        await client.call("categories.addThreads", { categoryId: cat, threadIds: [thread] });
        await client.call("categories.removeThreads", { categoryId: cat, threadIds: [thread] });
      } else {
        setSetting(sqlDb(backend.store), "app", { ai: { provider: "fake" }, aiCategorize: false });
      }
      release();
      await running;
      expect(decision(thread), interrupt).toBeUndefined();
      setSetting(sqlDb(backend.store), "app", { ai: { provider: "fake" }, aiCategorize: true });
    }
  });

  it("asks the AI at most 20 times a minute, once per thread", async () => {
    const { backend, acct, cat, arrive } = await trained();
    const draft = await uncertainMail(backend, acct, cat);
    setSetting(sqlDb(backend.store), "app", { ai: { provider: "fake" }, aiCategorize: true });
    let asked = 0;
    const real = backend.ai.bind(backend);
    backend.ai = async () => (asked++, real());
    const threads: number[] = [];
    for (let i = 0; i < 25; i++) threads.push((await arrive(draft)).thread);
    await backend.aiAssist.enqueue(threads); // again: once per thread
    await backend.aiAssist.drain();
    expect(asked).toBe(20);
    expect(backend.aiAssist.pending).toBe(5);
    backend.aiAssist.stop();
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
    const acct = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const cat = createCategory(sqlDb(backend.store), "Lecturas", "violet").id;
    return { backend, client, acct, cat };
  }

  it("applies a list scope to every matching thread (not a 500-capped text search) and undoes the whole batch", async () => {
    const { backend, client, acct, cat } = await mailbox();
    const news = Array.from({ length: 640 }, (_, i) => incoming(acct, { from: { name: "Xataka", email: "boletin@xataka.com" }, listId: "boletin.xataka.com", subject: `Lo mejor de la semana ${i}`, bodyText: "Tecnología. Darse de baja", date: NOW - (i + 1) * 3_600_000 }));
    // mentions the list in its text: the old card's free-text search would have added it
    const decoy = incoming(acct, { from: { name: "Ana", email: "ana@gmail.com" }, subject: "boletin.xataka.com", bodyText: "¿viste boletin.xataka.com?" });
    ingestMessages(sqlDb(backend.store), [...news, decoy], NOW);
    await backend.categorizer.rebuildNow();
    const first = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", news[0]!.providerMsgId)!.thread_id;
    await client.call("categories.addThreads", { categoryId: cat, threadIds: [first] });

    expect(await client.call("categorize.count", { categoryId: cat, scope: { kind: "list", listId: "boletin.xataka.com" } })).toEqual({ count: 639, capped: false });
    const preview = await client.call("categorize.preview", { categoryId: cat, scope: { kind: "list", listId: "boletin.xataka.com" }, limit: 5 });
    expect(preview.sample).toHaveLength(5);
    const applied = await client.call("categorize.apply", { categoryId: cat, scope: { kind: "list", listId: "boletin.xataka.com" } });
    expect(applied).toEqual({ batchId: expect.any(Number), added: 639 });
    const decoyThread = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", decoy.providerMsgId)!.thread_id;
    expect(sqlDb(backend.store).get("SELECT 1 FROM thread_categories WHERE thread_id = ?", decoyThread)).toBeUndefined();
    // bulk adds weigh half and teach content for at most 50 threads of the sender
    expect(sqlDb(backend.store).get<{ n: number; content: number }>("SELECT count(*) AS n, sum(content) AS content FROM cls_examples WHERE source = 'bulk'")).toEqual({ n: 639, content: 50 });
    expect(backend.categorizer.model!.positives(cat)).toBe(640);

    expect(await client.call("categorize.undo", { batchId: applied.batchId! })).toEqual({ removed: 639 });
    expect(sqlDb(backend.store).get<{ n: number }>("SELECT count(*) AS n FROM thread_categories")!.n).toBe(1);
    expect(backend.categorizer.model!.positives(cat)).toBe(1);
    // nothing left to add: no undo handle
    expect(await client.call("categorize.apply", { categoryId: cat, scope: { kind: "sender", email: "nobody@nowhere.io" } })).toEqual({ batchId: null, added: 0 });
  });

  it("quick actions come from the filed threads; topic queries count what is left", async () => {
    const { backend, client, acct, cat } = await mailbox();
    ingestMessages(sqlDb(backend.store), Array.from({ length: 8 }, (_, i) => incoming(acct, { from: { name: "Hacker Newsletter", email: "kale@hackernewsletter.com" }, listId: "hackernewsletter.com", subject: `#${i} SQLite internals and CRDTs`, bodyText: "This week: SQLite internals, CRDTs, local-first. Unsubscribe", date: NOW - (i + 1) * 86_400_000 })), NOW);
    await backend.categorizer.rebuildNow();
    const t = sqlDb(backend.store).get<{ id: number }>("SELECT id FROM threads LIMIT 1")!.id;
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
    ingestMessages(sqlDb(backend.store), [...news, ...friends], NOW);
    const filed = sqlDb(backend.store).all<{ thread_id: number }>("SELECT DISTINCT thread_id FROM messages WHERE from_email = 'crew@morningbrew.com'").map((r) => r.thread_id);
    await client.call("categories.addThreads", { categoryId: cat, threadIds: filed });
    await backend.categorizer.rebuildNow();
    await backend.ingestSliced([incoming(acct, { from: { name: "Morning Brew", email: "crew@morningbrew.com" }, listId: "daily.morningbrew.com", subject: "Your brief", bodyText: "Markets. Unsubscribe", date: NOW - 3_600_000, providerMsgId: "new-brief" })]);
    const fresh = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = 'new-brief'")!.thread_id;
    const [best] = await client.call("categorize.predict", { threadId: fresh });
    expect(best).toMatchObject({ categoryId: cat, decision: "auto" });
    expect(best!.reasons[0]).toMatchObject({ k: "reason.sameSender", p: { category: expect.any(String) } });
    const detail = await client.call("threads.get", { threadId: fresh });
    expect(detail.categorization?.auto).toEqual([{ categoryId: cat, reasons: expect.arrayContaining([expect.objectContaining({ k: "reason.sameSender" })]) }]);

    // a suggestion waiting for an answer, written before reasons were descriptors: its string reads as it is
    const friend = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE from_email = 'amigo1@gmail.com' LIMIT 1")!.thread_id;
    sqlDb(backend.store).run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.85, '[\"menciona «brief»\"]', ?)", friend, cat, NOW);
    expect((await client.call("counts.get", {})).categorySuggestions).toEqual({ [cat]: 1 });
    const { items } = await client.call("categorize.suggestions", { categoryId: cat });
    expect(items.map((x) => [x.id, x.prediction.reasons])).toEqual([[friend, ["menciona «brief»"]]]);
    expect((await client.call("threads.get", { threadId: friend })).categorization?.suggestions).toEqual([{ categoryId: cat, p: 0.85, reasons: ["menciona «brief»"] }]);
    await client.call("categorize.feedback", { threadId: friend, categoryId: cat, verdict: "reject" });
    expect(sqlDb(backend.store).get("SELECT label, weight, source FROM cls_examples WHERE thread_id = ?", friend)).toEqual({ label: -1, weight: 1, source: "reject" });
    expect((await client.call("counts.get", {})).categorySuggestions).toEqual({});

    const stats = await client.call("categorize.stats", {});
    expect(stats).toEqual([{ categoryId: cat, examples: 12, autoApply: true, kept: 0, reverted: 0, autoPrecision: null, paused: false, pendingSuggestions: 0 }]);
    await client.call("categories.update", { id: cat, autoApply: false });
    expect((await client.call("categorize.stats", {}))[0]!.autoApply).toBe(false);
  });
});

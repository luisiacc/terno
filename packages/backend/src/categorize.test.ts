import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@unica/core/rpc";
import { addToCategory, createAccount, createCategory, ingestMessages, seedDataset, type IncomingMessage } from "@unica/db";
import { demoRegistry } from "@unica/mail";
import { generateDataset } from "@unica/mock-data";
import { afterEach, describe, expect, it } from "vitest";
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

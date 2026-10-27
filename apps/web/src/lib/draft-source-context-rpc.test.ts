import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, sqlDb, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import type { ProviderRegistry } from "@terno/mail";
import { withAccounts, ingest, msg, threadOf } from "@terno/store/conformance";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";

const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it(`${adapter}: source context follows the live message through merge and deletion`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-context-rpc-"));
  const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "source-context", origin: "renderer" });
  const client = new RpcClient(c);
  try {
    const [a, b] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "first", rfcMessageId: "first@example.test" }), msg({ accountId: a!, providerMsgId: "source", rfcMessageId: "source@example.test" })]);
    const old = await threadOf(store, "source"), source = (await store.threads.get(old))!.messages[0]!;
    expect(await client.call("drafts.sourceContext", { messageId: source.id })).toEqual({ threadId: old, accountId: a });
    const draft = (await client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, showSourceContext: true, bodyText: "exact" }))!;
    expect(draft).toMatchObject({ threadId: null, showSourceContext: true, presentationThreadId: old, bodyText: "exact" });
    const standalone = (await client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, showSourceContext: false, bodyText: "standalone" }))!;
    expect(standalone.presentationThreadId).toBeNull();
    expect(await client.call("drafts.sourceContext", { messageId: 99999 })).toBeNull();
    await ingest(store, [msg({ accountId: a!, providerMsgId: "bridge", references: ["first@example.test", "source@example.test"] })]);
    const merged = await threadOf(store, "bridge");
    expect(await client.call("drafts.sourceContext", { messageId: source.id })).toEqual({ threadId: merged, accountId: a });
    expect((await client.call("drafts.list", {})).find((d) => d.id === draft.id)?.presentationThreadId).toBe(merged);
    await store.sync.remove([source.id]);
    expect(await client.call("drafts.sourceContext", { messageId: source.id })).toBeNull();
    expect((await client.call("drafts.list", {})).find((d) => d.id === draft.id)?.presentationThreadId).toBeNull();
  } finally { c.close(); try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
});

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it(`${adapter}: rejects a message/thread account mismatch`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-context-mismatch-")), name = crypto.randomUUID();
  const open = async () => adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name, factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  let store = await open();
  try {
    const [a, b] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "source" })]);
    const thread = await threadOf(store, "source"), source = (await store.threads.get(thread))!.messages[0]!;
    if (store instanceof SqlMailStore) sqlDb(store).run("UPDATE messages SET account_id = ? WHERE id = ?", b!, source.id);
    else {
      await store.close();
      const raw = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(`terno-${name}`); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      await new Promise<void>((resolve, reject) => {
        const tx = raw.transaction("messages", "readwrite"), table = tx.objectStore("messages"), req = table.get(source.id);
        req.onsuccess = () => table.put({ ...req.result, account_id: b }, source.id);
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
      raw.close(); store = await open();
    }
    expect(await store.drafts.sourceContext(source.id)).toBeNull();
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const mode of ["reply", "replyAll", "forward"] as const) it(`${adapter}: ${mode} source intent survives reopen, merge and normal ID allocation`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-context-lifecycle-")), name = crypto.randomUUID();
  const open = async () => adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name, factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  let store = await open();
  try {
    const [a, b] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "anchor", rfcMessageId: "anchor@example.test" }), msg({ accountId: a!, providerMsgId: "inactive" }), msg({ accountId: a!, providerMsgId: "source", rfcMessageId: "source@example.test" })]);
    const old = await threadOf(store, "source"), anchor = await threadOf(store, "anchor");
    const source = (await store.threads.get(old))!.messages[0]!, inactive = (await store.threads.get(await threadOf(store, "inactive")))!.messages[0]!;
    const fields = { accountId: b!, threadId: null, mode, to: [], cc: [], subject: "exact subject", bodyText: "exact\nwork", bodyHtml: "<div><b>exact</b></div>", inReplyToMessageId: mode === "forward" ? inactive.id : source.id, forwardOfMessageId: mode === "forward" ? source.id : inactive.id };
    const saved = (await store.drafts.save({ ...fields, showSourceContext: true }, 1))!;
    expect(saved).toMatchObject({ thread_id: null, presentation_thread_id: old, show_source_context: 1 });
    const preserved = (await store.drafts.save({ ...fields, id: saved.id, generation: saved.generation, baseRevision: saved.revision }, 2))!;
    expect(preserved).toMatchObject({ id: saved.id, generation: saved.generation, presentation_thread_id: old, show_source_context: 1 });
    for (const intent of [undefined, false, true]) {
      const copy = (await store.drafts.save({ ...fields, id: saved.id, generation: saved.generation, baseRevision: saved.revision, ...(intent === undefined ? {} : { showSourceContext: intent }) }, 3))!;
      expect(copy.id).not.toBe(saved.id);
      expect(copy.show_source_context).toBe(Number(intent === true));
      expect(copy.presentation_thread_id).toBe(intent === true ? old : null);
    }
    const standalone = (await store.drafts.save({ ...fields, showSourceContext: false }, 4))!;
    await store.sync.remove([inactive.id]);
    expect((await store.drafts.list()).find((d) => d.id === saved.id)).toMatchObject({ mode, presentation_thread_id: old, body_text: fields.bodyText });
    await ingest(store, [msg({ accountId: a!, providerMsgId: "bridge", references: ["anchor@example.test", "source@example.test"] })]);
    expect(await threadOf(store, "bridge")).toBe(anchor);
    await store.close(); store = await open();
    await ingest(store, [msg({ accountId: a!, providerMsgId: "fills-inactive-thread" }), msg({ accountId: a!, providerMsgId: "unrelated" })]);
    expect(await threadOf(store, "unrelated")).toBe(old);
    expect((await store.drafts.list()).find((d) => d.id === saved.id)).toMatchObject({ id: saved.id, generation: saved.generation, thread_id: null, mode, presentation_thread_id: anchor, body_text: fields.bodyText, body_html: fields.bodyHtml });
    expect((await store.drafts.list()).find((d) => d.id === standalone.id)?.presentation_thread_id).toBeNull();
    expect(await store.drafts.sourceContext(source.id)).toEqual({ threadId: anchor, accountId: a });
    await ingest(store, [msg({ accountId: a!, providerMsgId: "highest" })]);
    const highest = (await store.threads.get(await threadOf(store, "highest")))!.messages[0]!.id;
    await store.sync.remove([highest]);
    await store.close(); store = await open();
    await ingest(store, [msg({ accountId: a!, providerMsgId: "next" })]);
    expect((await store.threads.get(await threadOf(store, "next")))!.messages[0]!.id).toBe(highest + 1);
    await store.accounts.remove(a!);
    const orphan = (await store.drafts.list()).find((d) => d.id === saved.id)!;
    expect(orphan).toMatchObject({ id: saved.id, generation: saved.generation, thread_id: null, presentation_thread_id: null, body_text: fields.bodyText, body_html: fields.bodyHtml });
    expect(await store.drafts.sourceContext(source.id)).toBeNull();
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("SQL projection sees an external writer's atomic source move and draft intent change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-context-external-")), path = join(dir, "mail.db");
  const store = new SqlMailStore(openDatabase(path));
  let writer: ReturnType<typeof openDatabase> | undefined;
  try {
    const [a, b] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "first" }), msg({ accountId: a!, providerMsgId: "source" })]);
    const target = await threadOf(store, "first"), old = await threadOf(store, "source"), source = (await store.threads.get(old))!.messages[0]!;
    const draft = (await store.drafts.save({ accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, showSourceContext: true, to: [], cc: [], subject: "subject", bodyText: "exact" }, 1))!;
    writer = openDatabase(path);
    writer.tx(() => { writer!.run("UPDATE messages SET thread_id = ? WHERE id = ?", target, source.id); writer!.run("UPDATE drafts SET show_source_context = 0, body_text = 'external exact' WHERE id = ?", draft.id); });
    expect((await store.drafts.list())[0]).toMatchObject({ id: draft.id, body_text: "external exact", presentation_thread_id: null });
    writer.run("UPDATE drafts SET show_source_context = 1 WHERE id = ?", draft.id);
    expect((await store.drafts.list())[0]).toMatchObject({ id: draft.id, body_text: "external exact", thread_id: null, presentation_thread_id: target });
    expect(await store.drafts.sourceContext(source.id)).toEqual({ threadId: target, accountId: a });
  } finally { writer?.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});


for (const instantSearch of [false, true]) for (const abort of [false, true]) it(`IDB source lookup waits behind an in-flight transaction (instant ${instantSearch}, abort ${abort})`, async () => {
  const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  try {
    const [a] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "source" })]);
    const threadId = await threadOf(store, "source"), source = (await store.threads.get(threadId))!.messages[0]!;
    const transaction = IDBDatabase.prototype.transaction;
    let release!: () => void, reached!: () => void, gate = true;
    const waiting = new Promise<void>((done) => { reached = done; });
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args);
      if (gate && args[1] === "readwrite") {
        gate = false;
        let hold = true, requests = 0;
        const keepAlive = () => {
          const req = tx.objectStore(tx.objectStoreNames[0]!).get(0);
          req.onsuccess = () => { if (hold && ++requests < 100) keepAlive(); };
        };
        keepAlive();
        let released = false;
        release = () => { if (released) return; released = true; hold = false; if (abort) tx.abort(); };
        reached();
      }
      return tx;
    });
    try {
      const deletion = store.sync.remove([source.id]);
      const outcome = abort ? expect(deletion).rejects.toThrow() : deletion;
      await waiting;
      let settled = false;
      const pendingContext = store.drafts.sourceContext(source.id).then((value) => { settled = true; return value; });
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      release(); await outcome;
      expect(await pendingContext).toEqual(abort ? { threadId, accountId: a } : null);
      expect(await store.drafts.sourceContext(source.id)).toEqual(abort ? { threadId, accountId: a } : null);
    } finally { release?.(); spy.mockRestore(); }
  } finally { await store.close(); }
});

for (const instantSearch of [false, true]) it(`IDB overlapping lookup returns a committed snapshot (instant ${instantSearch})`, async () => {
  const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  try {
    const [a] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "overlap" })]);
    const threadId = await threadOf(store, "overlap"), source = (await store.threads.get(threadId))!.messages[0]!;
    const deletion = store.sync.remove([source.id]);
    const overlap = store.drafts.sourceContext(source.id);
    await deletion;
    expect([null, { threadId, accountId: a }]).toContainEqual(await overlap);
    expect(await store.drafts.sourceContext(source.id)).toBeNull();
  } finally { await store.close(); }
});

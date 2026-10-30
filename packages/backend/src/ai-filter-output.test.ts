import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, type CompletionRequest, type WireFilter } from "@terno/ai";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { databaseName, IdbMailStore } from "@terno/idb";
import { demoRegistry } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 9, 22, 12);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function setup(kind: "SQL" | "IndexedDB") {
  const dir = mkdtempSync(join(tmpdir(), "terno-ai-output-"));
  const factory = new IDBFactory();
  const name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const script = { beforeReply: async (_req: CompletionRequest) => {}, wire: undefined as WireFilter | undefined, calls: 0 };
  let backend: Backend;
  let client: RpcClient;
  async function open() {
    const store = kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined;
    backend = new Backend({
      dbPath: join(dir, "test.db"), store, platform, version: "test", providers: demoRegistry,
      cipher: plaintextCipher, now: () => NOW, autoSync: false, iconTransport: null,
      aiFactory: (config) => createAi({ ...config, capabilities: { output: "json_schema", contextTokens: null, embeddings: false, probedAt: null } }, {
        transport: { async complete(req) { script.calls++; await script.beforeReply(req); return { stop: "end", text: JSON.stringify(script.wire) }; } },
      }),
    });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "ai-output", origin: "renderer" });
    client = new RpcClient(c);
  }
  await open();
  cleanup.push(async () => { client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  const { account } = await backend!.store.accounts.create({ kind: "imap", email: "me@example.test", displayName: "Synthetic", color: "indigo", now: NOW });
  const category = await client!.call("categories.create", { name: "Receipts", color: "amber" });
  await backend!.store.settings.set("app", { ai: { provider: "fake" } });
  script.wire = {
    name: "A newly invented filter name is valid", explanation: "Mark receipts read and categorize them.", match: "all",
    conditions: [{ field: "subject", op: "contains", value: "Synthetic receipt", negate: false }],
    actions: [{ type: "markRead", categoryId: null }, { type: "addCategory", categoryId: category.id }],
  };
  const message: IncomingMessage = {
    accountId: account.id, providerMsgId: "synthetic-receipt", providerThreadId: null, rfcMessageId: "receipt@example.test", inReplyTo: null, references: [],
    from: { name: "Synthetic", email: "sender@example.test" }, to: [{ name: "", email: account.email }], cc: [], bcc: [], subject: "Synthetic receipt", date: NOW,
    snippet: "Synthetic", bodyText: "Synthetic", bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 9,
  };
  await backend!.store.sync.ingest([message], { applyFilters: false, now: NOW, classifier: null });
  return {
    get backend() { return backend; }, get client() { return client; }, script, category, account,
    generate: () => client.call("filters.generate", { prompt: "Mark receipts read and categorize them" }),
    async reopen() { client.close(); await backend.stop(); await open(); },
    async applicationState(id: number) {
      if (kind === "SQL") {
        const db = sqlDb(backend.store);
        return { claims: db.get<{ n: number }>("SELECT count(*) AS n FROM filter_applications WHERE filter_id = ?", id)!.n, at: db.get<{ last_applied_at: number | null }>("SELECT last_applied_at FROM filters WHERE id = ?", id)!.last_applied_at };
      }
      const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const raw = await read(factory.open(databaseName(name)));
      try {
        const tx = raw.transaction(["filter_applications", "filters"]);
        const [claims, filter] = await Promise.all([read(tx.objectStore("filter_applications").getAll()), read(tx.objectStore("filters").get(id))]);
        return { claims: claims.filter((row) => row.filter_id === id).length, at: filter.last_applied_at as number | null };
      } finally { raw.close(); }
    },
  };
}

for (const kind of ["SQL", "IndexedDB"] as const) describe(`AI filter targets (${kind})`, () => {
  it("rejects deletion while generation waits, without saving or applying a partial filter", async () => {
    const t = await setup(kind);
    const started = gate(); const answer = gate();
    t.script.beforeReply = async () => { started.release(); await answer.promise; };
    const generating = t.generate();
    // Attach rejection handling before releasing the provider.
    const result = generating.then(() => null, (error: unknown) => error);
    await started.promise;
    await t.client.call("categories.delete", { id: t.category.id });
    answer.release();
    expect(await result).toMatchObject({ code: "UNAVAILABLE", details: { aiErrorKind: "invalid_output" } });
    expect(await t.client.call("filters.list", {})).toEqual([]);
    expect((await t.backend.store.debug.snapshot()).messages[0]!.isRead).toBe(false);
    expect((await t.backend.store.debug.snapshot()).ops).toEqual([]);
  });

  it.each([false, true])("rejects a referenced account deleted and replaced during model work (negate=%s)", async (negate) => {
    const t = await setup(kind);
    const { account: other } = await t.backend.store.accounts.create({ kind: "imap", email: "other@example.test", displayName: "Other", color: "indigo", now: NOW });
    t.script.wire!.match = "any";
    t.script.wire!.conditions.push({ field: "account", op: "is", value: String(other.id), negate });
    const started = gate(); const answer = gate();
    t.script.beforeReply = async () => { started.release(); await answer.promise; };
    const result = t.generate().then(() => null, (error: unknown) => error);
    await started.promise;
    await t.client.call("accounts.remove", { id: other.id });
    const { account: replacement } = await t.backend.store.accounts.create({ kind: "imap", email: other.email, displayName: "Replacement", color: "indigo", now: NOW });
    expect(replacement.id).not.toBe(other.id);
    answer.release();
    expect(await result).toMatchObject({ code: "UNAVAILABLE", details: { aiErrorKind: "invalid_output" }, i18n: { key: "errors.accountGone" } });
    expect(t.script.calls).toBe(1); // valid structured output, stale post-model context
    expect(await t.client.call("filters.list", {})).toEqual([]);
    expect((await t.backend.store.debug.snapshot()).messages[0]!.isRead).toBe(false);
    expect((await t.backend.store.debug.snapshot()).ops).toEqual([]);
  });

  it.each(["all", "any"] as const)("preserves %s mixed account conditions, negation and normal no-match effects", async (match) => {
    const t = await setup(kind);
    for (const negate of [true, false]) {
      t.script.wire!.match = match;
      t.script.wire!.conditions = [
        { field: "subject", op: "contains", value: match === "all" ? "Synthetic receipt" : "No such subject", negate: false },
        { field: "account", op: "is", value: String(t.account.id), negate },
      ];
      const generated = await t.generate();
      expect(generated.rule).toMatchObject({ match, conditions: [
        { field: "subject", op: "contains", value: t.script.wire!.conditions[0]!.value },
        { field: "account", op: "is", value: t.account.id, ...(negate ? { negate: true } : {}) },
      ] });
      expect(generated.rule.conditions).toHaveLength(2);
      const saved = await t.client.call("filters.save", { name: generated.name, rule: generated.rule, enabled: true, source: "ai" });
      expect(await t.client.call("filters.apply", { id: saved.id })).toEqual({ matchedMessages: negate ? 0 : 1, affectedThreads: negate ? 0 : 1 });
      expect(await t.applicationState(saved.id)).toEqual({ claims: negate ? 0 : 1, at: negate ? null : NOW });
      if (negate) {
        expect((await t.backend.store.debug.snapshot()).messages[0]!.isRead).toBe(false);
        expect((await t.backend.store.debug.snapshot()).memberships).toEqual([]);
      }
    }
  });

  it("keeps a valid draft when an unreferenced account disappears during model work", async () => {
    const t = await setup(kind);
    const { account: other } = await t.backend.store.accounts.create({ kind: "imap", email: "other@example.test", displayName: "Other", color: "indigo", now: NOW });
    t.script.wire!.conditions.push({ field: "account", op: "is", value: String(t.account.id), negate: false });
    const started = gate(); const answer = gate();
    t.script.beforeReply = async () => { started.release(); await answer.promise; };
    const result = t.generate();
    await started.promise;
    await t.client.call("accounts.remove", { id: other.id });
    answer.release();
    await expect(result).resolves.toMatchObject({ rule: { conditions: [expect.anything(), { field: "account", value: t.account.id }] } });
  });

  it.each(["supersession", "shutdown"] as const)("preserves %s cancellation while the fresh account read waits", async (mode) => {
    const t = await setup(kind);
    const started = gate(); const read = gate();
    const list = t.backend.store.accounts.list.bind(t.backend.store.accounts);
    let reads = 0;
    t.backend.store.accounts.list = async () => {
      const accounts = await list();
      if (++reads === 2) { started.release(); await read.promise; }
      return accounts;
    };
    const first = t.generate().then(() => null, (error: unknown) => error);
    // Before this fix there is no post-model accounts read. Avoid waiting on a nonexistent await.
    const reached = await Promise.race([started.promise.then(() => true), first.then(() => false)]);
    expect(reached).toBe(true);
    try {
      if (mode === "supersession") await expect(t.generate()).resolves.toMatchObject({ name: t.script.wire!.name });
      else t.backend.abort.abort();
    } finally { read.release(); }
    expect(await first).toMatchObject({ code: "CANCELLED", details: { aiErrorKind: "cancelled" } });
    expect(await t.client.call("filters.list", {})).toEqual([]);
  });

  it("keeps superseded generation cancelled while the current-category read waits", async () => {
    const t = await setup(kind);
    const started = gate(); const read = gate();
    const list = t.backend.store.categories.list.bind(t.backend.store.categories);
    let reads = 0;
    t.backend.store.categories.list = async () => {
      const categories = await list();
      if (++reads === 2) { started.release(); await read.promise; }
      return categories;
    };
    const first = t.generate().then(() => null, (error: unknown) => error);
    await started.promise;
    try {
      await expect(t.generate()).resolves.toMatchObject({ name: t.script.wire!.name });
    } finally { read.release(); }
    expect(await first).toMatchObject({ code: "CANCELLED", details: { aiErrorKind: "cancelled" } });
    expect(await t.client.call("filters.list", {})).toEqual([]);
  });

  it.each(["unknown", "all-invalid", "mixed"] as const)("rejects %s category actions after exhausting repairs", async (mode) => {
    const t = await setup(kind);
    const invalid = { type: "addCategory" as const, categoryId: 999_999 };
    t.script.wire!.actions = mode === "mixed" ? [...t.script.wire!.actions, invalid] : mode === "all-invalid" ? [invalid, { ...invalid, categoryId: 888_888 }] : [invalid];
    await expect(t.generate()).rejects.toMatchObject({ details: { aiErrorKind: "invalid_output" } });
    expect(t.script.calls).toBe(2);
    expect(await t.client.call("filters.list", {})).toEqual([]);
    expect((await t.backend.store.debug.snapshot()).messages[0]!.isRead).toBe(false);
  });

  it("persists and applies every valid action once, including after reopen", async () => {
    const t = await setup(kind);
    const generated = await t.generate();
    const saved = await t.client.call("filters.save", { name: generated.name, rule: generated.rule, enabled: true, source: "ai" });
    expect(saved.rule.actions).toEqual([{ type: "markRead" }, { type: "addCategory", categoryId: t.category.id }]);
    expect(await t.client.call("filters.apply", { id: saved.id })).toEqual({ matchedMessages: 1, affectedThreads: 1 });
    await t.reopen();
    const snapshot = await t.backend.store.debug.snapshot();
    expect(snapshot.messages[0]!.isRead).toBe(true);
    expect(snapshot.memberships).toMatchObject([{ categoryId: t.category.id, addedBy: "filter" }]);
    expect((await t.client.call("filters.list", {}))[0]).toMatchObject({ hits: 1 });
    expect(await t.applicationState(saved.id)).toEqual({ claims: 1, at: NOW });
    expect(await t.client.call("filters.apply", { id: saved.id })).toEqual({ matchedMessages: 0, affectedThreads: 0 });
  });

  it("rolls back a valid earlier action and retains stale filter work for repair", async () => {
    const t = await setup(kind);
    const generated = await t.generate();
    await t.client.call("categories.delete", { id: t.category.id });
    const saved = await t.client.call("filters.save", { name: generated.name, rule: generated.rule, enabled: true, source: "ai" });
    const before = await t.backend.store.debug.snapshot();
    await expect(t.client.call("filters.apply", { id: saved.id })).rejects.toBeDefined();
    await t.reopen();
    const after = await t.backend.store.debug.snapshot();
    expect(after.messages).toEqual(before.messages);
    expect(after.memberships).toEqual([]);
    expect(after.ops).toEqual(before.ops);
    expect((await t.client.call("filters.list", {}))[0]).toMatchObject({ hits: 0 });
    expect(await t.applicationState(saved.id)).toEqual({ claims: 0, at: null });
    // Repeated failure must still reach the action: no claim may survive the rollback.
    await expect(t.client.call("filters.apply", { id: saved.id })).rejects.toBeDefined();
    const replacement = await t.client.call("categories.create", { name: "Replacement", color: "amber" });
    await t.client.call("filters.save", { id: saved.id, name: saved.name, enabled: true, source: "ai", rule: { ...saved.rule, actions: [{ type: "markRead" }, { type: "addCategory", categoryId: replacement.id }] } });
    expect(await t.client.call("filters.apply", { id: saved.id })).toEqual({ matchedMessages: 1, affectedThreads: 1 });
  });
});

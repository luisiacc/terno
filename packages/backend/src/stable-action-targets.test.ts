import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilterRule } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { openDatabase, SqlMailStore, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { BackendCore, plaintextCipher } from "./core";

const NOW = Date.UTC(2026, 9, 30, 12);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-stable-action-"));
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  let backend: BackendCore;
  let client: RpcClient;
  async function open() {
    const store = new SqlMailStore(openDatabase(join(dir, "test.db")), { platform, instantSearch: false });
    backend = new BackendCore({ store, platform, version: "test", providers: demoRegistry, cipher: plaintextCipher, now: () => NOW, autoSync: false, iconTransport: null });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "stable-actions", origin: "renderer" });
    client = new RpcClient(c);
  }
  await open();
  cleanup.push(async () => { client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  const { account } = await backend!.store.accounts.create({ kind: "imap", email: "me@example.test", displayName: "Synthetic", color: "indigo", now: NOW });
  const category = await client!.call("categories.create", { name: "Receipts", color: "amber" });
  const message: IncomingMessage = {
    accountId: account.id, providerMsgId: "target", providerThreadId: null, rfcMessageId: "target@example.test", inReplyTo: null, references: [],
    from: { name: "Synthetic", email: "sender@example.test" }, to: [{ name: "", email: account.email }], cc: [], bcc: [], subject: "Target receipt", date: NOW,
    snippet: "Synthetic", bodyText: "Target bytes", bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 12,
  };
  await backend!.store.sync.ingest([message, { ...message, providerMsgId: "neighbor", rfcMessageId: "neighbor@example.test", subject: "Unrelated", bodyText: "Neighbor bytes" }], { applyFilters: false, now: NOW, classifier: null });
  const rule: FilterRule = { match: "all", conditions: [{ field: "subject", op: "equals", value: "Target receipt" }], actions: [{ type: "markRead" }, { type: "addCategory", categoryId: category.id }] };
  return {
    get backend() { return backend; }, get client() { return client; }, category, account, rule,
    save: (value = rule) => client.call("filters.save", { name: "Stable destination", enabled: true, source: "manual", rule: value }),
    async reopen() { client.close(); await backend.stop(); await open(); },
    async history(id: number) {
      const db = sqlDb(backend.store);
      return { claims: db.all("SELECT filter_id, message_id, applied_at FROM filter_applications WHERE filter_id = ? ORDER BY message_id", id), at: db.get<{ last_applied_at: number | null }>("SELECT last_applied_at FROM filters WHERE id = ?", id)!.last_applied_at };
    },
    async ops() {
      const snapshot = await backend.store.debug.snapshot();
      return Promise.all(snapshot.ops.map((op) => backend.store.ops.get(op.id)));
    },
  };
}

describe("stable explicit filter actions (native SQLite)", () => {
  it("keeps the renamed destination ID, exact queued target and neighbor across reopen", async () => {
    const t = await setup();
    const saved = await t.save();
    await t.client.call("categories.update", { id: t.category.id, name: "Renamed" });
    const decoy = await t.client.call("categories.create", { name: t.category.name, color: "amber" });
    expect(decoy.id).not.toBe(t.category.id);
    await t.reopen();
    const before = await t.backend.store.debug.snapshot();
    const [target, neighbor] = before.messages;
    expect(target!.threadId).not.toBe(neighbor!.threadId);
    expect(await t.client.call("filters.apply", { id: saved.id })).toEqual({ matchedMessages: 1, affectedThreads: 1 });
    const after = await t.backend.store.debug.snapshot();
    expect(after.messages).toEqual([{ ...target, isRead: true }, neighbor]);
    expect(after.memberships).toEqual([{ threadId: target!.threadId, categoryId: t.category.id, addedBy: "filter", batchId: null }]);
    expect(await t.history(saved.id)).toEqual({ claims: [{ filter_id: saved.id, message_id: target!.id, applied_at: NOW }], at: NOW });
    const ops = await t.ops();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ account_id: t.account.id, kind: "markRead", state: "queued", attempts: 0 });
    expect(JSON.parse(ops[0]!.target_json)).toMatchObject({ messageIds: [target!.id] });
    await t.reopen();
    expect(await t.ops()).toEqual(ops);
    expect((await t.client.call("filters.list", {}))[0]).toEqual({ ...saved, hits: 1 });
    expect(await t.client.call("filters.apply", { id: saved.id })).toEqual({ matchedMessages: 0, affectedThreads: 0 });
    expect(await t.backend.store.debug.snapshot()).toEqual(after);
    expect(await t.history(saved.id)).toEqual({ claims: [{ filter_id: saved.id, message_id: target!.id, applied_at: NOW }], at: NOW });
  });

  it.each([false, true])("refuses a deleted saved destination instead of its same-name replacement (reserve higher ID=%s)", async (reserve) => {
    const t = await setup();
    const saved = await t.save();
    await t.reopen();
    if (reserve) await t.client.call("categories.create", { name: "Surviving higher ID", color: "amber" });
    await t.client.call("categories.delete", { id: t.category.id });
    const replacement = await t.client.call("categories.create", { name: t.category.name, color: "amber" });
    // The unreserved case reproduces SQLite ID reuse; a higher survivor qualifies genuinely missing-ID rollback.
    if (reserve) expect(replacement.id).not.toBe(t.category.id);
    const before = await t.backend.store.debug.snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(t.client.call("filters.apply", { id: saved.id })).rejects.toBeDefined();
      await t.reopen();
      expect(await t.backend.store.debug.snapshot()).toEqual(before);
      expect(await t.client.call("filters.list", {})).toEqual([saved]);
      expect(await t.history(saved.id)).toEqual({ claims: [], at: null });
      expect(await t.ops()).toEqual([]);
    }
    await t.client.call("filters.save", { ...saved, rule: { ...saved.rule, actions: [{ type: "markRead" }, { type: "addCategory", categoryId: replacement.id }] } });
    expect(await t.client.call("filters.apply", { id: saved.id })).toEqual({ matchedMessages: 1, affectedThreads: 1 });
    expect((await t.backend.store.debug.snapshot()).memberships).toEqual([{ threadId: before.messages[0]!.threadId, categoryId: replacement.id, addedBy: "filter", batchId: null }]);
  });

  it.each([
    { type: "addCategory" }, { type: "addCategory", categoryId: "Receipts" },
    { type: "addCategory", categoryId: 0 }, { type: "addCategory", categoryId: -1 },
    { type: "addCategory", categoryId: 1.5 }, { type: "addCategory", name: "Receipts" },
    { type: "moveToFolder", folder: "Receipts" },
  ])("rejects malformed destination %j before saving", async (action) => {
    const t = await setup();
    const before = await t.backend.store.debug.snapshot();
    // Deliberately emulate an untyped RPC sender; normal typed callers cannot send this.
    await expect(t.save({ ...t.rule, actions: [action] } as FilterRule)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await t.client.call("filters.list", {})).toEqual([]);
    expect(await t.backend.store.debug.snapshot()).toEqual(before);
  });
});

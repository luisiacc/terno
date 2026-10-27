import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
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

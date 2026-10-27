import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { contract, createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import type { ProviderRegistry } from "@terno/mail";
import { withAccounts, ingest, msg, threadOf } from "@terno/store/conformance";
const rendererRpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: rendererRpc }));
const { fromServer, shownDraftKey, loadDrafts, forgetDraft, useDrafts } = await import("./drafts");
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it(`${adapter}: restores the same cross-account inline draft through RPC`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-presentation-rpc-")), name = crypto.randomUUID();
  const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name, factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", now: () => 1, autoSync: false });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "draft-presentation", origin: "renderer" });
  const client = new RpcClient(c);
  try {
    const [a, b] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "source" })]);
    const threadId = await threadOf(store, "source"), source = (await store.threads.get(threadId))!.messages[0]!;
    const saved = (await client.call("drafts.save", { showSourceContext: true, accountId: a!, threadId, mode: "reply", inReplyToMessageId: source.id, bodyText: "exact authored work", bodyHtml: "<div><b>exact authored work</b></div>" }))!;
    const foreign = (await client.call("drafts.save", { id: saved.id, generation: saved.generation, baseRevision: saved.revision, accountId: b!, threadId, mode: "reply", inReplyToMessageId: source.id, bodyText: saved.bodyText, bodyHtml: saved.bodyHtml }))!;
    expect(foreign).toMatchObject({ id: saved.id, generation: saved.generation, threadId: null, bodyText: "exact authored work", bodyHtml: "<div><b>exact authored work</b></div>" });
    const [reloaded] = await client.call("drafts.list", {});
    expect(reloaded).toMatchObject({ id: saved.id, generation: saved.generation, threadId: null, bodyText: "exact authored work" });
    const local = fromServer(reloaded!);
    expect(shownDraftKey({ [local.key]: local }, threadId, null)).toBe(local.key);
    useDrafts.setState({ drafts: { [local.key]: local } });
    let release!: (value: NonNullable<typeof reloaded>[]) => void;
    const pending = loadDrafts(() => new Promise((resolve) => { release = resolve; }));
    forgetDraft(local.key);
    release([reloaded!]);
    await pending;
    expect(useDrafts.getState().drafts[local.key]).toBeUndefined();
    const standalone = (await client.call("drafts.save", { showSourceContext: false, accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, bodyText: "standalone" }))!;
    const separate = fromServer(standalone);
    expect(shownDraftKey({ [separate.key]: separate }, threadId, null)).toBeNull();
    const cleared = (await client.call("drafts.save", { showSourceContext: false, id: saved.id, generation: saved.generation, baseRevision: foreign.revision, accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, bodyText: saved.bodyText }))!;
    expect(cleared.presentationThreadId).toBeNull();
    const conflict = (await client.call("drafts.save", { id: saved.id, generation: saved.generation, baseRevision: foreign.revision, accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, bodyText: "stale copy" }))!;
    expect(conflict.id).not.toBe(saved.id);
    expect(conflict.presentationThreadId).toBeNull();
    const reaffirmed = (await client.call("drafts.save", { showSourceContext: true, id: saved.id, generation: saved.generation, baseRevision: cleared.revision, accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, bodyText: "reaffirmed" }))!;
    const changed = (await client.call("drafts.save", { id: saved.id, generation: saved.generation, baseRevision: reaffirmed.revision, accountId: b!, threadId: null, mode: "new", inReplyToMessageId: source.id, bodyText: "new mode" }))!;
    expect(changed.presentationThreadId).toBeNull();
    expect(changed.showSourceContext).toBe(false);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "other" })]);
    const otherThread = await threadOf(store, "other"), other = (await store.threads.get(otherThread))!.messages[0]!;
    expect(otherThread).not.toBe(threadId);
    const forward = (await client.call("drafts.save", { showSourceContext: true, accountId: b!, threadId: null, mode: "forward", inReplyToMessageId: source.id, forwardOfMessageId: other.id, bodyText: "forward body" }))!;
    expect(forward.presentationThreadId).toBe(otherThread);
    await store.sync.remove([source.id]);
    const afterDelete = (await client.call("drafts.list", {})).find((d) => d.id === forward.id)!;
    expect(afterDelete).toMatchObject({ mode: "forward", presentationThreadId: otherThread, bodyText: "forward body" });
    await store.sync.remove([other.id]);
    const orphan = (await client.call("drafts.list", {})).find((d) => d.id === forward.id)!;
    expect(orphan.presentationThreadId).toBeNull();
    expect(orphan.bodyText).toBe("forward body");
    await ingest(store, [msg({ accountId: a!, providerMsgId: "later" })]);
    const laterThread = await threadOf(store, "later"), later = (await store.threads.get(laterThread))!.messages[0]!;
    expect(later.id).toBeGreaterThan(Math.max(source.id, other.id));
    expect((await client.call("drafts.list", {})).find((d) => d.id === forward.id)!.presentationThreadId).toBeNull();
  } finally { c.close(); try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
});

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it(`${adapter}: portable backup drops local placement and queued send keeps exact content`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-presentation-portable-"));
  const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "draft-portable", origin: "renderer" });
  const client = new RpcClient(c);
  try {
    const [a, b] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "source", rfcMessageId: "source@example.test" })]);
    const threadId = await threadOf(store, "source"), source = (await store.threads.get(threadId))!.messages[0]!;
    const saved = (await client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, showSourceContext: true, to: [{ name: "Recipient", email: "recipient@example.test" }], bodyText: "exact\nportable body", bodyHtml: "<div><b>exact</b></div>", quotedText: "", includeQuote: false }))!;
    const backup = await client.call("app.export", {});
    expect(backup.drafts).toHaveLength(1);
    const exported = backup.drafts[0]!;
    expect(exported).toMatchObject({ bodyText: saved.bodyText, bodyHtml: saved.bodyHtml, inReplyTo: "source@example.test" });
    for (const field of ["showSourceContext", "presentationThreadId", "threadId", "inReplyToMessageId", "id", "generation"]) expect(exported).not.toHaveProperty(field);
    await client.call("drafts.delete", { id: saved.id, generation: saved.generation! });
    await client.call("app.import", { data: backup });
    const [imported] = await client.call("drafts.list", {});
    expect(imported).toMatchObject({ threadId: null, showSourceContext: false, presentationThreadId: null, bodyText: saved.bodyText, bodyHtml: saved.bodyHtml });
    expect(imported!.id).not.toBe(saved.id);
    const queued = await client.call("compose.send", { accountId: b!, to: imported!.to, cc: [], bcc: [], subject: imported!.subject, bodyText: imported!.bodyText, bodyHtml: imported!.bodyHtml, draftId: imported!.id, draftGeneration: imported!.generation!, draftRevision: imported!.revision, attachments: [] });
    expect(await client.call("drafts.list", {})).toEqual([]);
    const operation = await store.ops.get(queued.opId);
    expect(operation).toMatchObject({ kind: "send", state: "queued" });
    const payload = JSON.parse(operation!.payload_json);
    expect(payload).toMatchObject({ text: saved.bodyText, html: saved.bodyHtml });
    for (const field of ["showSourceContext", "show_source_context", "presentationThreadId", "presentation_thread_id"]) expect(payload).not.toHaveProperty(field);
  } finally { c.close(); try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
});


for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const action of ["forward", "reply", "missing", "moved"] as const) it(`${adapter}: expired inline draft is reused by ${action} without a strip click`, async () => {
  const { openCompose, installComposeFollowsSelection } = await import("./compose");
  const { flushDraft, setDraftTransport } = await import("./drafts");
  const { setApp, getApp } = await import("~/state/app");
  const { useThreads } = await import("~/state/threads");
  const dir = mkdtempSync(join(tmpdir(), "terno-presentation-return-"));
  const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "draft-return", origin: "renderer" });
  const client = new RpcClient(c);
  rendererRpc.call.mockImplementation((method, params) => client.call(method, params));
  setDraftTransport((method, params) => method === "drafts.save" ? client.call(method, contract[method].params.parse(params)) : client.call(method, contract[method].params.parse(params)));
  let stop = () => {};
  try {
    const [a, b] = await withAccounts(store);
    await ingest(store, [msg({ accountId: a!, providerMsgId: "anchor", rfcMessageId: "anchor@example.test", attachments: [] }), msg({ accountId: a!, providerMsgId: "source", rfcMessageId: "source@example.test", attachments: [] })]);
    const threadId = await threadOf(store, "source"), detail = (await store.threads.get(threadId))!, source = detail.messages[0]!;
    const saved = (await client.call("drafts.save", { accountId: a!, threadId, mode: "reply", inReplyToMessageId: source.id, showSourceContext: true, bodyText: "exact authored body", bodyHtml: "<div><b>exact</b></div>" }))!;
    const foreign = (await client.call("drafts.save", { id: saved.id, generation: saved.generation, baseRevision: saved.revision, accountId: b!, threadId, mode: "reply", inReplyToMessageId: source.id, bodyText: saved.bodyText, bodyHtml: saved.bodyHtml }))!;
    expect(foreign).toMatchObject({ threadId: null, showSourceContext: true, presentationThreadId: threadId });
    const local = fromServer(foreign);
    useDrafts.setState({ drafts: { [local.key]: local } });
    useThreads.setState({ details: new Map([[threadId, detail]]) });
    setApp({ accounts: await store.accounts.list(), accountId: a!, selectedId: threadId, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: { threadId, key: local.key }, draftFocus: null, dialog: null, fatal: null });
    stop = installComposeFollowsSelection();
    setApp({ selectedId: null }); setApp({ selectedId: threadId });
    expect(shownDraftKey(useDrafts.getState().drafts, threadId, null)).toBeNull();
    if (action === "missing") await store.sync.remove([source.id]);
    if (action === "moved") await ingest(store, [msg({ accountId: a!, providerMsgId: "bridge", references: ["anchor@example.test", "source@example.test"], attachments: [] })]);
    await openCompose(action === "reply" ? "reply" : "forward", threadId);
    expect(rendererRpc.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: source.id });
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([local.key]);
    const after = useDrafts.getState().drafts[local.key]!;
    expect(after).toMatchObject({ id: foreign.id, generation: foreign.generation, bodyText: saved.bodyText, bodyHtml: saved.bodyHtml });
    if (action === "missing" || action === "moved") {
      expect(getApp().compose?.key).toBe(local.key);
      expect(shownDraftKey(useDrafts.getState().drafts, threadId, null)).toBeNull();
    } else {
      expect(after.mode).toBe(action);
      expect(shownDraftKey(useDrafts.getState().drafts, threadId, null)).toBe(local.key);
      await flushDraft(local.key);
      expect((await client.call("drafts.list", {}))[0]).toMatchObject({ id: foreign.id, generation: foreign.generation, threadId: null, showSourceContext: true, bodyText: saved.bodyText, bodyHtml: saved.bodyHtml });
    }
  } finally {
    stop(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
    rendererRpc.call.mockReset(); useThreads.setState({ details: new Map() }); c.close();
    try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it(`${adapter}: unrelated local work cannot drop gated RPC hydration`, async () => {
  const { createDraft, editDraft, setDraftTransport, flushDraft } = await import("./drafts");
  const { newFields } = await import("./compose-fields");
  const dir = mkdtempSync(join(tmpdir(), "terno-hydration-r1-"));
  const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "hydration-r1", origin: "renderer" }); const client = new RpcClient(c);
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((done) => { release = done; }), waiting = new Promise<void>((done) => { reached = done; });
  try {
    const [a] = await withAccounts(store);
    const first = (await client.call("drafts.save", { accountId: a!, bodyText: "durable A" }))!;
    const removed = (await client.call("drafts.save", { accountId: a!, bodyText: "durable removed" }))!;
    const stale = (await client.call("drafts.save", { accountId: a!, bodyText: "stale base" }))!;
    await client.call("drafts.save", { id: stale.id, generation: stale.generation, baseRevision: stale.revision, accountId: a!, bodyText: "other writer" });
    setDraftTransport((method, params) => method === "drafts.save" ? client.call(method, contract[method].params.parse(params)) : client.call(method, contract[method].params.parse(params)));
    useDrafts.setState({ drafts: { [`srv-${removed.id}`]: fromServer(removed), [`srv-${stale.id}`]: fromServer(stale) } });
    const pending = loadDrafts(async () => { const rows = await client.call("drafts.list", {}); reached(); await gate; return rows; });
    await waiting;
    forgetDraft(`srv-${removed.id}`);
    const unrelated = createDraft(newFields(a!)); editDraft(unrelated, { bodyText: "live B" });
    editDraft(`srv-${stale.id}`, { bodyText: "local conflict copy" }); await flushDraft(`srv-${stale.id}`);
    const copied = useDrafts.getState().drafts[`srv-${stale.id}`]!;
    expect(copied.id).not.toBe(stale.id);
    release(); await pending;
    expect(useDrafts.getState().drafts[`srv-${first.id}`]).toMatchObject({ id: first.id, generation: first.generation, bodyText: "durable A" });
    expect(useDrafts.getState().drafts[`srv-${removed.id}`]).toBeUndefined();
    expect(useDrafts.getState().drafts[unrelated]?.bodyText).toBe("live B");
    expect(Object.values(useDrafts.getState().drafts).some((d) => d.id === stale.id)).toBe(false);
    expect(useDrafts.getState().drafts[`srv-${stale.id}`]).toMatchObject({ id: copied.id, bodyText: "local conflict copy" });
    // The exclusion belongs to that response; a distinct later explicit load can rediscover a durable row.
    await loadDrafts(() => client.call("drafts.list", {}));
    expect(useDrafts.getState().drafts[`srv-${removed.id}`]).toMatchObject({ id: removed.id, generation: removed.generation });
    expect(useDrafts.getState().drafts[`srv-${stale.id}`]).toMatchObject({ id: copied.id, bodyText: "local conflict copy" });
    expect(Object.values(useDrafts.getState().drafts).find((d) => d.id === stale.id)?.bodyText).toBe("other writer");
  } finally { release(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); c.close(); try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
});

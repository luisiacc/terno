// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";
it.each([false, true])("Strip coordinates the real Reader frame (later user control %s)", async (competing) => {
  const h = await setup("list"), load = deferred<ThreadDetail>(); gate.load.mockReturnValue(load.promise);
  try {
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus();
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull(); await h.flush();
    if (competing) h.other.focus();
    await act(async () => { h.useThreads.setState({ details: new Map([[7, h.detail]]) }); gate.load.mockResolvedValue(h.detail); load.resolve(h.detail); });
    for (let i = 0; i < 5; i++) await h.flush();
    if (competing) expect(document.activeElement).toBe(h.other);
    else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { load.resolve(h.detail); await h.cleanup(); }
});
it("an older strip lookup cannot override a newer actual keyboard Reply", async () => {
  const h = await setup("split", true), older = deferred<{ threadId: number; accountId: number }>(), newer = deferred<{ threadId: number; accountId: number }>();
  const { newFields } = await import("~/lib/compose-fields");
  const oldKey = h.drafts.createDraft({ ...newFields(1), threadId: null, mode: "reply", inReplyToMessageId: 4, showSourceContext: true, bodyText: "other authored work" });
  h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [oldKey]: { ...s.drafts[oldKey]!, id: 82, generation: "other", revision: 1, sourceContextThreadId: 8 } } }));
  gate.call.mockImplementation((method: string, p: { messageId: number }) => method === "drafts.sourceContext" ? p.messageId === 4 ? older.promise : newer.promise : Promise.resolve({}));
  try {
    await act(async () => {});
    const button = h.host.querySelector<HTMLButtonElement>(`[data-key="${oldKey}"]`)!; button.focus();
    await act(async () => button.click());
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
    expect(gate.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: 3 });
    await act(async () => older.resolve({ threadId: 8, accountId: 1 }));
    expect(h.app.getApp().selectedId).toBe(7); expect(h.app.getApp().draftShown?.key).not.toBe(oldKey);
    await act(async () => newer.resolve({ threadId: 7, accountId: 1 })); for (let i = 0; i < 5; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { older.resolve({ threadId: 8, accountId: 1 }); newer.resolve({ threadId: 7, accountId: 1 }); await h.cleanup(); }
});

it.each(["moved", "deleted", "saved merge"])("Strip revalidates a real SQL source %s while thread loading waits", async (change) => {
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { openDatabase, SqlMailStore, nodePlatform } = await import("@terno/db"), { BackendCore, plaintextCipher } = await import("../../../../packages/backend/src/core"), { RpcClient, createMemoryTransportPair } = await import("@terno/core/rpc"), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance");
  const dir = mkdtempSync(join(tmpdir(), "terno-strip-r1-")), path = join(dir, "mail.db");
  const providers: import("@terno/mail").ProviderRegistry = { create: () => { throw new Error("Unexpected provider"); }, connectGmail: async () => { throw new Error("Unexpected provider"); }, verifyImap: async () => { throw new Error("Unexpected provider"); } };
  const wire = () => { const store = new SqlMailStore(openDatabase(path)); const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false }); const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "strip-r1", origin: "renderer" }); return { store, backend, c, client: new RpcClient(c) }; };
  const real = wire(), calls: Promise<unknown>[] = []; const h = await setup("list"), load = deferred<void>(), entered = deferred<void>();
  try {
    const [a, b] = await withAccounts(real.store);
    await ingest(real.store, [msg({ accountId: a!, providerMsgId: "anchor", rfcMessageId: "anchor@example.test", attachments: [] }), msg({ accountId: a!, providerMsgId: "source", rfcMessageId: "source@example.test", attachments: [] })]);
    const old = await threadOf(real.store, "source"), source = (await real.store.threads.get(old))!.messages[0]!;
    const saved = (await real.client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", showSourceContext: true, inReplyToMessageId: source.id, bodyText: "exact real authored body" }))!;
    const local = h.drafts.fromServer(saved);
    await act(async () => { h.drafts.useDrafts.setState({ drafts: { [h.key]: { ...local, key: h.key } } }); h.app.setApp({ accounts: await real.store.accounts.list(), selectedId: null, readerOpen: false }); });
    gate.call.mockImplementation((method, params) => { const call = real.client.call(method, params); calls.push(call); return call; });
    if (change === "saved merge") {
      const { contract } = await import("@terno/core/rpc"), { closePage, openThread } = await import("~/lib/page");
      gate.load.mockImplementation(async (id: number) => real.store.threads.get(id));
      h.drafts.setDraftTransport((method, params) => method === "drafts.save" ? real.client.call(method, contract[method].params.parse(params)) : real.client.call(method, contract[method].params.parse(params)));
      await act(async () => { h.useThreads.setState({ details: new Map([[old, (await real.store.threads.get(old))!]]) }); openThread(old); });
      await ingest(real.store, [msg({ accountId: a!, providerMsgId: "bridge", references: ["anchor@example.test", "source@example.test"], attachments: [] })]);
      await act(async () => { h.drafts.editDraft(h.key, { bodyText: saved.bodyText }); await h.drafts.flushDraft(h.key); });
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ presentationThreadId: old, sourceContextThreadId: await threadOf(real.store, "bridge") });
      await act(async () => closePage());
      await ingest(real.store, [msg({ accountId: a!, providerMsgId: "unrelated", attachments: [] })]);
      expect(await threadOf(real.store, "unrelated")).toBe(old);
      await act(async () => { h.useThreads.setState({ details: new Map([[old, (await real.store.threads.get(old))!]]) }); openThread(old); });
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true })));
      for (let i = 0; i < 5; i++) await h.flush();
      expect(h.app.getApp().compose?.key).toBe(h.key);
      expect(Object.keys(h.drafts.useDrafts.getState().drafts)).toEqual([h.key]);
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ id: saved.id, generation: saved.generation, bodyText: saved.bodyText });
      return;
    }

    gate.load.mockImplementation(async (id: number) => { entered.resolve(); await load.promise; const detail = await real.client.call("threads.get", { threadId: id }); if (detail) h.useThreads.setState((s) => ({ details: new Map(s.details).set(id, detail) })); return detail; });
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus();
    await act(async () => button.click()); await entered.promise;
    expect(gate.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: source.id });
    if (change === "moved") await ingest(real.store, [msg({ accountId: a!, providerMsgId: "bridge", references: ["anchor@example.test", "source@example.test"], attachments: [] })]);
    else await real.store.sync.remove([source.id]);
    await ingest(real.store, [msg({ accountId: a!, providerMsgId: "unrelated", attachments: [] })]);
    expect(await threadOf(real.store, "unrelated")).toBe(old);
    await act(async () => load.resolve()); for (let i = 0; i < 5; i++) await h.flush();
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, old, null)).toBeNull();
    expect(h.app.getApp().compose?.key).toBe(h.key);
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ id: saved.id, generation: saved.generation, mode: saved.mode, threadId: saved.threadId, showSourceContext: true, bodyText: saved.bodyText });
    expect(Object.keys(h.drafts.useDrafts.getState().drafts)).toEqual([h.key]);
  } finally { load.resolve(); await h.cleanup(); await Promise.all(calls); real.c.close(); await real.backend.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["matched", "no selection", "newer", "control", "same key", "same key matched", "Back", "hold", "inert"])("stored standalone owns the real NewMessage frame after %s", async (scenario) => {
  const h = await setup("split", scenario !== "no selection"), waiting = deferred<ThreadDetail>(), newerContext = deferred<null>();
  gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
  try {
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    expect(h.app.getApp().compose?.key).toBe(h.key);
    if (scenario === "newer") {
      gate.load.mockReturnValue(waiting.promise);
      gate.call.mockImplementation((method: string) => method === "drafts.sourceContext" ? newerContext.promise : Promise.resolve({}));
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
    }
    if (scenario === "control") h.other.focus();
    if (scenario === "same key" || scenario === "same key matched") { await act(async () => button.click()); if (scenario === "same key") h.other.focus(); }
    if (scenario === "Back") { const { leaveNewDraft } = await import("~/lib/compose"); await act(async () => leaveNewDraft()); }
    if (scenario === "hold") await act(async () => h.drafts.useDrafts.setState({ held: true }));
    if (scenario === "inert") h.host.querySelector('[data-testid="composer"]')!.setAttribute("inert", "");
    for (let i = 0; i < 15; i++) await h.flush();
    if (scenario === "matched" || scenario === "same key matched" || scenario === "no selection") expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    else expect(document.activeElement?.closest('[data-testid="composer"]')).toBeNull();
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ bodyText: before.bodyText, mode: "reply", threadId: null, revision: 4, showSourceContext: true });
    if (scenario === "newer") { newerContext.resolve(null); waiting.resolve(h.detail); await act(async () => {}); }
  } finally { newerContext.resolve(null); waiting.resolve(h.detail); await act(async () => h.drafts.useDrafts.setState({ held: false })); await h.cleanup(); }
});

it("stored open cannot cancel a successor created by its synchronous UI publication", async () => {
  const h = await setup("list"), newerContext = deferred<{ threadId: number; accountId: number }>();
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  let newer: Promise<void> | undefined;
  h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [h.key]: { ...s.drafts[h.key]!, uiState: "collapsed" } } }));
  const off = h.drafts.useDrafts.subscribe((state, before) => {
    if (before.drafts[h.key]?.uiState === "collapsed" && state.drafts[h.key]?.uiState === "open") {
      off(); gate.call.mockImplementation((method: string) => method === "drafts.sourceContext" ? newerContext.promise : Promise.resolve({}));
      newer = openCompose("forward", 7);
    }
  });
  try {
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus();
    await act(async () => button.click());
    expect(composeFocusPending(7)).toBe(true);
    expect(h.app.getApp().draftFocus).toBeNull();
    await act(async () => { newerContext.resolve({ threadId: 7, accountId: 1 }); await newer; });
    for (let i = 0; i < 5; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
  } finally { off(); newerContext.resolve({ threadId: 7, accountId: 1 }); if (newer) await newer; await h.cleanup(); }
});

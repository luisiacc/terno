// @vitest-environment node
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { contract, createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
const renderer = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: renderer }));
const { openCompose, collapseInlineDraft, supersedeCompose } = await import("./compose");
const { editDraft, flushDraft, forgetDraft, loadDrafts, setDraftTransport, shownDraftKey, useDrafts } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const ordering of ["during lookup"] as const) {
  it(`${adapter}: same-mode Reply accepts ACK while the initial destination load is pending (${ordering})`, async () => {
    const previous = getApp(), previousThreads = useThreads.getState(), dir = mkdtempSync(join(tmpdir(), "terno-same-mode-ack-"));
    const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "same-mode-ack", origin: "renderer" }); const client = new RpcClient(c);
    const saveReached = gate(), saveRelease = gate(), sourceReached = gate(), sourceRelease = gate(), threadReached = gate(), threadRelease = gate();
    let targetLoads = 0, sourceCalls = 0;
    let key: string | undefined, opening: Promise<void> | undefined, armed = false, ack: Awaited<ReturnType<typeof client.call<"drafts.save">>> | undefined;
    const requests: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
    renderer.call.mockImplementation(async (method, params) => {
      if (method === "threads.get") targetLoads++;
      if (method === "drafts.sourceContext") sourceCalls++;
      const result = await client.call(method, params);
      if (method === "threads.get") { threadReached.resolve(); await threadRelease.promise; }
      if (method === "drafts.sourceContext") { sourceReached.resolve(); await sourceRelease.promise; }
      return result;
    });
    setDraftTransport(async (method, params) => {
      if (method !== "drafts.save") throw new Error(`Unexpected writer method ${method}`);
      const input = contract["drafts.save"].params.parse(params), result = await client.call("drafts.save", input);
      if (armed && !ack) { requests.push(input); ack = result; saveReached.resolve(); await saveRelease.promise; }
      return result;
    });
    try {
      const [account] = await withAccounts(store);
      await ingest(store, [msg({ accountId: account!, providerMsgId: "same-mode-source" })]);
      const threadId = await threadOf(store, "same-mode-source"), detail = (await store.threads.get(threadId))!;
      const saved = (await client.call("drafts.save", { accountId: account!, threadId, mode: "reply", inReplyToMessageId: detail.messages[0]!.id, showSourceContext: true, to: [{ name: "", email: "authored@example.test" }], bodyText: "original body", bodyHtml: "<p>original body</p>" }))!;
      expect(saved).toMatchObject({ accountId: account, threadId, mode: "reply", revision: 1, showSourceContext: true });
      useThreads.setState({ details: new Map() });
      setApp({ accounts: await store.accounts.list(), accountId: account!, selectedId: threadId, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: null, draftFocus: null, dialog: null, fatal: null });
      await loadDrafts(() => client.call("drafts.list", {}));
      key = shownDraftKey(useDrafts.getState().drafts, threadId, null)!; expect(key).toBeDefined();
      expect(useDrafts.getState().drafts[key]).toMatchObject({ id: saved.id, generation: saved.generation, revision: 1, mode: "reply", bodyText: "original body" });
      expect(editDraft(key, { bodyText: "edited work", bodyHtml: "<p><b>edited work</b></p>", toText: "authored@example.test" })).toBe(true);
      armed = true; expect(collapseInlineDraft(key)).toBeDefined();
      await saveReached.promise; expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ id: saved.id, generation: saved.generation, baseRevision: 1, mode: "reply", bodyText: "edited work" });
      expect(ack).toMatchObject({ id: saved.id, generation: saved.generation, revision: 2, mode: "reply", bodyText: "edited work" });
      opening = openCompose("reply", threadId);
      await Promise.race([threadReached.promise, opening.then(() => { throw new Error("Reply finished before actual destination gate"); })]);
      saveRelease.resolve(); await flushDraft(key);
      threadRelease.resolve();
      await Promise.race([sourceReached.promise, opening.then(() => { throw new Error("Reply finished before actual sourceContext gate"); })]);
      sourceRelease.resolve(); await opening;
      expect(targetLoads).toBe(1); expect(sourceCalls).toBe(1);
      const after = useDrafts.getState().drafts[key]!;
      expect(after).toMatchObject({ key, id: saved.id, generation: saved.generation, mode: "reply", bodyText: "edited work", bodyHtml: "<p><b>edited work</b></p>", toText: "authored@example.test", uiState: "open" });
      await flushDraft(key);
      const stored = (await client.call("drafts.list", {})).find((d) => d.id === saved.id);
      expect(stored).toMatchObject({ id: saved.id, generation: saved.generation, mode: "reply", bodyText: "edited work", bodyHtml: "<p><b>edited work</b></p>" });
    } finally {
      saveRelease.resolve(); sourceRelease.resolve(); threadRelease.resolve(); await Promise.allSettled(opening ? [opening] : []);
      supersedeCompose(); if (key) forgetDraft(key); renderer.call.mockReset(); setDraftTransport((method, params) => renderer.call(method, params));
      useThreads.setState(previousThreads, true); useApp.setState(previous, true); c.close();
      try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

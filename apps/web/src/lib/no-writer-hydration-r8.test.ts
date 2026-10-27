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
const { openCompose, supersedeCompose } = await import("./compose");
const { flushDraft, forgetDraft, loadDrafts, setDraftTransport, shownDraftKey, useDrafts } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { dismissSnack } = await import("./snack");
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const mode of ["replyAll", "forward"] as const) {
  it(`${adapter}: hydrated no-writer draft converts to ${mode} with its exact saved work`, async () => {
    const previous = getApp(), previousThreads = useThreads.getState();
    const dir = mkdtempSync(join(tmpdir(), "terno-r8-hydration-"));
    const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "r8-hydration", origin: "renderer" }); const client = new RpcClient(c);
    let key: string | undefined;
    renderer.call.mockImplementation((method, params) => client.call(method, params));
    setDraftTransport((method, params) => client.call(method, contract[method].params.parse(params)));
    try {
      const [accountId] = await withAccounts(store);
      await ingest(store, [msg({ accountId: accountId!, providerMsgId: "source", hasAttachments: true, attachments: [{ filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() }] })]);
      const threadId = await threadOf(store, "source"), detail = (await store.threads.get(threadId))!;
      const saved = (await client.call("drafts.save", { accountId: accountId!, threadId, mode: "reply", inReplyToMessageId: detail.messages[0]!.id, showSourceContext: false, to: [{ name: "", email: "authored@example.test" }], bodyText: "saved work", bodyHtml: "<p><b>saved work</b></p>" }))!;
      useThreads.setState({ details: new Map([[threadId, detail]]) });
      setApp({ accounts: await store.accounts.list(), accountId: accountId!, selectedId: threadId, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: null, draftFocus: null, dialog: null, fatal: null });
      await loadDrafts(() => client.call("drafts.list", {}));
      key = shownDraftKey(useDrafts.getState().drafts, threadId, null)!;
      expect(key).toBeTruthy();
      expect(useDrafts.getState().drafts[key]).toMatchObject({ id: saved.id, generation: saved.generation, revision: saved.revision, bodyText: "saved work", bodyHtml: "<p><b>saved work</b></p>", status: "saved" });
      await openCompose(mode, threadId);
      expect(useDrafts.getState().drafts[key]).toMatchObject({ id: saved.id, generation: saved.generation, mode, bodyText: "saved work", bodyHtml: "<p><b>saved work</b></p>" });
      if (mode === "forward") expect(useDrafts.getState().drafts[key]!.attachments).toHaveLength(1);
      await flushDraft(key);
      expect((await client.call("drafts.list", {}))[0]).toMatchObject({ id: saved.id, mode, bodyText: "saved work", bodyHtml: "<p><b>saved work</b></p>" });
    } finally {
      supersedeCompose(); if (key) forgetDraft(key); dismissSnack(); renderer.call.mockReset(); setDraftTransport((method, params) => renderer.call(method, params));
      useThreads.setState(previousThreads, true); useApp.setState(previous, true); c.close();
      try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

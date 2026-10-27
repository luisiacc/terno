// @vitest-environment node
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { contract, createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { parseAddressList } from "@terno/core";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
const renderer = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: renderer }));
const { openCompose, supersedeCompose } = await import("./compose");
const { attachBody, editDraft, flushDraft, forgetDraft, setDraftTransport, setDraftUi, shownDraftKey, useDrafts } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { dismissSnack, runUndo, useSnack } = await import("./snack");
const gate = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const saved of [false, true]) for (const scenario of ["body", "editor", "UI roundtrip", "conflict"] as const) {
  it(`${adapter}: ${saved ? "revision" : "first save"} empty-owner save handles ${scenario}`, async () => {
    const previous = getApp(), previousThreads = useThreads.getState();
    const dir = mkdtempSync(join(tmpdir(), "terno-forward-phase-"));
    const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "forward-phase", origin: "renderer" });
    const client = new RpcClient(c), savedResult = gate<void>(), deliverSave = gate<void>();
    let key: string | undefined, conversion: Promise<void> | undefined, bodySource: ReturnType<typeof attachBody> | undefined, arm = false, captured = false, requests = 0, editorBody = "before wait";
    const submitted: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
    let firstAck: { id: number; generation?: string; revision: number } | undefined;
    renderer.call.mockImplementation((method, params) => client.call(method, params));
    setDraftTransport(async (method, params) => {
      if (method !== "drafts.save") throw new Error(`Unexpected writer method ${method}`);
      requests++;
      const input = contract["drafts.save"].params.parse(params);
      if (arm) submitted.push(input);
      const result = await client.call("drafts.save", input);
      if (arm && !captured) { captured = true; expect(result).not.toBeNull(); firstAck = result!; savedResult.resolve(); await deliverSave.promise; }
      return result;
    });
    try {
      const [accountId] = await withAccounts(store);
      await ingest(store, [msg({ accountId: accountId!, providerMsgId: "source", hasAttachments: true, attachments: [{ filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() }] })]);
      const threadId = await threadOf(store, "source"), detail = (await store.threads.get(threadId))!;
      expect(detail.messages[0]?.attachments).toHaveLength(1);
      useThreads.setState({ details: new Map([[threadId, detail]]) });
      setApp({ accounts: await store.accounts.list(), accountId: accountId!, selectedId: threadId, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: null, draftFocus: null, dialog: null, fatal: null });
      await openCompose("reply", threadId);
      key = shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown)!;
      expect(key).toBeTruthy();
      editDraft(key, { bodyText: "before wait" });
      if (saved) { await flushDraft(key); editDraft(key, { bodyText: "before wait revised" }); }
      const before = useDrafts.getState().drafts[key]!;
      expect(before.id === null).toBe(!saved);
      requests = 0;
      if (scenario === "editor") bodySource = attachBody(key, () => ({ text: editorBody, html: `<p><b>${editorBody}</b></p>` }));
      arm = true;
      conversion = openCompose("forward", threadId);
      await Promise.race([savedResult.promise, conversion.then(() => { throw new Error("Forward finished before actual save response gate"); })]);
      expect(requests).toBe(1);
      expect(submitted[0]).toMatchObject({ accountId: accountId!, threadId, mode: "reply", attachments: [] });
      expect(submitted[0]!.id).toBe(before.id ?? undefined);
      expect(submitted[0]!.generation).toBe(before.generation);
      expect(submitted[0]!.baseRevision).toBe(saved ? before.revision : undefined);
      expect(firstAck).toMatchObject({ revision: before.revision + 1 });
      expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "reply", status: "saving", id: before.id, revision: before.revision, attachments: [] });
      expect(useDrafts.getState().drafts[key]!.generation).toBe(before.generation);
      if (scenario === "body") editDraft(key, { bodyText: "latest body", bodyHtml: "<p><b>latest body</b></p>", toText: "extra@example.test", subject: "latest subject", subjectEdited: true });
      else if (scenario === "editor") { editorBody = "intermediate"; bodySource!.changed(); editorBody = "latest body"; bodySource!.changed(); }
      else if (scenario === "UI roundtrip") { setDraftUi(key, "collapsed"); setDraftUi(key, "open"); }
      else {
        editDraft(key, { bodyText: "latest body", bodyHtml: "<p><b>latest body</b></p>" });
        const competing = await client.call("drafts.save", { ...submitted[0]!, id: firstAck!.id, generation: firstAck!.generation, baseRevision: firstAck!.revision, bodyText: "other writer" });
        expect(competing).toMatchObject({ id: firstAck!.id, generation: firstAck!.generation, revision: firstAck!.revision + 1 });
      }
      deliverSave.resolve(); await conversion;
      const after = useDrafts.getState().drafts[key]!;
      if (scenario === "body" || scenario === "editor") {
        expect(after).toMatchObject({ key, mode: "forward", bodyText: "latest body", bodyHtml: "<p><b>latest body</b></p>", ...(scenario === "body" ? { subject: "latest subject" } : {}) });
        expect(after.attachments).toHaveLength(1); expect(requests).toBeGreaterThanOrEqual(2);
        expect(submitted[1]).toMatchObject({ id: firstAck!.id, generation: firstAck!.generation, baseRevision: firstAck!.revision });
        if (scenario === "body") expect(parseAddressList(after.toText).map((address) => address.email)).toContain("extra@example.test");
        await flushDraft(key);
        expect((await client.call("drafts.list", {}))[0]).toMatchObject({ mode: "forward", bodyText: "latest body", bodyHtml: "<p><b>latest body</b></p>" });
        const undo = useSnack.getState().undo; expect(undo).not.toBeNull();
        await runUndo(undo!);
        expect(useDrafts.getState().drafts[key]).toMatchObject({ key, mode: "reply", bodyText: "latest body", bodyHtml: "<p><b>latest body</b></p>" });
      } else {
        expect(after).toMatchObject({ key, mode: "reply", attachments: [] });
        if (scenario === "conflict") { expect(after.bodyText).toBe("latest body"); expect(after.id).not.toBe(firstAck!.id); }
      }
    } finally {
      deliverSave.resolve(); await Promise.allSettled(conversion ? [conversion] : []);
      supersedeCompose(); if (key) forgetDraft(key); bodySource?.dispose(); dismissSnack(); renderer.call.mockReset();
      setDraftTransport((method, params) => renderer.call(method, params));
      useThreads.setState(previousThreads, true); useApp.setState(previous, true); c.close();
      try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

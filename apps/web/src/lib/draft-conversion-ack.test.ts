// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { contract, createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { parseAddressList } from "@terno/core";
import type { ProviderRegistry } from "@terno/mail";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
const renderer = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: renderer }));
const { collapseInlineDraft, openCompose, supersedeCompose } = await import("./compose");
const { editDraft, flushDraft, forgetDraft, setDraftTransport, shownDraftKey, useDrafts } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { dismissSnack, runUndo, useSnack } = await import("./snack");
const gate = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

for (const saved of [false, true]) for (const order of ["before", "during", "after"] as const) {
  it(`normal ${saved ? "revision" : "first-save"} ACK ${order} source lookup preserves an accepted conversion`, async () => {
    const previous = getApp(), previousThreads = useThreads.getState();
    const dir = mkdtempSync(join(tmpdir(), "terno-conversion-ack-"));
    const store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "conversion-ack", origin: "renderer" });
    const client = new RpcClient(c);
    const savedResult = gate<void>(), deliverSave = gate<void>(), contextResult = gate<void>(), deliverContext = gate<void>();
    let armSave = false, armContext = false, capturedSave = false, capturedContext = false;
    let key: string | undefined, saving: Promise<void> | undefined, conversion: Promise<void> | undefined;
    renderer.call.mockImplementation(async (method, params) => {
      const result = await client.call(method, params);
      if (method === "drafts.sourceContext" && armContext && !capturedContext) {
        capturedContext = true; contextResult.resolve(); await deliverContext.promise;
      }
      return result;
    });
    setDraftTransport(async (method, params) => {
      if (method !== "drafts.save") throw new Error(`Unexpected writer method ${method}`);
      const result = await client.call("drafts.save", contract["drafts.save"].params.parse(params));
      if (armSave && !capturedSave) {
        capturedSave = true; expect(result).not.toBeNull(); savedResult.resolve(); await deliverSave.promise;
      }
      return result;
    });
    try {
      const [accountId] = await withAccounts(store);
      await ingest(store, [msg({ accountId: accountId!, providerMsgId: "source", attachments: [] })]);
      const threadId = await threadOf(store, "source"), detail = (await store.threads.get(threadId))!;
      useThreads.setState({ details: new Map([[threadId, detail]]) });
      setApp({ accounts: await store.accounts.list(), accountId: accountId!, selectedId: threadId, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: null, draftFocus: null, dialog: null, fatal: null });
      await openCompose("reply", threadId);
      key = shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown)!;
      expect(key).toBeTruthy();
      editDraft(key, { bodyText: "Mi respuesta.", bodyHtml: "<p><b>Mi respuesta.</b></p>", toText: "extra@example.test" });
      if (saved) {
        await flushDraft(key);
        expect(useDrafts.getState().drafts[key]!.id).not.toBeNull();
        editDraft(key, { subject: "authored subject", subjectEdited: true });
      } else expect(useDrafts.getState().drafts[key]!.id).toBeNull();
      const before = useDrafts.getState().drafts[key]!;
      expect(before.showSourceContext).toBe(true);
      armSave = true;
      expect(collapseInlineDraft(key)).toBeTypeOf("function");
      saving = flushDraft(key);
      await Promise.race([savedResult.promise, saving.then(() => { throw new Error("Save returned before its expected acknowledgement gate"); })]);
      expect(useDrafts.getState().drafts[key]!.status).toBe("saving");
      if (order === "before") { deliverSave.resolve(); await saving; }
      armContext = true;
      conversion = openCompose("replyAll", threadId);
      await Promise.race([contextResult.promise, conversion.then(() => { throw new Error("Conversion finished before its expected real source lookup"); })]);
      if (order === "during") { deliverSave.resolve(); await saving; }
      deliverContext.resolve(); await conversion;
      const after = useDrafts.getState().drafts[key]!;
      expect(after).toMatchObject({ key, mode: "replyAll", uiState: "open", bodyText: before.bodyText, bodyHtml: before.bodyHtml });
      expect(parseAddressList(after.toText).map((address) => address.email)).toContain("extra@example.test");
      expect(Object.keys(useDrafts.getState().drafts)).toEqual([key]);
      expect(useSnack.getState().current?.message).toBe("Converted to reply all");
      const undo = useSnack.getState().undo; expect(undo).not.toBeNull();
      await runUndo(undo!);
      expect(useDrafts.getState().drafts[key]).toMatchObject({ key, mode: "reply", bodyText: before.bodyText, bodyHtml: before.bodyHtml, toText: before.toText });
      if (order === "after") { deliverSave.resolve(); await saving; }
      await flushDraft(key);
      expect((await client.call("drafts.list", {}))[0]).toMatchObject({ mode: "reply", bodyText: before.bodyText, bodyHtml: before.bodyHtml });
    } finally {
      deliverContext.resolve(); deliverSave.resolve();
      await Promise.allSettled([saving, conversion].filter((p): p is Promise<void> => p !== undefined));
      supersedeCompose(); if (key) forgetDraft(key); dismissSnack();
      renderer.call.mockReset(); setDraftTransport((method, params) => renderer.call(method, params));
      useThreads.setState(previousThreads, true); useApp.setState(previous, true); c.close();
      try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

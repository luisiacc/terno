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
const { editDraft, flushDraft, forgetDraft, loadDrafts, setDraftTransport, shownDraftKey, useDrafts } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { dismissSnack, runUndo, useSnack } = await import("./snack");
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const ordering of ["ACK before Forward", "ACK during Forward", "foreign refusal"] as const) {
  it(`${adapter}: reloaded canonical-null reply keeps work across ${ordering}`, async () => {
    const previous = getApp(), previousThreads = useThreads.getState();
    const dir = mkdtempSync(join(tmpdir(), "terno-cross-account-ack-"));
    const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "cross-account-ack", origin: "renderer" }); const client = new RpcClient(c);
    const reached = gate(), release = gate(); let key: string | undefined, conversion: Promise<void> | undefined, armed = false;
    const submissions: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
    let actualAck: Awaited<ReturnType<typeof client.call<"drafts.save">>> | undefined;
    renderer.call.mockImplementation((method, params) => client.call(method, params));
    setDraftTransport(async (method, params) => {
      if (method !== "drafts.save") throw new Error(`Unexpected writer method ${method}`);
      const input = contract["drafts.save"].params.parse(params);
      const result = await client.call("drafts.save", input);
      if (armed && !actualAck) { submissions.push(input); actualAck = result; reached.resolve(); await release.promise; }
      return result;
    });
    try {
      const [source, other] = await withAccounts(store);
      await ingest(store, [msg({ accountId: source!, providerMsgId: "cross-source", hasAttachments: true, attachments: [
        { filename: "binary.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) },
        { filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() },
      ] })]);
      const threadId = await threadOf(store, "cross-source"), detail = (await store.threads.get(threadId))!;
      const saved = (await client.call("drafts.save", { accountId: other!, threadId, mode: "reply", inReplyToMessageId: detail.messages[0]!.id, showSourceContext: true, to: [{ name: "", email: "authored@example.test" }], bodyText: "retained work", bodyHtml: "<p><b>retained work</b></p>" }))!;
      expect(saved).toMatchObject({ accountId: other, threadId: null, showSourceContext: true, presentationThreadId: threadId, revision: 1 });
      useThreads.setState({ details: new Map([[threadId, detail]]) });
      setApp({ accounts: await store.accounts.list(), accountId: source!, selectedId: threadId, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: null, draftFocus: null, dialog: null, fatal: null });
      await loadDrafts(() => client.call("drafts.list", {}));
      key = shownDraftKey(useDrafts.getState().drafts, threadId, null)!;
      expect(useDrafts.getState().drafts[key]).toMatchObject({ id: saved.id, generation: saved.generation, threadId: null, accountId: other, showSourceContext: true, revision: 1, status: "saved" });
      if (ordering !== "foreign refusal") expect(editDraft(key, { accountId: source! })).toBe(true);
      if (ordering === "ACK before Forward") await flushDraft(key);
      if (ordering === "ACK during Forward") armed = true;
      conversion = openCompose("forward", threadId);
      if (armed) {
        await Promise.race([reached.promise, conversion.then(() => { throw new Error("Forward finished before real save ACK gate"); })]);
        expect(submissions).toHaveLength(1);
        expect(submissions[0]).toMatchObject({ id: saved.id, generation: saved.generation, baseRevision: 1, accountId: source, threadId: null, showSourceContext: true });
        expect(actualAck).toMatchObject({ id: saved.id, generation: saved.generation, revision: 2, accountId: source, threadId: null, showSourceContext: true, presentationThreadId: threadId });
        expect(await client.call("drafts.sourceContext", { messageId: detail.messages[0]!.id })).toEqual({ accountId: source, threadId });
        release.resolve();
      }
      await conversion;
      const after = useDrafts.getState().drafts[key]!;
      expect(after).toMatchObject({ key, id: saved.id, generation: saved.generation, bodyText: "retained work", bodyHtml: "<p><b>retained work</b></p>", toText: "authored@example.test" });
      if (ordering === "foreign refusal") {
        expect(after).toMatchObject({ mode: "reply", accountId: other, attachments: [] });
        expect((await client.call("drafts.list", {}))[0]).toEqual(saved);
      } else {
        expect(after).toMatchObject({ mode: "forward", accountId: source });
        expect(after.attachments?.map((part) => part.filename)).toEqual(["binary.bin", "empty.txt"]);
        await flushDraft(key);
        expect((await client.call("drafts.list", {}))[0]).toMatchObject({ id: saved.id, mode: "forward", bodyText: "retained work" });
        expect(await store.attachments.read(source!, after.attachments![0]!.assetId, 0)).toBe("AP+A");
        const undo = useSnack.getState().undo; expect(undo).not.toBeNull(); await runUndo(undo!);
        expect(useDrafts.getState().drafts[key]).toMatchObject({ key, mode: "reply", bodyText: "retained work", bodyHtml: "<p><b>retained work</b></p>" });
      }
    } finally {
      release.resolve(); await Promise.allSettled(conversion ? [conversion] : []);
      supersedeCompose(); if (key) forgetDraft(key); dismissSnack(); renderer.call.mockReset(); setDraftTransport((method, params) => renderer.call(method, params));
      useThreads.setState(previousThreads, true); useApp.setState(previous, true); c.close();
      try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

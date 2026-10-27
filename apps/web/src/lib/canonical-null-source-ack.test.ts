// @vitest-environment node
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { contract, createMemoryTransportPair, RpcClient, type Draft } from "@terno/core/rpc";
import { nodePlatform, openDatabase, sqlDb, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";

const renderer = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: renderer }));
const { openCompose, supersedeCompose } = await import("./compose");
const { editDraft, flushDraft, forgetDraft, loadDrafts, setDraftTransport, setDraftUi, shownDraftKey, useDrafts } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const { invalidateThreads, useThreads } = await import("~/state/threads");
const { dismissSnack, runUndo, useSnack } = await import("./snack");
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };
const common = ["same source", "distinct sources", "original deleted", "final source deleted", "detail invalidated", "strict body reverted", "UI roundtrip", "navigation restored", "actual conflict copy", "missing save", "rejected save", "body during flush"] as const;
const sqlOnly = ["original moved", "original account mismatch", "projection mismatch", "initial original account mismatch"] as const;

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const scenario of [...common, ...(adapter === "SQL" ? sqlOnly : [])]) {
  it(`${adapter}: canonical-null conversion keeps ${scenario}`, async () => {
    const previous = getApp(), previousThreads = useThreads.getState();
    const dir = mkdtempSync(join(tmpdir(), "terno-canonical-null-source-"));
    const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "canonical-null-source", origin: "renderer" }); const client = new RpcClient(c);
    const saveReached = gate(), releaseSave = gate(), finalReached = gate(), releaseFinal = gate();
    let key: string | undefined, conversion: Promise<void> | undefined, armed = false, captured = false;
    let actualAck: Draft | null | undefined, actualFailure: unknown;
    const submissions: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
    const reads: Array<{ messageId: number; result: { threadId: number; accountId: number } | null }> = [];
    try {
      const [accountId, otherAccountId] = await withAccounts(store);
      await ingest(store, [
        msg({ accountId: accountId!, providerMsgId: "elsewhere", rfcMessageId: "elsewhere@example.test" }),
        msg({ accountId: accountId!, providerMsgId: "original", rfcMessageId: "original@example.test", date: 1 }),
        msg({ accountId: accountId!, providerMsgId: "answered", rfcMessageId: "answered@example.test", references: ["original@example.test"], date: 2, hasAttachments: true, attachments: [
          { filename: "binary.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) },
          { filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() },
        ] }),
      ]);
      const threadId = await threadOf(store, "original"), elsewhere = await threadOf(store, "elsewhere"), detail = (await store.threads.get(threadId))!;
      expect(await threadOf(store, "answered")).toBe(threadId);
      const older = detail.messages.find((m) => m.rfcMessageId === "original@example.test")!, answered = detail.messages.find((m) => m.rfcMessageId === "answered@example.test")!;
      expect(older.id).not.toBe(answered.id);
      const original = scenario === "same source" ? answered : older;
      const saved = (await client.call("drafts.save", { accountId: otherAccountId!, threadId, mode: "reply", inReplyToMessageId: original.id, forwardOfMessageId: answered.id, showSourceContext: true, to: [{ name: "", email: "authored@example.test" }, { name: "", email: "bob@" }], subject: "authored subject", subjectEdited: true, bodyText: "retained work", bodyHtml: "<p><b>retained work</b></p>" }))!;
      expect(saved).toMatchObject({ threadId: null, showSourceContext: true, presentationThreadId: threadId, revision: 1, inReplyToMessageId: original.id, forwardOfMessageId: answered.id });
      useThreads.setState({ details: new Map([[threadId, detail]]) });
      setApp({ accounts: await store.accounts.list(), accountId: accountId!, selectedId: threadId, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: null, draftFocus: null, dialog: null, fatal: null });
      await loadDrafts(() => client.call("drafts.list", {}));
      key = shownDraftKey(useDrafts.getState().drafts, threadId, null)!;
      expect(key).toBeTruthy(); expect(editDraft(key, { accountId: accountId! })).toBe(true);
      const moveOriginal = (target: number) => { if (!(store instanceof SqlMailStore)) throw new Error("SQL mutation fixture only"); sqlDb(store).run("UPDATE messages SET thread_id = ? WHERE id = ?", target, original.id); };
      const mismatchOriginal = (account: number) => { if (!(store instanceof SqlMailStore)) throw new Error("SQL mutation fixture only"); sqlDb(store).run("UPDATE messages SET account_id = ? WHERE id = ?", account, original.id); };
      const threadAccount = (account: number) => { if (!(store instanceof SqlMailStore)) throw new Error("SQL mutation fixture only"); sqlDb(store).run("UPDATE threads SET account_id = ? WHERE id = ?", account, threadId); };
      if (scenario === "initial original account mismatch") {
        mismatchOriginal(otherAccountId!);
        threadAccount(otherAccountId!);
      }
      renderer.call.mockImplementation(async (method, params) => {
        if (method !== "drafts.sourceContext") return client.call(method, params);
        const input = contract["drafts.sourceContext"].params.parse(params), result = await client.call("drafts.sourceContext", input);
        reads.push({ messageId: input.messageId, result });
        if (scenario === "initial original account mismatch" && reads.length === 1) {
          expect(result).toEqual({ threadId, accountId: otherAccountId });
          mismatchOriginal(accountId!);
          threadAccount(accountId!);
        }
        if ((scenario === "detail invalidated" || scenario === "strict body reverted") && reads.length === 2) { finalReached.resolve(); await releaseFinal.promise; }
        return result;
      });
      setDraftTransport(async (method, params) => {
        if (method !== "drafts.save") throw new Error(`Unexpected writer method ${method}`);
        const input = contract["drafts.save"].params.parse(params); submissions.push(input);
        if (armed && !captured) {
          captured = true;
          if (scenario === "actual conflict copy") expect(await client.call("drafts.save", { ...input, bodyText: "competing persisted work" })).toMatchObject({ id: saved.id, revision: 2 });
          if (scenario === "missing save") await client.call("drafts.delete", { id: saved.id, generation: saved.generation });
          if (scenario === "rejected save") await store.accounts.remove(accountId!);
          if (scenario === "projection mismatch") moveOriginal(elsewhere);
          try { actualAck = await client.call("drafts.save", input); } catch (error) { actualFailure = error; }
          saveReached.resolve(); await releaseSave.promise;
          if (actualFailure) throw actualFailure;
          return actualAck;
        }
        return client.call("drafts.save", input);
      });
      armed = scenario !== "initial original account mismatch";
      conversion = openCompose("forward", threadId);
      if (armed) {
        await Promise.race([saveReached.promise, conversion.then(() => { throw new Error("Forward finished before actual save response gate"); })]);
        expect(submissions[0]).toMatchObject({ id: saved.id, generation: saved.generation, baseRevision: 1, accountId, threadId: null, showSourceContext: true, inReplyToMessageId: original.id, forwardOfMessageId: answered.id });
        if (scenario === "missing save") expect(actualAck).toBeNull();
        else if (scenario === "rejected save") expect(actualFailure).toMatchObject({ code: "NOT_FOUND" });
        else if (scenario === "actual conflict copy") { expect(actualAck!.id).not.toBe(saved.id); expect(actualAck!.revision).toBe(1); }
        else expect(actualAck).toMatchObject({ id: saved.id, generation: saved.generation, revision: 2, accountId, threadId: null, showSourceContext: true, presentationThreadId: scenario === "projection mismatch" ? elsewhere : threadId });
        if (scenario === "original deleted") await store.sync.remove([original.id]);
        if (scenario === "final source deleted") await store.sync.remove([answered.id]);
        if (scenario === "original moved") moveOriginal(elsewhere);
        if (scenario === "original account mismatch") mismatchOriginal(otherAccountId!);
        if (scenario === "projection mismatch") moveOriginal(threadId);
        if (scenario === "UI roundtrip") { setDraftUi(key, "collapsed"); setDraftUi(key, "open"); }
        if (scenario === "navigation restored") { setApp({ selectedId: elsewhere }); setApp({ selectedId: threadId }); }
        if (scenario === "body during flush") expect(editDraft(key, { bodyText: "latest work", bodyHtml: "<p><b>latest work</b></p>" })).toBe(true);
        if (["original deleted", "original moved", "original account mismatch"].includes(scenario)) expect(await client.call("drafts.sourceContext", { messageId: answered.id })).toEqual({ threadId, accountId });
        releaseSave.resolve();
      }
      if (scenario === "detail invalidated" || scenario === "strict body reverted") {
        await Promise.race([finalReached.promise, conversion.then(() => { throw new Error("Forward finished before final metadata delivery gate"); })]);
        expect(reads[1]).toEqual({ messageId: answered.id, result: { threadId, accountId } });
        if (scenario === "detail invalidated") invalidateThreads([threadId]);
        else { editDraft(key, { bodyText: "temporary work" }); editDraft(key, { bodyText: "retained work", bodyHtml: "<p><b>retained work</b></p>" }); }
        releaseFinal.resolve();
      }
      await conversion;
      const after = useDrafts.getState().drafts[key]!;
      const expectedText = scenario === "body during flush" ? "latest work" : "retained work";
      expect(after).toMatchObject({ key, bodyText: expectedText, bodyHtml: `<p><b>${expectedText}</b></p>`, toText: "authored@example.test, bob@", subject: "authored subject" });
      const converted = scenario === "same source" || scenario === "distinct sources" || scenario === "body during flush";
      if (converted) {
        expect(after).toMatchObject({ id: saved.id, generation: saved.generation, mode: "forward", accountId, threadId: null });
        expect(reads.map((read) => read.messageId)).toEqual(original.id === answered.id ? [original.id, answered.id] : [original.id, answered.id, original.id]);
        expect(reads.every((read) => read.result?.threadId === threadId && read.result.accountId === accountId)).toBe(true);
        expect(after.attachments?.map((part) => part.filename)).toEqual(["binary.bin", "empty.txt"]);
        if (scenario === "body during flush") expect(submissions[1]).toMatchObject({ id: saved.id, generation: saved.generation, baseRevision: 2, bodyText: expectedText });
        await flushDraft(key);
        expect((await client.call("drafts.list", {}))[0]).toMatchObject({ id: saved.id, generation: saved.generation, mode: "forward", bodyText: expectedText, bodyHtml: after.bodyHtml });
        expect(await store.attachments.read(accountId!, after.attachments![0]!.assetId, 0)).toBe("AP+A");
        const undo = useSnack.getState().undo; expect(undo).not.toBeNull(); await runUndo(undo!);
        expect(useDrafts.getState().drafts[key]).toMatchObject({ id: saved.id, generation: saved.generation, mode: "reply", bodyText: expectedText, bodyHtml: after.bodyHtml, inReplyToMessageId: original.id, forwardOfMessageId: answered.id });
        await flushDraft(key);
        expect((await client.call("drafts.list", {}))[0]).toMatchObject({ id: saved.id, generation: saved.generation, mode: "reply", bodyText: expectedText });
      } else {
        expect(after).toMatchObject({ mode: "reply", attachments: [] });
        if (scenario !== "actual conflict copy") expect(after).toMatchObject({ id: saved.id, generation: saved.generation });
        else expect(after.id).not.toBe(saved.id);
        expect(useSnack.getState().undo).toBeNull(); expect(getApp().draftFocus).toBeNull();
      }
    } finally {
      releaseSave.resolve(); releaseFinal.resolve(); await Promise.allSettled(conversion ? [conversion] : []);
      supersedeCompose(); if (key) forgetDraft(key); dismissSnack(); renderer.call.mockReset(); setDraftTransport((method, params) => renderer.call(method, params));
      useThreads.setState(previousThreads, true); useApp.setState(previous, true); c.close();
      try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

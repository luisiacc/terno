// @vitest-environment node
// A draft's acknowledgement against a real backend and store while compose converts or reopens it.
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAddressList } from "@terno/core";
import { RpcClient, contract, createMemoryTransportPair } from "@terno/core/rpc";
import { SqlMailStore, nodePlatform, openDatabase } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import type { ProviderRegistry } from "@terno/mail";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { describe, expect, it, vi } from "vitest";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";

const renderer = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: renderer }));
const { openCompose, collapseInlineDraft, supersedeCompose } = await import("./compose");
const { editDraft, flushDraft, forgetDraft, loadDrafts, setDraftTransport, shownDraftKey, useDrafts, setDraftUi } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useThreads, invalidateThreads } = await import("~/state/threads");
const { dismissSnack, runUndo, useSnack } = await import("./snack");

describe("same-mode acknowledgement", () => {
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

  for (const adapter of ["SQL", "IDB"] as const) for (const ordering of ["before lookup", "during lookup", "after open"] as const) {
    it(`${adapter}: same-mode Reply retains an ordinary ACK ${ordering}`, async () => {
      const previous = getApp(), previousThreads = useThreads.getState(), dir = mkdtempSync(join(tmpdir(), "terno-same-mode-ack-"));
      const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
      const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
      const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "same-mode-ack", origin: "renderer" }); const client = new RpcClient(c);
      const saveReached = gate(), saveRelease = gate(), sourceReached = gate(), sourceRelease = gate();
      let key: string | undefined, opening: Promise<void> | undefined, armed = false, ack: Awaited<ReturnType<typeof client.call<"drafts.save">>> | undefined;
      const requests: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
      renderer.call.mockImplementation(async (method, params) => {
        const result = await client.call(method, params);
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
        useThreads.setState({ details: new Map([[threadId, detail]]) });
        setApp({ accounts: await store.accounts.list(), accountId: account!, selectedId: threadId, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: null, draftFocus: null, dialog: null, fatal: null });
        await loadDrafts(() => client.call("drafts.list", {}));
        key = shownDraftKey(useDrafts.getState().drafts, threadId, null)!; expect(key).toBeDefined();
        expect(useDrafts.getState().drafts[key]).toMatchObject({ id: saved.id, generation: saved.generation, revision: 1, mode: "reply", bodyText: "original body" });
        expect(editDraft(key, { bodyText: "edited work", bodyHtml: "<p><b>edited work</b></p>", toText: "authored@example.test" })).toBe(true);
        armed = true; expect(collapseInlineDraft(key)).toBeDefined();
        await saveReached.promise; expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ id: saved.id, generation: saved.generation, baseRevision: 1, mode: "reply", bodyText: "edited work" });
        expect(ack).toMatchObject({ id: saved.id, generation: saved.generation, revision: 2, mode: "reply", bodyText: "edited work" });
        if (ordering === "before lookup") { saveRelease.resolve(); await flushDraft(key); }
        opening = openCompose("reply", threadId);
        await Promise.race([sourceReached.promise, opening.then(() => { throw new Error("Reply finished before real sourceContext gate"); })]);
        if (ordering === "during lookup") { saveRelease.resolve(); await flushDraft(key); }
        sourceRelease.resolve(); await opening;
        if (ordering === "after open") { saveRelease.resolve(); await flushDraft(key); }
        const after = useDrafts.getState().drafts[key]!;
        expect(after).toMatchObject({ key, id: saved.id, generation: saved.generation, mode: "reply", bodyText: "edited work", bodyHtml: "<p><b>edited work</b></p>", toText: "authored@example.test", uiState: "open" });
        await flushDraft(key);
        const stored = (await client.call("drafts.list", {})).find((d) => d.id === saved.id);
        expect(stored).toMatchObject({ id: saved.id, generation: saved.generation, mode: "reply", bodyText: "edited work", bodyHtml: "<p><b>edited work</b></p>" });
      } finally {
        saveRelease.resolve(); sourceRelease.resolve(); await Promise.allSettled(opening ? [opening] : []);
        supersedeCompose(); if (key) forgetDraft(key); renderer.call.mockReset(); setDraftTransport((method, params) => renderer.call(method, params));
        useThreads.setState(previousThreads, true); useApp.setState(previous, true); c.close();
        try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    });
  }
});

describe("same-mode acknowledgement during a thread load", () => {
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

  for (const adapter of ["SQL", "IDB"] as const) for (const ordering of ["during lookup"] as const) {
    it(`${adapter}: same-mode Reply loads an uncached destination with ACK ${ordering}`, async () => {
      const previous = getApp(), previousThreads = useThreads.getState(), dir = mkdtempSync(join(tmpdir(), "terno-same-mode-ack-"));
      const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
      const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
      const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "same-mode-ack", origin: "renderer" }); const client = new RpcClient(c);
      const saveReached = gate(), saveRelease = gate(), sourceReached = gate(), sourceRelease = gate();
      let targetLoads = 0, sourceCalls = 0;
      let key: string | undefined, opening: Promise<void> | undefined, armed = false, ack: Awaited<ReturnType<typeof client.call<"drafts.save">>> | undefined;
      const requests: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
      renderer.call.mockImplementation(async (method, params) => {
        if (method === "threads.get") targetLoads++;
        if (method === "drafts.sourceContext") sourceCalls++;
        const result = await client.call(method, params);
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
        await Promise.race([sourceReached.promise, opening.then(() => { throw new Error("Reply finished before real sourceContext gate"); })]);
        saveRelease.resolve(); await flushDraft(key);
        sourceRelease.resolve(); await opening;
        expect(targetLoads).toBe(1); expect(sourceCalls).toBe(1);
        const after = useDrafts.getState().drafts[key]!;
        expect(after).toMatchObject({ key, id: saved.id, generation: saved.generation, mode: "reply", bodyText: "edited work", bodyHtml: "<p><b>edited work</b></p>", toText: "authored@example.test", uiState: "open" });
        await flushDraft(key);
        const stored = (await client.call("drafts.list", {})).find((d) => d.id === saved.id);
        expect(stored).toMatchObject({ id: saved.id, generation: saved.generation, mode: "reply", bodyText: "edited work", bodyHtml: "<p><b>edited work</b></p>" });
      } finally {
        saveRelease.resolve(); sourceRelease.resolve(); await Promise.allSettled(opening ? [opening] : []);
        supersedeCompose(); if (key) forgetDraft(key); renderer.call.mockReset(); setDraftTransport((method, params) => renderer.call(method, params));
        useThreads.setState(previousThreads, true); useApp.setState(previous, true); c.close();
        try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    });
  }
});

describe("same-mode acknowledgement during the initial load", () => {
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

  for (const adapter of ["SQL", "IDB"] as const) for (const ordering of ["during lookup"] as const) {
    it(`${adapter}: same-mode Reply accepts ACK while the initial destination load is pending (${ordering})`, async () => {
      const previous = getApp(), previousThreads = useThreads.getState(), dir = mkdtempSync(join(tmpdir(), "terno-same-mode-ack-"));
      const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
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
});

describe("same-mode acknowledgement guards", () => {
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

  for (const adapter of ["SQL", "IDB"] as const) for (const change of ["body", "source", "navigation", "ui", "invalidate", "ui-reentrant", "wrong-account"] as const) {
    it(`${adapter}: same-mode Reply preserves later ${change} during lookup`, async () => {
      const previous = getApp(), previousThreads = useThreads.getState(), dir = mkdtempSync(join(tmpdir(), "terno-same-mode-ack-"));
      const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
      const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
      const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "same-mode-ack", origin: "renderer" }); const client = new RpcClient(c);
      const saveReached = gate(), saveRelease = gate(), sourceReached = gate(), sourceRelease = gate();
      let targetLoads = 0;
      let key: string | undefined, opening: Promise<void> | undefined, armed = false, ack: Awaited<ReturnType<typeof client.call<"drafts.save">>> | undefined;
      const requests: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
      renderer.call.mockImplementation(async (method, params) => {
        if (method === "threads.get") targetLoads++;
        const result = await client.call(method, params);
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
        useThreads.setState({ details: new Map([[threadId, change === "wrong-account" ? { ...detail, thread: { ...detail.thread, accountId: -1 } } : detail]]) });
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
        await Promise.race([sourceReached.promise, opening.then(() => { throw new Error("Reply finished before real sourceContext gate"); })]);
        saveRelease.resolve(); await flushDraft(key);
        if (change === "body") expect(editDraft(key, { bodyText: "later work", bodyHtml: "<p>later work</p>" })).toBe(true);
        if (change === "source") expect(editDraft(key, { showSourceContext: false })).toBe(true);
        if (change === "navigation") setApp({ selectedId: null, readerOpen: false });
        if (change === "ui") setDraftUi(key, "open");
        if (change === "invalidate") invalidateThreads([threadId]);
        let nested = false;
        const off = useDrafts.subscribe((state, previous) => {
          if (change === "ui-reentrant" && !nested && previous.drafts[key!]?.uiState === "collapsed" && state.drafts[key!]?.uiState === "open") {
            nested = true;
            editDraft(key!, { bodyText: "nested work", bodyHtml: "<p>nested work</p>" });
            editDraft(key!, { bodyText: "edited work", bodyHtml: "<p><b>edited work</b></p>" });
          }
        });
        try { sourceRelease.resolve(); await opening; } finally { off(); }
        if (change === "ui-reentrant") expect(nested).toBe(true);
        const after = useDrafts.getState().drafts[key]!;
        expect(after).toMatchObject({ key, id: saved.id, generation: saved.generation, mode: "reply", toText: "authored@example.test" });
        if (change === "body") expect(after).toMatchObject({ bodyText: "later work", bodyHtml: "<p>later work</p>", uiState: "collapsed" });
        if (change === "source") expect(after).toMatchObject({ showSourceContext: false, bodyText: "edited work", uiState: "collapsed" });
        if (change === "navigation") { expect(getApp().selectedId).toBeNull(); expect(after.uiState).toBe("collapsed"); }
        if (change === "ui" || change === "ui-reentrant") expect(after.uiState).toBe("open");
        if (change === "invalidate") { expect(targetLoads).toBe(1); expect(after.uiState).toBe("collapsed"); }
        if (change === "wrong-account") { expect(targetLoads).toBe(0); expect(after.uiState).toBe("collapsed"); }
        expect(getApp().draftFocus).toBeNull();

      } finally {
        saveRelease.resolve(); sourceRelease.resolve(); await Promise.allSettled(opening ? [opening] : []);
        supersedeCompose(); if (key) forgetDraft(key); renderer.call.mockReset(); setDraftTransport((method, params) => renderer.call(method, params));
        useThreads.setState(previousThreads, true); useApp.setState(previous, true); c.close();
        try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    });
  }
});

describe("a conversion's acknowledgement on SQL", () => {
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
});

describe("a conversion's acknowledgement on IndexedDB", () => {
  const gate = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

  for (const saved of [false, true]) for (const order of ["before", "during", "after"] as const) {
    it(`IDB normal ${saved ? "revision" : "first-save"} ACK ${order} source lookup preserves an accepted conversion`, async () => {
      const previous = getApp(), previousThreads = useThreads.getState();
      const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
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
        await backend.stop();
      }
    });
  }
});

describe("Forward across accounts", () => {
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

  for (const adapter of ["SQL", "IDB"] as const) for (const ordering of ["ACK before Forward", "ACK during Forward", "foreign refusal"] as const) {
    it(`${adapter}: reloaded canonical-null reply keeps work across ${ordering}`, async () => {
      const previous = getApp(), previousThreads = useThreads.getState();
      const dir = mkdtempSync(join(tmpdir(), "terno-cross-account-ack-"));
      const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
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
});

describe("hydrated work with no writer", () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

  for (const adapter of ["SQL", "IDB"] as const) for (const mode of ["replyAll", "forward"] as const) {
    it(`${adapter}: hydrated no-writer draft converts to ${mode} with its exact saved work`, async () => {
      const previous = getApp(), previousThreads = useThreads.getState();
      const dir = mkdtempSync(join(tmpdir(), "terno-r8-hydration-"));
      const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
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
});

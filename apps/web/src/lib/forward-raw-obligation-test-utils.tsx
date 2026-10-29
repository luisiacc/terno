// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as nativeSetTimeout, clearTimeout as nativeClearTimeout } from "node:timers";
import { join } from "node:path";
import { contract, createMemoryTransportPair, RpcClient, type Draft as RpcDraft } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import { newFields } from "./compose-fields";
import { openCompose, supersedeCompose } from "./compose";
import { beginComposeBodyAckRead, beginForwardEmptyOwnerRead, createDraft, editDraft, endDraftAckRead, flushDraft, forgetDraft, recipients, setDraftTransport, shownDraftKey, useDrafts, type DraftAckRead } from "./drafts";
import { getApp, setApp, useApp } from "~/state/app";
import { useThreads } from "~/state/threads";
import { dismissSnack } from "./snack";

const renderer = vi.hoisted(() => ({ call: vi.fn() }));
const authorEntry = vi.hoisted(() => ({ next: undefined as ((returnedAuthor: boolean | "threw") => void) | undefined }));
const construction = vi.hoisted(() => ({ cleanupErrors: [] as unknown[], beforeView: null as (() => void) | null, registered: null as ((key: string, c: import("../components/composer/controller").ComposerController) => void) | null }));
vi.mock("~/rpc/connection", () => ({ client: renderer }));
vi.mock("./drafts", async (original) => {
  const actual = await original<typeof import("./drafts")>();
  return { ...actual, beginForwardEmptyOwnerRead: (...args: Parameters<typeof actual.beginForwardEmptyOwnerRead>) => {
    const notify = authorEntry.next;
    if (notify) authorEntry.next = undefined;
    let result: ReturnType<typeof actual.beginForwardEmptyOwnerRead>;
    try { result = actual.beginForwardEmptyOwnerRead(...args); }
    catch (error) { notify?.("threw"); throw error; }
    notify?.(result !== undefined);
    return result;
  } };
});
vi.mock("../components/composer/editor", async (original) => {
  const actual = await original<typeof import("../components/composer/editor")>();
  return { ...actual, createEditor: (...args: Parameters<typeof actual.createEditor>) => {
    construction.beforeView?.();
    return actual.createEditor(...args);
  } };
});
vi.mock("../components/composer/controller", async (original) => {
  const actual = await original<typeof import("../components/composer/controller")>();
  return { ...actual, registerController: (...args: Parameters<typeof actual.registerController>) => {
    const off = actual.registerController(...args);
    try { construction.registered?.(...args); return off; }
    catch (error) { try { off(); } catch (cleanupError) { construction.cleanupErrors.push(cleanupError); } throw error; }
  } };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };
type Adapter = "SQL" | "IDB exact" | "IDB instant";
export const body = { bodyText: "raw authored work", bodyHtml: "<p>raw authored work</p>" };

type FixtureUnavailableReason = "NATIVE_DEADLINE" | "ACQUISITION_FAILED" | "RETIREMENT_FAILED" | "CLEANUP_NOT_TERMINAL" | "IDB_DELETE_BLOCKED" | "IDB_DELETE_FAILED" | "IDB_DELETE_TIMEOUT";
let fixtureUnavailable: Readonly<{ reason: FixtureUnavailableReason }> | undefined;
const quarantineFixtures = (reason: FixtureUnavailableReason) => {
  if (fixtureUnavailable) return;
  fixtureUnavailable = { reason };
  console.error(`TERNO_RAW_TRANSFER_FIXTURE_UNAVAILABLE:${reason}`);
};
class NativeWatchdog extends Error {}
type Draft = NonNullable<ReturnType<typeof useDrafts.getState>["drafts"][string]>;
const nativeDeadline = async <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof nativeSetTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = nativeSetTimeout(() => reject(new NativeWatchdog(`Native watchdog: ${label}`)), ms); })]); }
  finally { if (timer) nativeClearTimeout(timer); }
};

export async function fixture(adapter: Adapter, saved: boolean, threaded: boolean, run: (f: {
  key: string;
  threadId: number | undefined;
  before: Draft;
  current(): Draft;
  admit(): DraftAckRead | undefined;
  exchange(token: DraftAckRead): DraftAckRead | undefined;
  mount(): Promise<void>;
  unmount(): Promise<void>;
  requests: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>>;
  controller(): ReturnType<typeof import("../components/composer/controller")["controllerFor"]>;
  armSave(): void;
  armContext(): void;
  armAuthor(): void;
  authorEntered: Promise<boolean | "threw">;
  authorObservations(): number;
  saveEntered: ReturnType<typeof gate>;
  saveRelease: ReturnType<typeof gate>;
  contextEntered: ReturnType<typeof gate>;
  contextRelease: ReturnType<typeof gate>;
  counts(): { saveGates: number; contextGates: number; replyAckDelivered: boolean };
  armedSaves: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>>;
  work<T>(promise: Promise<T>): Promise<T>;
  list(): Promise<RpcDraft[]>;
  reopen(expected: Draft, rawWitness?: boolean): Promise<Awaited<ReturnType<SqlMailStore["drafts"]["list"]>>[number] | undefined>;
}) => Promise<void>, options: { body?: typeof body; pendingEdit?: boolean } = {}): Promise<void> {
  // The receipt is never reset: no later case may touch globals or acquire resources after uncertainty.
  if (fixtureUnavailable) throw new Error(`TERNO_RAW_TRANSFER_FIXTURE_UNAVAILABLE:${fixtureUnavailable.reason}`);
  const previous = getApp(), previousThreads = useThreads.getState();
  const draftBody = options.body ?? body;
  const dir = mkdtempSync(join(tmpdir(), "terno-raw-transfer-r6-")), dbPath = join(dir, "mail.db"), idbName = crypto.randomUUID();
  let store: SqlMailStore | IdbMailStore | undefined, backend: BackendCore | undefined;
  let dbHandle: ReturnType<typeof openDatabase> | undefined;
  let client: RpcClient | undefined, transport: ReturnType<typeof createMemoryTransportPair>[0] | undefined;
  let host: HTMLDivElement | undefined, root: ReturnType<typeof createRoot> | undefined;
  let raf: { mockRestore(): void } | undefined, cancel: { mockRestore(): void } | undefined;
  let key: string | undefined, threadId: number | undefined, unmounted = false;
  let RichBody: typeof import("../components/composer/rich")["RichBody"] | undefined;
  let controllerFor: typeof import("../components/composer/controller")["controllerFor"] | undefined;
  let PaneBoundary: typeof import("../components/diag/error-boundary")["PaneBoundary"] | undefined;
  const pending = new Set<Promise<unknown>>(), operations = new Set<Promise<unknown>>(), acquisitions = new Set<Promise<void>>();
  let scenario: Promise<void> | undefined, scenarioSettled = false;
  const errors: Array<{ method: string; error: unknown }> = [], operationErrors: unknown[] = [], cleanupErrors: unknown[] = [];
  const outcomes: Array<{ method: string; ok: boolean }> = [], tokens: DraftAckRead[] = [];
  const armedSaves: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [], requests: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  const saveEntered = gate(), saveRelease = gate(), contextEntered = gate(), contextRelease = gate();
  let resolveAuthor!: (returnedAuthor: boolean | "threw") => void;
  const authorEntered = new Promise<boolean | "threw">((resolve) => { resolveAuthor = resolve; });
  let authorWitness: ((returnedAuthor: boolean | "threw") => void) | undefined, authorObservations = 0;
  let saveArmed = false, contextArmed = false, saveGates = 0, contextGates = 0, replyAckDelivered = false;
  let stopAttempted = false, closedOwners = 0, openedOwners = 0, quarantined = false, primary: { error: unknown } | undefined, backendConstructing = false;
  const observe = <T,>(method: string, start: () => Promise<T>): Promise<T> => {
    let request: Promise<T>;
    try { request = start(); }
    catch (error) { errors.push({ method, error }); throw error; }
    pending.add(request);
    void request.then((result) => { pending.delete(request); outcomes.push({ method, ok: result !== null }); }, (error: unknown) => { pending.delete(request); errors.push({ method, error }); });
    return request;
  };
  const work = <T,>(promise: Promise<T>): Promise<T> => {
    operations.add(promise);
    void promise.then(() => operations.delete(promise), (error: unknown) => { operations.delete(promise); operationErrors.push(error); });
    return promise;
  };
  const releaseGates = () => { saveRelease.resolve(); contextRelease.resolve(); };
  const unmount = async () => { if (root && !unmounted) { await act(async () => root!.unmount()); unmounted = true; } };
  const openOwner = () => {
    const opening = (async () => {
    // Every acquisition is assigned immediately and belongs to the enclosing finally.
    if (adapter === "SQL") { dbHandle = openDatabase(dbPath); store = new SqlMailStore(dbHandle); }
    else store = await IdbMailStore.open({ name: idbName, factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    stopAttempted = false;
    backendConstructing = true;
    backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    backendConstructing = false; openedOwners++;
    const [c, s] = createMemoryTransportPair(); transport = c;
    backend.connect(s, { clientId: `raw-transfer-r6-${openedOwners}`, origin: "renderer" }); client = new RpcClient(c);
    })();
    acquisitions.add(opening);
    void opening.then(() => acquisitions.delete(opening), (error: unknown) => { acquisitions.delete(opening); operationErrors.push(error); quarantined = true; quarantineFixtures("ACQUISITION_FAILED"); });
    return nativeDeadline(opening, 3000, "owner acquisition");
  };
  const stopOwner = async () => {
    if (stopAttempted) { if (backend || store) throw new Error("Owner shutdown previously incomplete"); return; }
    stopAttempted = true;
    let failed: { error: unknown } | undefined;
    try { if (client) client.close(); else transport?.close(); } catch (error) { failed = { error }; }
    client = undefined; transport = undefined;
    try {
      if (backend) {
        await backend.stop(); // Includes awaited store.close; no new live owner before resolution.
        backend = undefined; store = undefined; dbHandle = undefined; closedOwners++;
      } else if (store) { await store.close(); store = undefined; dbHandle = undefined; }
      else if (dbHandle) { dbHandle.close(); dbHandle = undefined; }
    } catch (error) { cleanupErrors.push(error); failed ??= { error }; }
    if (failed) throw failed.error;
  };
  const retireRenderer = async () => {
    let failed: { error: unknown } | undefined;
    for (const token of tokens) { try { endDraftAckRead(token); } catch (error) { failed ??= { error }; } }
    try { supersedeCompose(); } catch (error) { failed ??= { error }; }
    try { await unmount(); } catch (error) { failed ??= { error }; }
    try { if (key) { forgetDraft(key); key = undefined; } } catch (error) { failed ??= { error }; }
    try { dismissSnack(); } catch (error) { failed ??= { error }; }
    try { useThreads.setState(previousThreads, true); useApp.setState(previous, true); }
    catch (error) { failed ??= { error }; }
    while (pending.size) await Promise.allSettled(pending);
    if (failed) throw failed.error;
  };
  try {
    expect(construction.cleanupErrors).toEqual([]);
    await openOwner();
    renderer.call.mockImplementation((method, params) => {
      const request = observe(String(method), () => client!.call(method, params));
      if (method !== "drafts.sourceContext" || !contextArmed || !replyAckDelivered || contextGates) return request;
      return observe("held sourceContext response", async () => {
        const result = await request; expect(result).not.toBeNull();
        contextGates++; contextEntered.resolve(); await contextRelease.promise; return result;
      });
    });
    setDraftTransport((method, params) => {
      if (method !== "drafts.save") throw new Error("Unexpected raw-transfer writer method");
      const input = contract["drafts.save"].params.parse(params); requests.push(input); if (saveArmed) armedSaves.push(input);
      return observe("writer response", async () => {
        const result = await observe("drafts.save", () => client!.call("drafts.save", input));
        if (saveArmed && !saveGates) {
          expect(result).not.toBeNull(); saveGates++; saveEntered.resolve(); await saveRelease.promise;
          if (input.mode === "reply") replyAckDelivered = true;
        }
        return result;
      });
    }, Date.now);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++next, callback); return next; });
    cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    ({ RichBody } = await import("../components/composer/rich"));
    ({ controllerFor } = await import("../components/composer/controller"));
    ({ PaneBoundary } = await import("../components/diag/error-boundary"));
    const [accountId] = await withAccounts(store!);
    if (threaded) {
      await ingest(store!, [msg({ accountId: accountId!, providerMsgId: "raw-source", hasAttachments: true, attachments: [{ filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() }] })]);
      threadId = await threadOf(store!, "raw-source"); const detail = (await store!.threads.get(threadId))!;
      expect(detail.messages[0]?.attachments).toHaveLength(1); useThreads.setState({ details: new Map([[threadId, detail]]) });
      setApp({ accounts: await store!.accounts.list(), accountId: accountId!, selectedId: threadId, readerOpen: true, compose: null, checked: new Set(), scope: null, draftShown: null, draftFocus: null, dialog: null, fatal: null });
    }
    if (threaded) {
      await openCompose("reply", threadId!); key = shownDraftKey(useDrafts.getState().drafts, threadId!, getApp().draftShown)!;
      expect(key).toBeTruthy(); expect(editDraft(key, draftBody)).toBe(true);
    } else {
      key = createDraft({ ...newFields(accountId!), ...draftBody, toText: "authored@example.test" });
      expect(editDraft(key, { subject: "authored subject", subjectEdited: true })).toBe(true);
    }
    if (saved) { await flushDraft(key); if (options.pendingEdit !== false) expect(editDraft(key, { subject: "pending subject", subjectEdited: true })).toBe(true); }
    const target = key, before = useDrafts.getState().drafts[target]!;
    expect(before.id === null).toBe(!saved); expect(controllerFor!(target)).toBeNull();
    const mount = async () => {
      if (unmounted) { root = createRoot(host!); unmounted = false; }
      const R = RichBody!, P = PaneBoundary!;
      await act(async () => root!.render(<P area="settings"><R draftKey={target} placeholder="Body" /></P>));
    };
    scenario = run({ key: target, threadId, before, current: () => useDrafts.getState().drafts[target]!,
      admit: () => { const a = beginComposeBodyAckRead(useDrafts.getState().drafts[target]!); const token = a.kind === "proof" ? a.proof : a.kind === "no-writer" ? a.continuity : undefined; if (token) tokens.push(token); return token; },
      exchange: (token) => { const phase = beginForwardEmptyOwnerRead(token); if (phase) tokens.push(phase); return phase; }, mount, unmount, requests,
      controller: () => controllerFor!(target),
      armSave: () => { expect(saveArmed).toBe(false); saveArmed = true; }, armContext: () => { contextArmed = true; },
      armAuthor: () => {
        expect(authorWitness).toBeUndefined(); expect(authorEntry.next).toBeUndefined();
        authorWitness = (returnedAuthor) => { authorObservations++; resolveAuthor(returnedAuthor); };
        authorEntry.next = authorWitness;
      }, authorEntered, authorObservations: () => authorObservations,
      saveEntered, saveRelease, contextEntered, contextRelease, armedSaves,
      counts: () => ({ saveGates, contextGates, replyAckDelivered }), work,
      list: () => observe("drafts.list", () => client!.call("drafts.list", {})),
      reopen: async (expected, rawWitness = false) => {
        releaseGates(); await Promise.allSettled(operations); await Promise.allSettled(pending);
        expect(errors).toEqual([]); expect(operationErrors).toEqual([]);
        await retireRenderer(); await nativeDeadline(stopOwner(), 3000, "original owner close");
        expect(closedOwners).toBe(1); expect(backend).toBeUndefined(); expect(store).toBeUndefined();
        await openOwner();
        const rows = await observe("reopened drafts.list", () => client!.call("drafts.list", {}));
        const row = rows.find((d) => d.id === expected.id);
        expect(row).toMatchObject({ id: expected.id, generation: expected.generation, mode: expected.mode, bodyText: expected.bodyText, bodyHtml: expected.bodyHtml, subject: expected.subject, to: recipients(expected.toText, expected.auto.to) });
        expect(row!.to).toEqual(recipients(expected.toText, expected.auto.to));
        const raw = rawWitness ? (await store!.drafts.list()).find((d) => d.id === expected.id) : undefined;
        await nativeDeadline(stopOwner(), 3000, "reopened owner close"); expect(closedOwners).toBe(2);
        return raw;
      },
    });
    void scenario.then(() => { scenarioSettled = true; }, () => { scenarioSettled = true; });
    await nativeDeadline(scenario, 8000, "scenario (external command/case watchdog remains required)");
  } catch (error) { primary = { error }; if (error instanceof NativeWatchdog) { quarantined = true; quarantineFixtures("NATIVE_DEADLINE"); } }
  finally {
    releaseGates(); construction.beforeView = null; construction.registered = null;
    if (authorWitness && authorEntry.next === authorWitness) authorEntry.next = undefined;
    if (backendConstructing) { quarantined = true; quarantineFixtures("ACQUISITION_FAILED"); } // No assigned instance can prove partial constructor shutdown.
    const cleanup = async () => {
      // All gates are open before any join. Retained errors survive settled-set removal.
      if (scenario) await Promise.allSettled([scenario]);
      await Promise.allSettled(acquisitions); await Promise.allSettled(operations); await Promise.allSettled(pending);
      try { await retireRenderer(); } catch (error) { cleanupErrors.push(error); quarantined = true; quarantineFixtures("RETIREMENT_FAILED"); }
      host?.remove(); raf?.mockRestore(); cancel?.mockRestore(); frames.clear();
      try { await stopOwner(); } catch (error) { cleanupErrors.push(error); quarantined = true; quarantineFixtures("RETIREMENT_FAILED"); }
      while (pending.size) await Promise.allSettled(pending);
      renderer.call.mockReset(); setDraftTransport((method, params) => renderer.call(method, params), Date.now);
    };
    let cleanupSettled = false;
    const cleanupPromise = cleanup().then(() => { cleanupSettled = true; }, (error: unknown) => { cleanupSettled = true; throw error; });
    try { await nativeDeadline(cleanupPromise, 6000, "all owned cleanup terminals"); }
    catch (error) { cleanupErrors.push(error); quarantined = true; quarantineFixtures("CLEANUP_NOT_TERMINAL"); }
    const ownersTerminal = cleanupSettled && (!scenario || scenarioSettled) && !backend && !store && !dbHandle && closedOwners === openedOwners && acquisitions.size === 0 && pending.size === 0 && operations.size === 0;
    if (!ownersTerminal) { quarantined = true; quarantineFixtures("CLEANUP_NOT_TERMINAL"); }
    if (!quarantined && adapter !== "SQL") {
      const deletion: { state: "pending" | "success" | "error" | "blocked" } = { state: "pending" };
      const deleted = new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(idbName);
        request.onsuccess = () => { deletion.state = "success"; resolve(); };
        request.onerror = () => { deletion.state = "error"; reject(request.error ?? new Error("Owned IDB deletion failed")); };
        request.onblocked = () => { deletion.state = "blocked"; reject(new Error("Owned IDB deletion blocked")); };
      });
      try { await nativeDeadline(deleted, 2000, "owned IDB delete terminal"); }
      catch (error) {
        cleanupErrors.push(error); quarantined = true;
        quarantineFixtures(error instanceof NativeWatchdog ? "IDB_DELETE_TIMEOUT" : deletion.state === "blocked" ? "IDB_DELETE_BLOCKED" : "IDB_DELETE_FAILED");
      }
      if (!quarantined) expect.soft(deletion.state).toBe("success");
    }
    if (!quarantined && ownersTerminal) rmSync(dir, { recursive: true, force: true });
    else console.error("raw-transfer fixture quarantined owned temp", dir);
    expect.soft(construction.cleanupErrors.splice(0)).toEqual([]);
    expect.soft(errors).toEqual([]); expect.soft(operationErrors).toEqual([]); expect.soft(cleanupErrors).toEqual([]);
    expect.soft(outcomes.every((r) => r.ok)).toBe(true); expect.soft(pending.size).toBe(0); expect.soft(operations.size).toBe(0); expect.soft(acquisitions.size).toBe(0);
  }
  if (primary) throw primary.error;
}


export { renderer, construction };

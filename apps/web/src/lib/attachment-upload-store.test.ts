import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachmentRef } from "@terno/core";
import type { Draft } from "@terno/core/rpc";
import { contract } from "@terno/core/rpc";
import type { DraftInput, DraftRow, MailStore } from "@terno/store";
import { withAccounts, msg, ingest, threadOf } from "@terno/store/conformance";
import { openDatabase } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { SqlMailStore } from "../../../../packages/db/src/sql-store";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc } }));
const { acquireDraftHold, createDraft, draftWorkPending, editDraft, flushDraft: flush, forgetDraft, setDraftTransport: applyDraftTransport, useDrafts } = await import("./drafts");
const { openCompose: compose, supersedeCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { attachFiles } = await import("./attachments");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { resetSnacks, useSnack } = await import("./snack");
const apiDraft = (r: DraftRow): Draft => ({ id: r.id, generation: r.generation ?? "", revision: r.revision, format: r.format === 1 ? 1 : 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: r.subject_edited === 1, bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json ?? "[]"), quotedText: r.quoted_text, replyContext: r.reply_context_json ? JSON.parse(r.reply_context_json) : null, includeQuote: r.include_quote === 1, inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, showSourceContext: r.show_source_context === 1, presentationThreadId: r.presentation_thread_id ?? null, uiState: r.ui_state, updatedAt: r.updated_at });
const violations: unknown[] = [], releases: (() => void)[] = [];
const work = new Map<Promise<unknown>, string>(), transports = new Set<Promise<unknown>>();
let cleanupFailed = false;
let previousApp: ReturnType<typeof getApp>, previousThreads: ReturnType<typeof useThreads.getState>;
function checked<T>(check: () => T): T { try { return check(); } catch (error) { violations.push(error); throw error; } }
type Outcome = { state: "pending" } | { state: "fulfilled"; value: unknown } | { state: "rejected"; error: unknown };
type Completion = { label: string; outcome: Outcome };
type Invocation = Completion & { ordinal: number; method: string; params: unknown };
type RpcCall = [string, unknown];
type Refusal = { ordinal: number; method: string; params: unknown; outcome: Exclude<Outcome, { state: "pending" }>; consumed: number };
const operations: Completion[] = [], transportOutcomes: Invocation[] = [], rpcOutcomes: Invocation[] = [], refusals: Refusal[] = [];
const rpcPending = new Set<Promise<unknown>>();
const afterCleanup: (() => void)[] = [];
let expectedTrace: () => RpcCall[] = () => [];
let draining: Promise<void> | undefined;
let captured: { operations: Completion[]; transports: Invocation[]; rpc: Invocation[] } | undefined;
function observe<T>(pending: Promise<T>, entry: Completion): Promise<T> {
  void pending.then(value => { entry.outcome = { state: "fulfilled", value }; }, error => { entry.outcome = { state: "rejected", error }; });
  return pending;
}
function invocation(list: Invocation[], method: string, params: unknown): Invocation {
  const entry: Invocation = { ordinal: list.length + 1, method, params: structuredClone(params), label: method, outcome: { state: "pending" } };
  list.push(entry);
  return entry;
}
function routed<T>(method: string, params: unknown, call: () => Promise<T>): Promise<T> {
  const entry = invocation(rpcOutcomes, method, params);
  try {
    const pending = call(); rpcPending.add(pending);
    void pending.then(() => rpcPending.delete(pending), () => rpcPending.delete(pending));
    return observe(pending, entry);
  }
  catch (error) { entry.outcome = { state: "rejected", error }; throw error; }
}
function own<T>(promise: Promise<T>, label: string): Promise<T> {
  const entry: Completion = { label, outcome: { state: "pending" } }; operations.push(entry);
  work.set(promise, label);
  void promise.then(() => work.delete(promise), () => work.delete(promise));
  return observe(promise, entry);
}
function openCompose(...args: Parameters<typeof compose>) { return own(compose(...args), "compose"); }
function setDraftTransport(call: Parameters<typeof applyDraftTransport>[0]) {
  applyDraftTransport((method, params) => {
    const entry = invocation(transportOutcomes, method, params);
    const refusal = refusals.find(expected => expected.ordinal === entry.ordinal);
    if (refusal) refusal.consumed++;
    try {
      checked(() => { expect(method).toBe("drafts.save"); contract["drafts.save"].params.parse(params); });
      const pending = call(method, params);
      transports.add(pending);
      void pending.then(() => transports.delete(pending), () => transports.delete(pending));
      return observe(pending, entry);
    } catch (error) { entry.outcome = { state: "rejected", error }; throw error; }
  });
}
async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: pending ${[...work.values()].join(", ")}; transports ${transports.size}; RPCs ${rpcPending.size}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
function drain(): Promise<void> {
  if (draining) return draining;
  for (const release of releases) { try { release(); } catch (error) { violations.push(error); } }
  draining = bounded((async () => {
    await Promise.allSettled(work.keys());
    await Promise.allSettled(Object.keys(useDrafts.getState().drafts).map(key => own(flush(key), "cleanup flush")));
    while (work.size || transports.size || rpcPending.size) await Promise.allSettled([...work.keys(), ...transports, ...rpcPending]);
    captured = { operations: operations.map(entry => ({ ...entry })), transports: transportOutcomes.map(entry => ({ ...entry })), rpc: rpcOutcomes.map(entry => ({ ...entry })) };
  })(), "fixture drain").catch(error => { cleanupFailed = true; throw error; });
  return draining;
}
function resetOutcomes() {
  operations.length = 0; transportOutcomes.length = 0; rpcOutcomes.length = 0; refusals.length = 0; afterCleanup.length = 0;
  draining = undefined; captured = undefined; expectedTrace = () => [];
}
function assertOutcomes() {
  expect(captured, "completed fixture drain").toBeDefined();
  const complete = captured!;
  expect(work.size).toBe(0); expect(transports.size).toBe(0); expect(rpcPending.size).toBe(0);
  expect(operations).toHaveLength(complete.operations.length);
  expect(transportOutcomes).toHaveLength(complete.transports.length); expect(rpcOutcomes).toHaveLength(complete.rpc.length);
  for (const check of afterCleanup) check();
  for (const entry of complete.operations) expect(entry.outcome.state, `Unexpected operation outcome: ${entry.label}`).toBe("fulfilled");
  for (const entry of complete.transports) {
    const refusal = refusals.find(expected => expected.ordinal === entry.ordinal);
    if (refusal) {
      expect([entry.method, entry.params], "exact predeclared refusal request").toEqual([refusal.method, refusal.params]);
      expect(entry.outcome.state, "exact predeclared refusal outcome").toBe(refusal.outcome.state);
      if (entry.outcome.state === "rejected" && refusal.outcome.state === "rejected") expect(entry.outcome.error).toBe(refusal.outcome.error);
      if (entry.outcome.state === "fulfilled" && refusal.outcome.state === "fulfilled") expect(entry.outcome.value).toBe(refusal.outcome.value);
    } else {
      expect(entry.outcome.state, `Unexpected transport outcome: ${entry.ordinal} ${entry.method}`).toBe("fulfilled");
      if (entry.outcome.state === "fulfilled") expect(entry.outcome.value, "Undefined transport outcome").toBeDefined();
      if (entry.outcome.state === "fulfilled") expect(entry.outcome.value, "Unexpected null transport outcome").not.toBeNull();
    }
  }
  for (const refusal of refusals) expect(refusal.consumed, "exact refusal count").toBe(1);
  for (const entry of complete.rpc) {
    expect(entry.outcome.state, `Unexpected RPC outcome: ${entry.method}`).toBe("fulfilled");
    if (entry.outcome.state === "fulfilled") expect(entry.outcome.value, `Undefined RPC outcome: ${entry.method}`).toBeDefined();
    if (entry.outcome.state === "fulfilled") expect(entry.outcome.value, `Unexpected null RPC outcome: ${entry.method}`).not.toBeNull();
  }
  expect(complete.rpc.map(entry => [entry.method, entry.params]), "complete fixture RPC trace").toEqual(expectedTrace());
}
function flushDraft(key: string) { return own(flush(key), "flush"); }
beforeEach(() => { expect(draftWorkPending()).toBe(false); previousApp = getApp(); previousThreads = useThreads.getState(); cleanupFailed = false; resetOutcomes(); violations.length = 0; releases.length = 0; });
afterEach(async () => {
  if (cleanupFailed) throw new Error("Fixture drain incomplete; dependent cleanup skipped");
  await drain(); supersedeCompose();
  for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
  useApp.setState(previousApp, true); useThreads.setState(previousThreads, true); rpc.mockReset(); resetSnacks();
  expect(draftWorkPending()).toBe(false); expect(violations).toEqual([]); assertOutcomes();
});

for (const adapter of ["SQL", "IDB"] as const) it.each([99, 100])(`${adapter}: upload completion validates latest Forward union and cleans only unadopted refs (%i files)`, async (count) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-forward-upload-")), name = crypto.randomUUID();
  const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
  let store = await open();
  try {
    const [a] = await withAccounts(store, 1), accounts = await store.accounts.list(), account = accounts[0]!;
    await ingest(store, [msg({ accountId: a!, providerMsgId: "source", attachments: [{ filename: "source-empty", mime: "text/plain", size: 0, bytes: new Uint8Array() }] })]);
    const tid = await threadOf(store, "source"), detail = (await store.threads.get(tid))!, key = createDraft(replyFields("reply", detail, account));
    useThreads.setState({ details: new Map([[tid, detail]]) });
    setApp({ accounts, selectedId: tid, checked: new Set(), scope: null, draftShown: { threadId: tid, key }, compose: null, dialog: null, fatal: null, draftFocus: null });
    const errors: unknown[] = [], staged: AttachmentRef[] = [];
    setDraftTransport(async (_method, p) => { try { const row = await store.drafts.save(p as DraftInput, 1); const dto = row ? apiDraft(row) : null; if (row) checked(() => expect(dto).toMatchObject({ showSourceContext: row.show_source_context === 1, presentationThreadId: row.presentation_thread_id ?? null })); return dto; } catch (e) { errors.push(e); throw e; } });
    editDraft(key, { bodyText: "authored body" }); await flushDraft(key);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), waiting = new Promise<void>((r) => { reached = r; });
    releases.push(release);
    const sealed: string[] = [];
    expectedTrace = () => {
      const source = detail.messages[0]!.attachments[0]!;
      const create = (index: number): RpcCall => ["attachments.create", { accountId: a, filename: `authored-${index}.txt`, mime: "text/plain", size: 0 }];
      const asset = (method: string, index: number): RpcCall => [method, { accountId: a, assetId: staged[index]!.assetId }];
      return [create(0), ["attachments.info", { accountId: a, assetId: source.assetId }], ["drafts.sourceContext", { messageId: detail.messages[0]!.id }], asset("attachments.seal", 0),
        ...Array.from({ length: count - 1 }, (_, index) => [create(index + 1), asset("attachments.seal", index + 1)]).flat(),
        ...(count === 100 ? Array.from({ length: count }, (_, index) => asset("attachments.discard", index)) : [])];
    };
    rpc.mockImplementation((method: string, p: { accountId: number; assetId: string; filename: string; mime: string; size: number; messageId: number }) => routed(method, p, async () => {
      checked(() => {
        if (method === "drafts.sourceContext") expect(p).toEqual({ messageId: detail.messages[0]!.id });
        else if (method === "attachments.info") expect(p).toEqual({ accountId: a, assetId: detail.messages[0]!.attachments[0]!.assetId });
        else if (method === "attachments.create") expect(p).toEqual({ accountId: a, filename: `authored-${staged.length}.txt`, mime: "text/plain", size: 0 });
        else if (method === "attachments.seal" || method === "attachments.discard") { expect(p).toEqual({ accountId: a, assetId: expect.any(String) }); expect(staged.some((ref) => ref.assetId === p.assetId)).toBe(true); }
        else throw new Error(`Unexpected fixture RPC ${method}`);
      });
      if (method === "drafts.sourceContext") return store.drafts.sourceContext(p.messageId);
      if (method === "attachments.info") return store.attachments.info(p.accountId, p.assetId);
      if (method === "attachments.create") {
        const ref = await store.attachments.create({ accountId: p.accountId, filename: p.filename, mime: p.mime, size: p.size, now: 1 }); staged.push(ref);
        if (staged.length === 1) { reached(); await gate; }
        return ref;
      }
      if (method === "attachments.seal") { await store.attachments.seal(p.accountId, p.assetId); sealed.push(p.assetId); return { ok: true }; }
      if (method === "attachments.discard") { await store.attachments.discard(p.accountId, p.assetId); return { ok: true }; }
      throw new Error(`Unexpected fixture RPC ${method}`);
    }));
    const pending = own(attachFiles(key, Array.from({ length: count }, (_, i) => new File([], `authored-${i}.txt`, { type: "text/plain" }))), "upload");
    await Promise.race([waiting, pending.then(() => { throw new Error("Upload settled before create gate"); })]);
    expect(acquireDraftHold()).toBeNull();
    await openCompose("forward", tid);
    expect(useDrafts.getState().drafts[key]!.attachments).toHaveLength(1);
    editDraft(key, { bodyText: "typed during upload and conversion" });
    release(); await pending;
    const hold = acquireDraftHold(); try { expect(hold).toBeTypeOf("function"); } finally { hold?.(); }
    const d = useDrafts.getState().drafts[key]!;
    expect(d).toMatchObject({ mode: "forward", bodyText: "typed during upload and conversion" });
    expect(d.attachments).toHaveLength(count === 99 ? 100 : 1);
    expect(staged).toHaveLength(count);
    expect(sealed).toEqual(staged.map((ref) => ref.assetId));
    const source = detail.messages[0]!.attachments[0]!;
    const expected = [{ assetId: source.assetId!, filename: source.filename, mime: source.mime, size: source.size, contentId: source.contentId ?? null }, ...(count === 99 ? staged : [])];
    expect(d.attachments).toEqual(expected);
    if (count === 100) expect(useSnack.getState().current?.message).toBe("This message is too large. Remove an attachment or shorten the message.");
    expect(errors).toEqual([]);
    if (count === 100) for (const ref of staged) await expect(store.attachments.info(a!, ref.assetId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    else for (const ref of staged) expect(await store.attachments.info(a!, ref.assetId)).toEqual(ref);
    const original = detail.messages[0]!.attachments[0]!;
    expect(await store.attachments.info(a!, original.assetId!)).toMatchObject({ filename: "source-empty", size: 0 });
    await flushDraft(key);
    await store.close(); store = await open();
    const saved = (await store.drafts.list())[0]!;
    expect(saved).toMatchObject({ mode: "forward", body_text: "typed during upload and conversion" });
    expect(JSON.parse(saved.attachments_json)).toHaveLength(count === 99 ? 100 : 1);
    expect(JSON.parse(saved.attachments_json)).toEqual(expected);
    expect(rpc.mock.calls.filter(([method]) => method === "drafts.sourceContext")).toEqual([["drafts.sourceContext", { messageId: detail.messages[0]!.id }]]);
  } finally { await drain(); supersedeCompose(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

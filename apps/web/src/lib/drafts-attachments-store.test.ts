import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Draft } from "@terno/core/rpc";
import { contract } from "@terno/core/rpc";
import type { DraftInput, DraftRow, MailStore } from "@terno/store";
import { withAccounts, msg, ingest, threadOf } from "@terno/store/conformance";
import { openDatabase } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { SqlMailStore } from "../../../../packages/db/src/sql-store";

const { attachmentRpc } = vi.hoisted(() => ({ attachmentRpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: attachmentRpc } }));
const { attachBody, copyDraft, draftsSaved, draftWorkPending, materialize, resumeDraft, retryDraft, createDraft, editDraft, flushDraft: flush, fromServer, forgetDraft, recipients, setDraftTransport: applyDraftTransport, useDrafts } = await import("./drafts");

const { openCompose: compose, supersedeCompose } = await import("./compose");
const { convertFields, replyFields } = await import("./compose-fields");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { useSnack, resetSnacks } = await import("./snack");
const { resetForwardFiles, useForwardFiles } = await import("./forward-files");

const apiDraft = (r: DraftRow): Draft => checked(() => {
  const dto: Draft = {
  id: r.id, generation: r.generation ?? "", revision: r.revision, format: r.format === 1 ? 1 : 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode,
  to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: r.subject_edited === 1,
  bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json ?? "[]"), quotedText: r.quoted_text, includeQuote: r.include_quote === 1,
  inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, showSourceContext: r.show_source_context === 1, presentationThreadId: r.presentation_thread_id ?? null, uiState: r.ui_state, updatedAt: r.updated_at,
  };
  expect(dto).toMatchObject({ showSourceContext: r.show_source_context === 1, presentationThreadId: r.presentation_thread_id ?? null });
  return dto;
});
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
      checked(() => { contract[method].params.parse(params); });
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
function saveParams(key: string, patch: Partial<DraftInput> = {}): DraftInput {
  const d = useDrafts.getState().drafts[key]!;
  return structuredClone({ id: d.id ?? undefined, generation: d.generation, baseRevision: d.id !== null ? d.revision : undefined,
    accountId: d.accountId, threadId: d.threadId, mode: d.mode, to: recipients(d.toText, d.auto.to), cc: recipients(d.ccText, d.auto.cc), bcc: recipients(d.bccText, d.auto.bcc),
    subject: d.subject, subjectEdited: d.subjectEdited, bodyText: d.bodyText, bodyHtml: d.bodyHtml, attachments: d.attachments ?? [], quotedText: d.quotedText,
    includeQuote: d.includeQuote, inReplyToMessageId: d.inReplyToMessageId, forwardOfMessageId: d.forwardOfMessageId, showSourceContext: d.showSourceContext ?? false, uiState: d.uiState, ...patch });
}
beforeEach(() => { expect(draftWorkPending()).toBe(false); previousApp = getApp(); previousThreads = useThreads.getState(); cleanupFailed = false; resetOutcomes(); violations.length = 0; releases.length = 0; });
afterEach(async () => {
  if (cleanupFailed) throw new Error("Fixture cleanup incomplete; dependent teardown skipped");
  await drain(); supersedeCompose();
  for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
  useApp.setState(previousApp, true); useThreads.setState(previousThreads, true); attachmentRpc.mockReset(); resetSnacks();
  expect(draftWorkPending()).toBe(false); expect(violations).toEqual([]); assertOutcomes();
});

for (const adapter of ["SQL", "IDB"] as const) {
  it.each(["binary", "empty", "unavailable", "none"])(`${adapter}: From-B Forward refusal preserves exact work and subsequent autosave/reload (%s)`, async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-convert-attachment-"));
    const name = crypto.randomUUID();
    const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
    let store = await open();
    try {
      const [a, b] = await withAccounts(store);
      let sourceMessageId: number | undefined, sourceAssetId: string | undefined;
      attachmentRpc.mockImplementation((method: string, p: { accountId: number; assetId: string; messageId: number }) => routed(method, p, async () => {
        checked(() => {
          if (method === "drafts.sourceContext") expect(p).toEqual({ messageId: sourceMessageId });
          else if (method === "attachments.info") expect(p).toEqual({ accountId: a, assetId: sourceAssetId });
          else throw new Error(`Unexpected fixture RPC ${method}`);
        });
        if (method === "drafts.sourceContext") return store.drafts.sourceContext(p.messageId);
        if (method === "attachments.info") return store.attachments.info(p.accountId, p.assetId);
        throw new Error("Unexpected fixture RPC");
      }));
      const accounts = await store.accounts.list(), account = accounts.find((x) => x.id === a)!;
      const bytes = kind === "empty" ? new Uint8Array() : new Uint8Array([0, 255, 128]);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "source", attachments: kind === "none" ? [] : [{ filename: "source.bin", mime: "application/octet-stream", size: bytes.length, ...(kind === "unavailable" ? {} : { bytes }) }] })]);
      const detail = (await store.threads.get(await threadOf(store, "source")))!;
      sourceMessageId = detail.messages[0]!.id; sourceAssetId = detail.messages[0]!.attachments[0]?.assetId ?? undefined;
      expectedTrace = () => kind === "unavailable" ? [] : kind === "none" ? [["drafts.sourceContext", { messageId: sourceMessageId }]] : [["attachments.info", { accountId: a, assetId: sourceAssetId }], ["drafts.sourceContext", { messageId: sourceMessageId }]];
      const fields = replyFields("reply", detail, account);
      const key = createDraft(fields);
      useThreads.setState({ details: new Map([[detail.thread.id, detail]]) });
      setApp({ accounts, selectedId: detail.thread.id, checked: new Set(), scope: null, draftShown: { threadId: detail.thread.id, key }, draftFocus: null, compose: null, dialog: null, fatal: null });
      const errors: unknown[] = [];
      let acknowledge!: () => void;
      const acknowledged = new Promise<void>((r) => { acknowledge = r; });
      setDraftTransport(async (_method, params) => {
        try { const row = await store.drafts.save(params as DraftInput, Date.now()); acknowledge(); return row ? apiDraft(row) : null; }
        catch (e) { errors.push(e); throw e; }
      });
      editDraft(key, { accountId: b!, bodyText: "exact authored work", bodyHtml: "<div>exact authored <b>work</b></div>", subject: "my subject", subjectEdited: true, bccText: "manual@test.com" });
      const before = useDrafts.getState().drafts[key]!;
      await openCompose("forward", detail.thread.id);
      if (kind === "unavailable") {
        // plan 60: no file is on the device, so none ties the forward to A; it opens on B and says which From brings them
        expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "forward", accountId: b, attachments: [], bodyText: "exact authored work" });
        await vi.waitFor(() => expect(useForwardFiles.getState()[key]).toEqual({ status: "account", account: account.email }));
      } else if (kind !== "none") {
        expect(useDrafts.getState().drafts[key]).toEqual(before);
        expect(useSnack.getState().current?.message).toBe(`To forward these attachments, choose ${account.email} in From.`);
        expect(convertFields({ ...fields, accountId: b! }, "forward", detail, account)).toEqual({ ...fields, accountId: b! });
      } else expect(useDrafts.getState().drafts[key]!.mode).toBe("forward");
      await bounded(acknowledged, "real autosave acknowledgement");
      await flushDraft(key);
      editDraft(key, { bodyText: "later work stays savable", bodyHtml: "<div>later work stays <b>savable</b></div>" });
      await flushDraft(key);
      expect(errors).toEqual([]);
      await store.close(); store = await open();
      expect((await store.drafts.list())[0]).toMatchObject({ account_id: b, mode: kind === "none" || kind === "unavailable" ? "forward" : "reply", subject: "my subject", body_text: "later work stays savable", body_html: "<div>later work stays <b>savable</b></div>", attachments_json: "[]" });
      if (kind === "binary" || kind === "empty") {
        editDraft(key, { accountId: a! });
        // Immediate Forward must acknowledge the empty account change before adding source refs.
        await openCompose("forward", detail.thread.id);
        await flushDraft(key);
        expect(errors).toEqual([]);
        expect((await store.drafts.list())[0]).toMatchObject({ account_id: a, mode: "forward", body_text: "later work stays savable" });
      }
      const ref = detail.messages[0]!.attachments[0];
      if (ref?.assetId) {
        expect(await store.attachments.info(a!, ref.assetId)).toMatchObject({ size: bytes.length });
        expect(await store.attachments.read(a!, ref.assetId, 0)).toBe(kind === "empty" ? null : "AP+A");
      }
      expect(attachmentRpc.mock.calls.filter(([method]) => method === "drafts.sourceContext")).toEqual([["drafts.sourceContext", { messageId: sourceMessageId }]]);
    } finally { await drain(); supersedeCompose(); resetForwardFiles(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it(`${adapter}: removal keeps From locked through the real autosave acknowledgement, then switching and later edits survive reopen`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-draft-attachment-"));
    const name = crypto.randomUUID();
    const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setImmediate(r)) } });
    let store = await open();
    try {
      const [a, b] = await withAccounts(store);
      const ref = await store.attachments.create({ accountId: a!, filename: "old.bin", mime: "application/octet-stream", size: 3, now: 0 });
      await store.attachments.append(a!, ref.assetId, 0, "AP+A"); await store.attachments.seal(a!, ref.assetId);
      const saved = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "saved", bodyText: "old", attachments: [ref] }, 0))!;
      const d = fromServer(apiDraft(saved));
      useDrafts.setState({ drafts: { [d.key]: d } });
      let acknowledge!: () => void;
      const acknowledged = new Promise<void>((r) => { acknowledge = r; });
      const errors: unknown[] = [];
      setDraftTransport(async (method, params) => {
        expect(method).toBe("drafts.save");
        try {
          const row = await store.drafts.save(params as DraftInput, Date.now());
          acknowledge(); return row ? apiDraft(row) : null;
        } catch (error) { errors.push(error); throw error; }
      });
      editDraft(d.key, { attachments: [] });
      editDraft(d.key, { accountId: b! });
      editDraft(d.key, { bodyText: "typed while removal saves" });
      expect(useDrafts.getState().drafts[d.key]!.accountId).toBe(a);
      // Exercise the actual 800 ms debounce against the public store, not a fake saved response.
      await bounded(acknowledged, "real removal debounce acknowledgement");
      await flushDraft(d.key);
      editDraft(d.key, { accountId: b! });
      editDraft(d.key, { bodyText: "later edit from the other account" });
      await flushDraft(d.key);
      expect(errors).toEqual([]);
      await store.close(); store = await open();
      const reloaded = (await store.drafts.list())[0]!;
      expect(reloaded).toMatchObject({ account_id: b, body_text: "later edit from the other account", attachments_json: "[]" });
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
    } finally { await drain(); supersedeCompose(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const adapter of ["SQL", "IDB"] as const) {
  it.each(["delete", "send"] as const)(`${adapter}: terminal %s retains current rich work and exact files through explicit copy and reopen`, async (terminal) => {
    const dir = mkdtempSync(join(tmpdir(), "terno-recovery-store-"));
    const name = crypto.randomUUID();
    const open = (): Promise<MailStore> => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")), { instantSearch: false })) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    let store = await open();
    let body: ReturnType<typeof attachBody> | undefined;
    try {
      const [a] = await withAccounts(store);
      const ref = await store.attachments.create({ accountId: a!, filename: "exact.bin", mime: "application/octet-stream", size: 3, now: 0 });
      await store.attachments.append(a!, ref.assetId, 0, "AP+A"); await store.attachments.seal(a!, ref.assetId);
      const saved = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "old", bodyText: "old" }, 0))!;
      const d = fromServer(apiDraft(saved)); useDrafts.setState({ drafts: { [d.key]: d } });
      if (terminal === "delete") await store.drafts.delete(saved.id);
      else await store.compose.queueSend({ accountId: a!, to: [], cc: [], bcc: [], subject: "old", bodyText: "old", draftId: saved.id, draftGeneration: saved.generation, draftRevision: 1, recordReply: false, now: 1 });
      let release!: () => void; let reached!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      releases.push(release);
      const waiting = new Promise<void>((r) => { reached = r; });
      const ids: (number | undefined)[] = [];
      setDraftTransport(async (method, params) => {
        if (method === "drafts.delete") { await store.drafts.delete((params as { id: number }).id); return { ok: true }; }
        const input = params as DraftInput; ids.push(input.id);
        if (input.id === saved.id) { reached(); await gate; }
        const result = await store.drafts.save(input, 2); return result ? apiDraft(result) : null;
      });
      editDraft(d.key, { bodyText: "submitted" });
      refusals.push({ ordinal: 1, method: "drafts.save", params: saveParams(d.key), outcome: { state: "fulfilled", value: null }, consumed: 0 });
      const flushing = flushDraft(d.key); await Promise.race([waiting, flushing.then(() => { throw new Error("Flush settled before terminal-save gate"); })]);
      let text = "latest bold";
      body = attachBody(d.key, () => ({ html: `<div><b>${text}</b></div>`, text })); body.changed();
      editDraft(d.key, { toText: '"Pérez, Ana" <ana@example.com>, bob@', subject: "latest", attachments: [ref], quotedText: "> exact quote", includeQuote: true });
      release(); await flushing;
      expect(useDrafts.getState().drafts[d.key]).toMatchObject({ recovery: { state: "missing" }, bodyText: text, canonical: true });
      retryDraft(d.key); resumeDraft(d.key); await flushDraft(d.key);
      expect(ids).toEqual([saved.id]); expect(await draftsSaved()).toBe(false);
      text += " plus"; body.changed();
      const version = useDrafts.getState().drafts[d.key]!.bodyVersion;
      await copyDraft(d.key); await flushDraft(d.key);
      const current = materialize(d.key)!;
      expect(current).toMatchObject({ key: d.key, bodyText: text, bodyVersion: version, canonical: true, toText: '"Pérez, Ana" <ana@example.com>, bob@' });
      expect(current.recovery).toBeUndefined(); expect(current.id).not.toBe(saved.id);
      body.dispose(); body = undefined;
      await store.close(); store = await open();
      const reloaded = (await store.drafts.list())[0]!;
      expect(reloaded).toMatchObject({ id: current.id, body_text: text, body_html: `<div><b>${text}</b></div>`, quoted_text: "> exact quote" });
      expect(apiDraft(reloaded).to).toEqual([{ name: "Pérez, Ana", email: "ana@example.com" }, { name: "", email: "bob@" }]);
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
      expect((await store.ops.recent(10)).filter((o) => o.kind === "send")).toHaveLength(terminal === "send" ? 1 : 0);
    } finally { await drain(); body?.dispose(); supersedeCompose(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

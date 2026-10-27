import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { contract, createMemoryTransportPair, RpcClient, toErrorPayload, type Draft } from "@terno/core/rpc";
import { openDatabase, SqlMailStore } from "@terno/db";
import type { DraftRow } from "@terno/store";
import { withAccounts } from "@terno/store/conformance";

const rpc = vi.hoisted(() => ({ call: vi.fn<RpcClient["call"]>() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc.call } }));
vi.mock("~/lib/appearance", () => ({ adoptSettings: vi.fn() }));
const { sendDraft } = await import("~/lib/compose");
const { attachBody, copyDraft, createDraft, draftChangeVersion, draftWorkPending, draftsSaved, editDraft, flushDraft, forgetDraft, setDraftTransport, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");
const { switchStorage } = await import("./connect");

const apiDraft = (r: DraftRow): Draft => ({
  id: r.id, generation: r.generation ?? "", revision: r.revision, format: 2, accountId: r.account_id, threadId: r.thread_id, mode: r.mode,
  to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, subjectEdited: !!r.subject_edited,
  bodyText: r.body_text, bodyHtml: r.body_html, attachments: JSON.parse(r.attachments_json), quotedText: r.quoted_text, includeQuote: !!r.include_quote,
  inReplyToMessageId: r.in_reply_to_message_id, forwardOfMessageId: r.forward_of_message_id, uiState: r.ui_state, updatedAt: r.updated_at,
});
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.call.mockReset(); vi.unstubAllGlobals(); });

it("storage switching refuses an already-accepted Send, then carries an explicit exact copy after its missing refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-send-switch-")), store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
  const [page, backend] = createMemoryTransportPair(), client = new RpcClient(page);
  let releaseSend!: () => void, reached!: () => void, sending: Promise<boolean> | undefined;
  let source: ReturnType<typeof attachBody> | undefined;
  const gate = new Promise<void>((r) => { releaseSend = r; }), started = new Promise<void>((r) => { reached = r; });
  const exports: DraftRow[][] = [];
  backend.onMessage(async (request) => {
    if (request.t !== "req") return;
    try {
      let result: unknown;
      if (request.m === "compose.send") {
        const p = contract["compose.send"].params.parse(request.p); reached(); await gate;
        result = await store.compose.queueSend({ ...p, recordReply: false, now: 1 });
      } else if (request.m === "app.export") {
        const drafts = await store.drafts.list(); exports.push(drafts); result = { drafts };
      } else throw new Error("Unexpected fixture request");
      backend.send({ v: 1, t: "res", id: request.id, ok: true, r: result });
    } catch (error) { backend.send({ v: 1, t: "res", id: request.id, ok: false, e: toErrorPayload(error) }); }
  });
  rpc.call.mockImplementation(client.call.bind(client));
  try {
    const [accountId] = await withAccounts(store);
    const ref = await store.attachments.create({ accountId: accountId!, filename: "exact.bin", mime: "application/octet-stream", size: 3, now: 0 });
    await store.attachments.append(accountId!, ref.assetId, 0, "AP+A"); await store.attachments.seal(accountId!, ref.assetId);
    setDraftTransport(async (_method, p) => { const row = await store.drafts.save(contract["drafts.save"].params.parse(p), 0); return row ? apiDraft(row) : null; });
    const key = createDraft({ ...newFields(accountId!), toText: '"Pérez, Ana" <ana@example.test>, bob@example.test', ccText: "copy@example.test", bccText: "private@example.test", subject: "exact subject", subjectEdited: true, quotedText: "> exact quote", includeQuote: true, attachments: [ref] });
    editDraft(key, { bodyText: "exact accepted work", bodyHtml: "<div><b>exact accepted work</b></div>" });
    source = attachBody(key, () => ({ text: "exact accepted work", html: "<div><b>exact accepted work</b></div>" })); source.changed(); await flushDraft(key);
    const old = useDrafts.getState().drafts[key]!; await store.drafts.delete(old.id!, old.generation);
    const replace = vi.fn(), carry = vi.fn(), pin = vi.fn();
    vi.stubGlobal("location", { href: "https://synthetic.test/?storage=opfs-sqlite", replace });
    vi.stubGlobal("sessionStorage", { setItem: carry }); vi.stubGlobal("localStorage", { setItem: pin });
    sending = sendDraft(key); await started;
    expect(useDrafts.getState().drafts[key]!.sending).toBe(true);
    const version = draftChangeVersion();
    const switched = await switchStorage(client, "idb").then(() => true, () => false);
    expect(draftChangeVersion()).toBe(version);
    releaseSend(); expect(await sending).toBe(false); sending = undefined;
    expect(useDrafts.getState().drafts[key]).toMatchObject({ key, bodyText: "exact accepted work", bodyHtml: "<div><b>exact accepted work</b></div>", canonical: true, bodyVersion: old.bodyVersion, toText: '"Pérez, Ana" <ana@example.test>, bob@example.test', ccText: "copy@example.test", bccText: "private@example.test", quotedText: "> exact quote", attachments: [ref], recovery: { state: "missing" } });
    expect(switched).toBe(false); expect(exports).toEqual([]); expect(carry).not.toHaveBeenCalled(); expect(pin).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
    expect(await draftsSaved()).toBe(false);
    await copyDraft(key); expect(await draftsSaved()).toBe(true); await switchStorage(client, "idb");
    const copied = exports[0]![0]!;
    expect(copied).toMatchObject({ body_text: "exact accepted work", body_html: "<div><b>exact accepted work</b></div>", quoted_text: "> exact quote", cc_json: '[{"name":"","email":"copy@example.test"}]', attachments_json: JSON.stringify([ref]) });
    expect(copied.generation).not.toBe(old.generation); expect(await store.attachments.read(accountId!, ref.assetId, 0)).toBe("AP+A");
    expect(replace).toHaveBeenCalledTimes(1); expect(pin).toHaveBeenCalledWith("terno:storage:terno", "idb"); expect(carry).toHaveBeenCalledTimes(1);
  } finally {
    releaseSend(); if (sending) await sending; source?.dispose(); client.close(); await store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

it("a failed Send materialization releases its accepted-work flag and retains the editable fields", async () => {
  const key = createDraft({ ...newFields(1), toText: "ana@example.test", bodyText: "retained before source failure" });
  const source = attachBody(key, () => { throw new Error("synthetic source failure"); }); source.changed();
  try {
    const outcome = await sendDraft(key).then((sent) => ({ sent }), () => ({ rejected: true }));
    expect(useDrafts.getState().drafts[key]).toMatchObject({ sending: false, bodyText: "retained before source failure" });
    expect(outcome).toEqual({ sent: false }); expect(rpc.call).not.toHaveBeenCalled();
  } finally { source.dispose(); }
});

it.each(["pending", "missing", "failure", "success"] as const)("Send accepted during export invalidates its old snapshot even after %s settlement", async (outcome) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-export-send-")), store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
  const [page, backend] = createMemoryTransportPair(), client = new RpcClient(page);
  let releaseSend!: () => void, releaseExport!: () => void, reachedSend!: () => void, reachedExport!: () => void;
  const sendGate = new Promise<void>((r) => { releaseSend = r; }), exportGate = new Promise<void>((r) => { releaseExport = r; });
  const sendStarted = new Promise<void>((r) => { reachedSend = r; }), exportStarted = new Promise<void>((r) => { reachedExport = r; });
  let sending: Promise<boolean> | undefined, switching: Promise<boolean> | undefined;
  backend.onMessage(async (request) => {
    if (request.t !== "req") return;
    try {
      let result: unknown;
      if (request.m === "app.export") {
        result = { drafts: await store.drafts.list() }; reachedExport(); await exportGate;
      } else if (request.m === "compose.send") {
        const p = contract["compose.send"].params.parse(request.p); reachedSend(); await sendGate;
        if (outcome === "failure") throw new Error("synthetic transport failure");
        result = await store.compose.queueSend({ ...p, recordReply: false, now: 1 });
      } else throw new Error("Unexpected fixture request");
      backend.send({ v: 1, t: "res", id: request.id, ok: true, r: result });
    } catch (error) { backend.send({ v: 1, t: "res", id: request.id, ok: false, e: toErrorPayload(error) }); }
  });
  rpc.call.mockImplementation(client.call.bind(client));
  try {
    const [accountId] = await withAccounts(store);
    setDraftTransport(async (_method, p) => { const row = await store.drafts.save(contract["drafts.save"].params.parse(p), 0); return row ? apiDraft(row) : null; });
    const key = createDraft({ ...newFields(accountId!), toText: "ana@example.test", bodyText: "retained during export" });
    editDraft(key, {}); await flushDraft(key);
    const old = useDrafts.getState().drafts[key]!;
    if (outcome === "pending" || outcome === "missing") await store.drafts.delete(old.id!, old.generation);
    const replace = vi.fn(), carry = vi.fn(), pin = vi.fn();
    vi.stubGlobal("location", { href: "https://synthetic.test/?storage=opfs-sqlite", replace });
    vi.stubGlobal("sessionStorage", { setItem: carry }); vi.stubGlobal("localStorage", { setItem: pin });
    switching = switchStorage(client, "idb").then(() => true, () => false); await exportStarted;
    sending = sendDraft(key); await sendStarted; expect(draftWorkPending()).toBe(true);
    if (outcome !== "pending") { releaseSend(); expect(await sending).toBe(outcome === "success"); sending = undefined; expect(draftWorkPending()).toBe(false); }
    releaseExport(); expect(await switching).toBe(false); switching = undefined;
    expect(carry).not.toHaveBeenCalled(); expect(pin).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
    if (sending) { releaseSend(); expect(await sending).toBe(false); sending = undefined; }
    if (outcome === "success") expect(useDrafts.getState().drafts[key]).toBeUndefined();
    else expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "retained during export", sending: false, ...(outcome === "failure" ? {} : { recovery: { state: "missing" } }) });
  } finally {
    releaseSend(); releaseExport(); if (sending) await sending; if (switching) await switching;
    client.close(); await store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

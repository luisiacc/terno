// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { contract, createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import type { DraftAckRead } from "./drafts";
import { setup, gate, deferred } from "../components/draft-presentation-r1-harness";

const construction = vi.hoisted(() => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => { release = resolve; });
  return { loaded, release, parseFault: null as Error | null, viewFault: null as (() => never) | null, parses: 0, views: 0 };
});
vi.mock("../components/composer/rich", async (original) => {
  await construction.loaded;
  return original<typeof import("../components/composer/rich")>();
});
vi.mock("../components/composer/editor", async (original) => {
  const actual = await original<typeof import("../components/composer/editor")>();
  return { ...actual,
    docOf: (...args: Parameters<typeof actual.docOf>) => {
      construction.parses++;
      if (construction.parseFault) throw construction.parseFault;
      return actual.docOf(...args);
    },
    createEditor: (...args: Parameters<typeof actual.createEditor>) => {
      construction.views++;
      if (construction.viewFault) construction.viewFault();
      return actual.createEditor(...args);
    },
  };
});

type Harness = Awaited<ReturnType<typeof setup>>;
async function loaded() { construction.release(); return (await import("../components/composer/lazy")).loadComposer(); }
async function frames(h: Harness) { for (let i = 0; i < 5; i++) await h.flush(); }
async function stop(h: Harness) {
  const { supersedeCompose } = await import("./compose"), { resetForwardFiles } = await import("./forward-files");
  supersedeCompose(); resetForwardFiles(); await h.cleanup();
}

// The held real module import creates a fresh lazy arrival; no fake body source or proof is installed.
it("continuity: fresh PM arrival after first Forward admission preserves work and focus", async () => {
  const h = await setup("split", true), waiting = deferred<ThreadDetail>();
  const { openCompose, composeFocusPending } = await import("./compose");
  const { controllerFor } = await import("../components/composer/controller");
  let first: Promise<void> | undefined, second: Promise<void> | undefined, operation: Promise<void> | undefined, off = () => {};
  try {
    expect(h.host.querySelector('[data-testid="compose-body-loading"]')).not.toBeNull();
    expect(controllerFor(h.key)).toBeNull();
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    h.other.focus(); gate.load.mockClear(); gate.load.mockReturnValue(waiting.promise);
    let entered = false;
    await act(async () => {
      first = openCompose("reply", 7); expect(h.app.getApp().draftFocus).not.toBeNull();
      off = h.app.useApp.subscribe((state, previous) => {
        if (!entered && previous.draftFocus && !state.draftFocus) { entered = true; off(); operation = openCompose("forward", 7); }
      });
      second = openCompose("reply", 7); off(); await Promise.all([first, second]);
    });
    expect(entered).toBe(true);
    expect(gate.load).toHaveBeenCalledWith(7); expect(operation).toBeDefined(); expect(composeFocusPending(7)).toBe(true);
    expect(h.drafts.useDrafts.getState().drafts[h.key]?.mode).toBe("reply");
    // The earlier Reply's real publication committed while this exact Forward was waiting.
    expect(h.host.querySelector('[data-testid="compose-body-loading"]')).not.toBeNull();
    await act(async () => { await loaded(); });
    expect(controllerFor(h.key)?.dom.textContent).toBe(before.bodyText);
    await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await operation; });
    await frames(h);
    expect(h.drafts.materialize(h.key)).toMatchObject({ key: h.key, id: before.id, generation: before.generation, mode: "forward", bodyText: before.bodyText });
    const to = h.host.querySelector('[data-testid="compose-to"]'); expect(to).not.toBeNull(); expect(document.activeElement).toBe(to); expect(composeFocusPending(7)).toBe(false);
  } finally { off(); construction.release(); waiting.resolve(h.detail); await Promise.allSettled([first, second, operation].filter((p): p is Promise<void> => !!p)); await stop(h); }
});

it("continuity: kept PM remount after first Forward admission preserves work and focus", async () => {
  await loaded(); const h = await setup("split", true), waiting = deferred<ThreadDetail>();
  const { controllerFor } = await import("../components/composer/controller"), { keptState } = await import("../components/composer/editor");
  const { openCompose, composeFocusPending } = await import("./compose");
  let first: Promise<void> | undefined, second: Promise<void> | undefined, operation: Promise<void> | undefined, off = () => {};
  try {
    expect(controllerFor(h.key)).not.toBeNull();
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    const kept = keptState(h.key, before.bodyVersion); expect(kept).not.toBeNull();
    h.other.focus(); gate.load.mockClear(); gate.load.mockReturnValue(waiting.promise); let entered = false;
    await act(async () => {
      first = openCompose("reply", 7); expect(h.app.getApp().draftFocus).not.toBeNull();
      off = h.app.useApp.subscribe((state, previous) => {
        if (!entered && previous.draftFocus && !state.draftFocus) { entered = true; off(); operation = openCompose("forward", 7); }
      });
      second = openCompose("reply", 7); off(); await Promise.all([first, second]);
    });
    expect(entered).toBe(true); expect(operation).toBeDefined(); expect(gate.load).toHaveBeenCalledWith(7); expect(composeFocusPending(7)).toBe(true);
    expect(controllerFor(h.key)?.dom.textContent).toBe(before.bodyText);
    await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await operation; }); await frames(h);
    expect(h.drafts.materialize(h.key)).toMatchObject({ key: h.key, id: before.id, generation: before.generation, mode: "forward", bodyText: before.bodyText, bodyHtml: before.bodyHtml });
    const to = h.host.querySelector('[data-testid="compose-to"]'); expect(to).not.toBeNull(); expect(document.activeElement).toBe(to); expect(composeFocusPending(7)).toBe(false);
  } finally { off(); waiting.resolve(h.detail); await Promise.allSettled([first, second, operation].filter((p): p is Promise<void> => !!p)); await stop(h); }
});

it("continuity: owned collapse departure preserves newer Forward while save response waits", async () => {
  await loaded(); const h = await setup("split", true), waiting = deferred<ThreadDetail>(), saved = deferred<void>();
  const { controllerFor } = await import("../components/composer/controller"), { openCompose, composeFocusPending } = await import("./compose");
  let operation: Promise<void> | undefined, off = () => {}, entered = false, saves = 0;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "open" }));
    const before = h.drafts.materialize(h.key)!;
    // Component transport model: the real Writer is held, but this response is not durable-store evidence.
    h.drafts.setDraftTransport(async (_method, params) => { saves++; await saved.promise; return { ...(params as object), id: 81, generation: "stable", revision: 5, updatedAt: 0 }; });
    gate.load.mockReturnValue(waiting.promise);
    off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!entered && previous.drafts[h.key]?.uiState === "open" && state.drafts[h.key]?.uiState === "collapsed") { entered = true; operation = openCompose("forward", 7); }
    });
    const body = controllerFor(h.key)?.dom; expect(body).toBeDefined(); body!.focus();
    await act(async () => { body!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(entered).toBe(true); expect(operation).toBeDefined(); expect(saves).toBe(1); expect(composeFocusPending(7)).toBe(true);
    await h.flush();
    await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await operation; }); await frames(h);
    const to = h.host.querySelector('[data-testid="compose-to"]'); expect(to).not.toBeNull(); expect(document.activeElement).toBe(to); expect(composeFocusPending(7)).toBe(false);
    expect(h.drafts.materialize(h.key)).toMatchObject({ key: h.key, id: before.id, generation: before.generation, mode: "forward", bodyText: before.bodyText, bodyHtml: before.bodyHtml });
  } finally {
    off(); waiting.resolve(h.detail); saved.resolve(); await Promise.allSettled(operation ? [operation] : []);
    await h.drafts.flushDraft(h.key); h.drafts.setDraftTransport((method, params) => gate.call(method, params)); await stop(h);
  }
});

for (const phase of ["parse", "view"] as const) it(phase === "parse" ? "continuity: fresh parse failure preserves authored work and closes old focus" : "continuity: view-construction failure preserves a reentrant successor", async () => {
  await loaded(); const h = await setup("split", true), { forgetState } = await import("../components/composer/editor");
  let successor: string | undefined, token: DraftAckRead | undefined, attempts = 0, duringConstruction: string | undefined;
  const fault = new Error(`expected ${phase} construction failure`);
  try {
    await act(async () => h.drafts.setDraftUi(h.key, "collapsed")); forgetState(h.key);
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    if (phase === "parse") construction.parseFault = fault;
    else construction.viewFault = () => {
      attempts++;
      if (!successor) {
        const current = h.drafts.useDrafts.getState().drafts[h.key]!;
        const originalAdmission = h.drafts.beginDraftAckRead(current); duringConstruction = originalAdmission.kind;
        if (originalAdmission.kind !== "refused") h.drafts.endDraftAckRead(originalAdmission.kind === "proof" ? originalAdmission.proof : originalAdmission.continuity);
        successor = h.drafts.createDraft({ ...h.drafts.fieldsOf(before), bodyText: "newer authored work", bodyHtml: "", uiState: "collapsed" });
        const admission = h.drafts.beginDraftAckRead(h.drafts.useDrafts.getState().drafts[successor]!);
        expect(admission.kind).not.toBe("refused");
        if (admission.kind !== "refused") token = admission.kind === "proof" ? admission.proof : admission.continuity;
      }
      throw fault;
    };
    const parses = construction.parses, views = construction.views;
    await act(async () => h.drafts.setDraftUi(h.key, "open"));
    expect(phase === "parse" ? construction.parses > parses : construction.views > views).toBe(true);
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ key: h.key, id: before.id, generation: before.generation, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
    if (phase === "view") { expect(attempts).toBeGreaterThanOrEqual(1); expect(token).toBeDefined(); expect(h.drafts.readDraftAck(token!)).toBe(h.drafts.useDrafts.getState().drafts[successor!]); expect(duringConstruction).toBe("refused"); }
    expect(h.app.getApp().draftFocus).toBeNull();
  } finally { construction.parseFault = null; construction.viewFault = null; if (token) h.drafts.endDraftAckRead(token); await stop(h); }
});

for (const successor of [false, true]) it(successor ? "continuity: throwing materialize publication cannot retire a newer read" : "continuity: throwing materialize publication preserves assigned body", async () => {
  await loaded(); const h = await setup("split", true), { controllerFor } = await import("../components/composer/controller");
  const fault = new Error("expected materialize observer failure"); let off = () => {}, entered = false, newerKey: string | undefined, token: DraftAckRead | undefined;
  try {
    const controller = controllerFor(h.key); expect(controller).not.toBeNull();
    await act(async () => controller!.run("quote")); expect(controller!.dom.querySelector("blockquote")).not.toBeNull();
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    off = h.drafts.useDrafts.subscribe((state, previous) => {
      if (entered || state.drafts[h.key]?.bodyHtml === previous.drafts[h.key]?.bodyHtml) return;
      entered = true; off();
      if (successor) {
        const { newFields } = fieldModule;
        newerKey = h.drafts.createDraft({ ...newFields(1), bodyText: "successor work", uiState: "collapsed" });
        const admission = h.drafts.beginDraftAckRead(h.drafts.useDrafts.getState().drafts[newerKey]!);
        expect(admission.kind).not.toBe("refused");
        if (admission.kind !== "refused") token = admission.kind === "proof" ? admission.proof : admission.continuity;
      }
      throw fault;
    });
    const fieldModule = await import("./compose-fields");
    await act(async () => { expect(() => h.drafts.materialize(h.key)).toThrow(fault); });
    expect(entered).toBe(true);
    const assigned = h.drafts.useDrafts.getState().drafts[h.key]!;
    expect(assigned).toMatchObject({ key: h.key, id: before.id, generation: before.generation, bodyText: "> exact authored work", localRev: before.localRev, bodyVersion: before.bodyVersion });
    const assignedDom = document.createElement("template"); assignedDom.innerHTML = assigned.bodyHtml;
    expect(assignedDom.content.querySelector("blockquote")?.textContent).toBe("exact authored work");
    if (successor) { expect(token).toBeDefined(); expect(h.drafts.readDraftAck(token!)).toBe(h.drafts.useDrafts.getState().drafts[newerKey!]); }
    await act(async () => { expect(h.drafts.materialize(h.key)).toMatchObject({ bodyHtml: assigned.bodyHtml, bodyText: "> exact authored work", localRev: before.localRev, bodyVersion: before.bodyVersion }); });
  } finally { off(); if (token) h.drafts.endDraftAckRead(token); await stop(h); }
});

it("continuity: later control choice cancels a waiting source handoff", async () => {
  await loaded(); const h = await setup("split", true), waiting = deferred<ThreadDetail>(), { openCompose } = await import("./compose");
  let operation: Promise<void> | undefined;
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    h.other.focus(); gate.load.mockClear(); gate.load.mockReturnValue(waiting.promise);
    await act(async () => { operation = openCompose("forward", 7); }); expect(gate.load).toHaveBeenCalledWith(7);
    const later = h.host.querySelector<HTMLButtonElement>('[data-testid="draft-collapsed"]'); expect(later).not.toBeNull(); later!.focus();
    await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await operation; }); await frames(h);
    expect(document.activeElement).toBe(later);
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ mode: "reply", bodyText: before.bodyText, key: before.key, id: before.id, generation: before.generation });
  } finally { waiting.resolve(h.detail); await Promise.allSettled(operation ? [operation] : []); await stop(h); }
});

it("continuity: incomplete original files still open under current Plan60", async () => {
  await loaded(); const h = await setup("split", true), { openCompose } = await import("./compose");
  const { useForwardFiles } = await import("./forward-files");
  try {
    const detail = { ...h.detail, messages: h.detail.messages.map((m) => ({ ...m, attachmentState: "pending" as const, attachments: [] })) };
    gate.load.mockResolvedValue(detail);
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    h.other.focus(); await act(async () => openCompose("forward", 7)); await frames(h);
    expect(h.drafts.materialize(h.key)).toMatchObject({ mode: "forward", uiState: "open", bodyText: "exact authored work" });
    expect(useForwardFiles.getState()[h.key]?.status).toBe("fetching");
    expect(gate.call.mock.calls.some(([method]) => method === "attachments.retry")).toBe(true);
  } finally { await stop(h); }
});

const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };
for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it(`continuity: ${adapter} real PM work and Undo persist through normal writer ACK`, async () => {
  const { RichBody } = await loaded(), drafts = await import("./drafts"), { newFields } = await import("./compose-fields");
  const { controllerFor } = await import("../components/composer/controller");
  const dir = mkdtempSync(join(tmpdir(), "terno-lineage-")), name = crypto.randomUUID();
  const open = () => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")))) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
  let store = await open(), stopped = false, key: string | undefined;
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "forward-source-continuity", origin: "renderer" }); const client = new RpcClient(c);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const pending = new Set<Promise<unknown>>(), failures: Array<{ request: number; error: unknown }> = [], outcomes: Array<{ request: number; ok: boolean }> = [];
  const sent: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
  let requests = 0, drained: PromiseSettledResult<unknown>[] = [];
  drafts.setDraftTransport((method, params) => {
    if (method !== "drafts.save") throw new Error("Unexpected continuity writer method");
    const input = contract["drafts.save"].params.parse(params); sent.push(input);
    const index = ++requests, request = client.call("drafts.save", input); pending.add(request);
    void request.then((result) => { outcomes.push({ request: index, ok: result !== null }); pending.delete(request); }, (error: unknown) => { failures.push({ request: index, error }); pending.delete(request); });
    return request;
  });
  try {
    const [accountId] = await withAccounts(store);
    key = drafts.createDraft({ ...newFields(accountId!), bodyText: "durable authored work", bodyHtml: "<p>durable authored work</p>", subject: "authored subject", subjectEdited: true, toText: "authored@example.test" });
    drafts.editDraft(key, {}); await drafts.flushDraft(key); const initial = drafts.useDrafts.getState().drafts[key]!;
    expect(initial.id).not.toBeNull(); expect(initial.generation).toBeTruthy(); expect(initial.status).toBe("saved");
    expect(sent[0]).toMatchObject({ accountId, mode: "new", bodyText: "durable authored work", bodyHtml: "<p>durable authored work</p>", to: [{ name: "", email: "authored@example.test" }], subject: "authored subject", subjectEdited: true });
    await act(async () => root.render(<RichBody draftKey={key!} placeholder="Body" />));
    const controller = controllerFor(key); expect(controller).not.toBeNull();
    await act(async () => controller!.run("quote"));
    expect(controller!.dom.querySelector("blockquote")?.textContent).toBe("durable authored work");
    const quoted = drafts.materialize(key)!; expect(quoted.bodyText).toBe("> durable authored work");
    const quotedDom = document.createElement("template"); quotedDom.innerHTML = quoted.bodyHtml;
    expect(quotedDom.content.querySelector("blockquote")?.textContent).toBe("durable authored work");
    await drafts.flushDraft(key); expect(drafts.useDrafts.getState().drafts[key]).toMatchObject({ id: initial.id, generation: initial.generation, bodyHtml: quoted.bodyHtml, status: "saved" });
    expect(sent[1]).toMatchObject({ id: initial.id, generation: initial.generation, baseRevision: initial.revision, bodyText: "> durable authored work", bodyHtml: quoted.bodyHtml, to: [{ name: "", email: "authored@example.test" }], subject: "authored subject", subjectEdited: true });
    const rows = await client.call("drafts.list", {}); expect(rows.find((d) => d.id === initial.id)).toMatchObject({ id: initial.id, generation: initial.generation, revision: initial.revision + 1, bodyText: "> durable authored work", bodyHtml: quoted.bodyHtml, to: [{ name: "", email: "authored@example.test" }], subject: "authored subject" });
    await act(async () => controller!.run("undo")); expect(controller!.dom.querySelector("blockquote")).toBeNull();
    const undone = drafts.materialize(key)!; await drafts.flushDraft(key);
    expect(undone.bodyText).toBe("durable authored work");
    const undoneDom = document.createElement("template"); undoneDom.innerHTML = undone.bodyHtml;
    expect(undoneDom.content.querySelector("blockquote")).toBeNull();
    expect(sent[2]).toMatchObject({ id: initial.id, generation: initial.generation, baseRevision: initial.revision + 1, bodyText: "durable authored work", bodyHtml: undone.bodyHtml, to: [{ name: "", email: "authored@example.test" }], subject: "authored subject", subjectEdited: true });
    c.close(); await backend.stop(); stopped = true; store = await open();
    const row = (await store.drafts.list()).find((d) => d.id === initial.id)!;
    expect(row).toMatchObject({ id: initial.id, generation: initial.generation, revision: initial.revision + 2, body_text: "durable authored work", body_html: undone.bodyHtml, subject: "authored subject" });
    expect(JSON.parse(row.to_json)).toEqual([{ name: "", email: "authored@example.test" }]); expect(requests).toBe(3); expect(sent).toHaveLength(3);
  } finally {
    await act(async () => root.unmount()); if (key) drafts.forgetDraft(key); host.remove();
    try { drained = await Promise.allSettled(pending); }
    finally {
      drafts.setDraftTransport((method, params) => gate.call(method, params)); c.close();
      try { if (!stopped) await backend.stop(); else await store.close(); }
      finally { rmSync(dir, { recursive: true, force: true }); expect.soft(failures).toEqual([]); expect.soft(drained.filter((r) => r.status === "rejected")).toEqual([]); expect.soft(outcomes).toHaveLength(requests); expect.soft(outcomes.every((r) => r.ok)).toBe(true); }
    }
  }
});

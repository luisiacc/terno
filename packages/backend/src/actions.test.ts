/**
 * Plan 143 through the real backend (RPC, settings, SQLite), with a scripted model and a recording transport: nothing
 * leaves this process. What must hold in both stores is in the conformance suite; here, what a sentence does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import type { ActionPreviewInfo, AiActionStart } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { msg, threadOf } from "@terno/store/conformance";
import { databaseName, IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = new Date(2026, 10, 5, 12).getTime();
const DAY = 86_400_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const subjectHas = (value: string) => ({ field: "subject", op: "contains", value, negate: false });
const planWire = (o: Record<string, unknown> = {}) => ({ summary: "Do it", actionType: "archive", categoryId: null, categoryName: null, accountId: null, folder: null, conditions: [subjectHas("invoice")], lookIn: "inbox", future: false, meaning: false, ...o });

/** Where a store could change the result, those suites run on both. */
let storeKind: "SQLite" | "IndexedDB" = "SQLite";
const onBoth = (body: () => void) =>
  describe.each(["SQLite", "IndexedDB"] as const)("%s", (kind) => {
    beforeEach(() => {
      storeKind = kind;
    });
    afterEach(() => {
      storeKind = "SQLite";
    });
    body();
  });

async function setup(o: { cloud?: boolean; similarCap?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-actions-"));
  const model = {
    plan: planWire() as Record<string, unknown>,
    checks: [] as CompletionRequest[],
    plans: [] as CompletionRequest[],
    check: (_req: CompletionRequest, _n: number): string => JSON.stringify({ drop: [] }),
  };
  const clock = { now: NOW };
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async (req) => {
          if (req.schema?.name === "ask_plan") return { text: JSON.stringify({ kind: "command", queries: [] }), stop: "end" };
          if (req.schema?.name === "action_plan") {
            model.plans.push(req);
            return { text: JSON.stringify(model.plan), stop: "end" };
          }
          model.checks.push(req);
          return { text: model.check(req, model.checks.length - 1), stop: "end" };
        },
      },
    });
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const idb = storeKind === "IndexedDB" ? await IdbMailStore.open({ name: databaseName(`actions-${crypto.randomUUID()}`), factory: new IDBFactory(), platform, instantSearch: false }) : undefined;
  const backend = new Backend({ dbPath: join(dir, "a.db"), store: idb, platform: idb ? platform : undefined, version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now, similarCap: o.similarCap });
  await backend.store.ready;
  const connect = (clientId: string) => {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId, origin: "renderer" });
    return new RpcClient(c);
  };
  const client = connect("renderer");
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@terno.test", displayName: "Me", color: "indigo", now: 0 });
  if (o.cloud) {
    await client.call("ai.setKey", { provider: "anthropic", value: "sk-test-not-a-real-key" });
    await client.call("settings.update", { ai: { provider: "anthropic", model: "claude-opus-5-5" } });
  } else await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const put = async (over: Partial<IncomingMessage> = {}) => {
    const m = msg({ accountId: account.id, date: NOW - DAY, from: { name: "Ana", email: "ana@acme.test" }, subject: "Invoice 12", bodyText: "Text", providerMsgId: `m-${seq++}`, ...over });
    await backend.ingestSliced([m], true);
    return threadOf(backend.store, m.providerMsgId!);
  };
  const start = async (plan: Record<string, unknown> = {}, c = client): Promise<AiActionStart> => {
    model.plan = planWire(plan);
    return c.call("ai.actionStart", { requestId: crypto.randomUUID(), sentence: "the sentence", timezone: "UTC" });
  };
  /** the preview once it's done looking */
  const preview = async (plan: Record<string, unknown> = {}): Promise<ActionPreviewInfo> => {
    const r = await start(plan);
    if (r.status !== "preview") throw new Error(`expected a preview, got ${r.status}`);
    await vi.waitFor(async () => expect((await client.call("ai.actionToggle", { previewId: r.preview.previewId, threadId: 1e9, included: false })).scanning).toBe(false));
    return client.call("ai.actionToggle", { previewId: r.preview.previewId, threadId: 1e9, included: true });
  };
  const apply = (p: ActionPreviewInfo, future = false) => client.call("ai.actionApply", { previewId: p.previewId, future });
  const check = (p: ActionPreviewInfo, o: { acknowledge?: string; skip?: boolean } = {}) => client.call("ai.actionCheck", { previewId: p.previewId, requestId: crypto.randomUUID(), ...o });
  const fact = async (id: number) => (await backend.store.filters.actionFacts([id]))[0]!;
  const rows = async (p: ActionPreviewInfo, leftOut = false) => (await client.call("ai.actionPage", { previewId: p.previewId, offset: 0, limit: 500, leftOut })).items.map((t) => t.id);
  return { backend, client, connect, model, account, put, start, preview, apply, check, fact, rows, clock };
}

describe("nothing runs before Apply", () => {
  it("planning, finding, paging and ticking change no mail; Apply does", async () => {
    const { put, preview, apply, fact, rows, client } = await setup();
    const a = await put();
    const b = await put();
    const other = await put({ subject: "Lunch" });
    const p = await preview();
    expect(p.count).toBe(2);
    expect(await rows(p)).toEqual(expect.arrayContaining([a, b]));
    await client.call("ai.actionToggle", { previewId: p.previewId, threadId: b, included: false });
    expect((await fact(a)).inInbox).toBe(true);
    const r = await apply(p);
    expect(r.done).toBe(1);
    expect((await fact(a)).inInbox).toBe(false);
    expect((await fact(b)).inInbox).toBe(true);
    expect((await fact(other)).inInbox).toBe(true);
  });

  it("a question that's a command asks nothing of the mail and keeps nothing", async () => {
    const { client, put, fact } = await setup();
    const a = await put();
    const r = await client.call("ai.ask", { requestId: crypto.randomUUID(), question: "Archive invoices", timezone: "UTC" });
    expect(r).toEqual({ status: "command" });
    expect((await fact(a)).inInbox).toBe(true);
    expect(await client.call("ai.askHistory", {})).toEqual([]);
  });

  it("the plan sends no mail", async () => {
    const { model, put, preview } = await setup();
    await put({ subject: "CANARY invoice", bodyText: "CANARY" });
    await preview();
    expect(JSON.stringify(model.plans) + model.plans.map((r) => promptText(r.system)).join()).not.toContain("CANARY");
  });

  it("another connection gets nothing of it", async () => {
    const { put, preview, connect } = await setup();
    await put();
    const p = await preview();
    const other = connect("other");
    await expect(other.call("ai.actionPage", { previewId: p.previewId, offset: 0, limit: 10, leftOut: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.call("ai.actionApply", { previewId: p.previewId, future: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.call("ai.actionToggle", { previewId: p.previewId, threadId: 1, included: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("past 30 minutes it says so and acts on nothing; Cancel lets go at once", async () => {
    const { put, preview, apply, fact, clock, client } = await setup();
    const a = await put();
    const p = await preview();
    clock.now += 31 * 60_000;
    await expect(apply(p)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await fact(a)).inInbox).toBe(true);
    clock.now = NOW;
    const q = await preview();
    await client.call("ai.actionCancel", { previewId: q.previewId });
    await expect(apply(q)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a closed window ends its preview", async () => {
    const { backend, put, preview, client } = await setup();
    await put();
    const p = await preview();
    backend.actions.disconnected("renderer");
    await expect(client.call("ai.actionPage", { previewId: p.previewId, offset: 0, limit: 1, leftOut: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("what a sentence finds", () => {
  it("what it can't do, no condition, nothing found, and too many each say so", async () => {
    const { put, start } = await setup({ similarCap: 2 });
    expect(await start({ actionType: "forward" })).toEqual({ status: "refused" });
    expect(await start({ conditions: [] })).toEqual({ status: "noCondition" });
    expect(await start()).toEqual({ status: "noMatch", summary: "Do it" });
    await put();
    await put();
    await put();
    expect(await start()).toEqual({ status: "tooMany" });
  });

  it("archive needs the Inbox; everywhere leaves out Spam and Trash; what's already so isn't a row", async () => {
    const { backend, put, preview, rows } = await setup();
    const inbox = await put();
    const archived = await put();
    const trashed = await put();
    const spam = await put();
    const act = (id: number, action: "archive" | "trash" | "spam" | "star") => backend.store.threads.act({ threadIds: [id], action, signal: null, now: NOW });
    await act(archived, "archive");
    await act(trashed, "trash");
    await act(spam, "spam");
    expect(await rows(await preview())).toEqual([inbox]);
    const everywhere = await preview({ actionType: "markRead", lookIn: "everywhere" });
    expect(new Set(await rows(everywhere))).toEqual(new Set([inbox, archived]));
    await act(inbox, "star");
    const star = await preview({ actionType: "star", lookIn: "everywhere" });
    expect(await rows(star)).toEqual([archived]);
  });

  it("starred and replied are skipped and counted, and included on request; starring doesn't spare the replied", async () => {
    const { backend, put, preview, rows, apply, fact, client, account } = await setup();
    const plain = await put();
    const starred = await put();
    const replied = await put({ providerThreadId: "r" });
    await backend.store.threads.act({ threadIds: [starred], action: "star", signal: null, now: NOW });
    await put({ providerThreadId: "r", from: { name: "Me", email: account.email }, isSent: true, inInbox: false, subject: "Re: Invoice 12" });
    const p = await preview();
    expect(p).toMatchObject({ count: 1, skipped: 2 });
    expect(await rows(p)).toEqual([plain]);
    const withThem = await client.call("ai.actionIncludeSkipped", { previewId: p.previewId, included: true });
    expect(withThem.count).toBe(3);
    expect((await apply(p)).done).toBe(3);
    expect((await fact(starred)).inInbox).toBe(false);
    expect((await fact(replied)).inInbox).toBe(false);
    const star = await preview({ actionType: "star", lookIn: "everywhere" });
    expect(star.skipped).toBe(0);
  });

  it("newest first, by the conversation's date", async () => {
    const { put, preview, rows } = await setup();
    const old = await put({ date: NOW - 5 * DAY });
    const fresh = await put({ date: NOW - DAY });
    const mid = await put({ date: NOW - 3 * DAY });
    expect(await rows(await preview())).toEqual([fresh, mid, old]);
  });
});

onBoth(() => describe("what changed since the preview", () => {
  it("a reply that arrived is left alone and counted, and a star is respected", async () => {
    const { backend, put, preview, apply, fact } = await setup();
    const replied = await put({ providerThreadId: "t" });
    const starred = await put();
    const plain = await put();
    const p = await preview();
    await put({ providerThreadId: "t", subject: "Re: Invoice 12" });
    await backend.store.threads.act({ threadIds: [starred], action: "star", signal: null, now: NOW });
    const r = await apply(p);
    expect(r).toMatchObject({ done: 1, changed: 1, spared: 1 });
    expect((await fact(replied)).inInbox).toBe(true);
    expect((await fact(starred)).inInbox).toBe(true);
    expect((await fact(plain)).inInbox).toBe(false);
  });

  it("a category move and a folder move read it again too", async () => {
    const { backend, client, put, preview, apply, fact, account } = await setup();
    const category = await client.call("categories.create", { name: "Work", color: "rose" });
    const a = await put();
    const b = await put();
    const p = await preview({ actionType: "moveToCategory", categoryId: category.id, lookIn: "everywhere" });
    await backend.store.threads.act({ threadIds: [a], action: "star", signal: null, now: NOW });
    expect(await apply(p)).toMatchObject({ done: 1, spared: 1 });
    expect((await backend.store.filters.actionFacts([b], category.id))[0]!.inCategory).toBe(true);
    expect((await backend.store.filters.actionFacts([a], category.id))[0]!.inCategory).toBe(false);
    await backend.store.folders.replace(account.id, [{ key: "Old", path: ["Old"], selectable: true }]);
    const c = await put({ subject: "Invoice folder", providerThreadId: "fold" });
    const d = await put({ subject: "Invoice folder 2" });
    const q = await preview({ actionType: "moveToFolder", accountId: account.id, folder: "Old", conditions: [subjectHas("folder")] });
    await put({ providerThreadId: "fold", subject: "Re: Invoice folder" });
    const r = await apply(q);
    expect(r).toMatchObject({ done: 1, changed: 1 });
    expect((await fact(d)).inInbox).toBe(false);
    expect((await fact(c)).inInbox).toBe(true);
  });
}));

describe("a row acted on by hand", () => {
  it("leaves the preview's list and is counted as changed; its own action touched only it", async () => {
    const { client, put, preview, rows, apply, fact } = await setup();
    const a = await put();
    const b = await put();
    const p = await preview();
    await client.call("threads.act", { threadIds: [a], action: "archive" });
    expect(await rows(p)).toEqual([b]);
    expect((await fact(b)).inInbox).toBe(true);
    expect(await apply(p)).toMatchObject({ done: 1, changed: 1 });
  });
});

onBoth(() => describe("one Undo", () => {
  it.each([
    ["archive", (f: { inInbox: boolean }) => f.inInbox],
    ["trash", (f: { inTrash: boolean }) => !f.inTrash],
    ["spam", (f: { inSpam: boolean }) => !f.inSpam],
  ] as const)("%s comes back exactly", async (actionType, back) => {
    const { client, put, preview, apply, fact } = await setup();
    const a = await put();
    const r = await apply(await preview({ actionType, lookIn: "everywhere" }));
    expect(back((await fact(a)) as never)).toBe(false);
    await client.call("ai.actionUndo", { token: r.undoToken! });
    expect(back((await fact(a)) as never)).toBe(true);
    await expect(client.call("ai.actionUndo", { token: r.undoToken! })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("mark read and star come back to what each thread was", async () => {
    const { client, backend, put, preview, apply, fact } = await setup();
    const unread = await put({ isRead: false });
    const r = await apply(await preview({ actionType: "markRead", lookIn: "everywhere" }));
    expect((await fact(unread)).unread).toBe(false);
    await client.call("ai.actionUndo", { token: r.undoToken! });
    expect((await fact(unread)).unread).toBe(true);
    const s = await apply(await preview({ actionType: "star", lookIn: "everywhere" }));
    expect((await fact(unread)).starred).toBe(true);
    await client.call("ai.actionUndo", { token: s.undoToken! });
    expect((await backend.store.filters.actionFacts([unread]))[0]!.starred).toBe(false);
  });

  it("a move to a category leaves as it came, whatever category it was in", async () => {
    const { client, backend, put, preview, apply } = await setup();
    const from = await client.call("categories.create", { name: "From", color: "rose" });
    const to = await client.call("categories.create", { name: "To", color: "lime" });
    const a = await put();
    await client.call("categories.addThreads", { categoryId: from.id, threadIds: [a], source: "picker" });
    const r = await apply(await preview({ actionType: "moveToCategory", categoryId: to.id, lookIn: "everywhere" }));
    const inCat = async (id: number) => (await backend.store.filters.actionFacts([a], id))[0]!.inCategory;
    expect([await inCat(from.id), await inCat(to.id)]).toEqual([false, true]);
    await client.call("ai.actionUndo", { token: r.undoToken! });
    expect([await inCat(from.id), await inCat(to.id)]).toEqual([true, false]);
  });

  it("a folder move comes back", async () => {
    const { client, backend, put, preview, apply, fact, account } = await setup();
    await backend.store.folders.replace(account.id, [{ key: "Old", path: ["Old"], selectable: true }]);
    const a = await put();
    const r = await apply(await preview({ actionType: "moveToFolder", accountId: account.id, folder: "Old" }));
    expect((await fact(a)).inInbox).toBe(false);
    await client.call("ai.actionUndo", { token: r.undoToken! });
    expect((await fact(a)).inInbox).toBe(true);
  });

  it("a category it made goes only while empty and as it was made; one z takes the filter with it", async () => {
    const { client, backend, put, preview, apply } = await setup();
    const a = await put();
    const made = await apply(await preview({ actionType: "createCategory", categoryName: "Recruiting", lookIn: "everywhere", future: true }), true);
    const named = async () => (await backend.store.categories.list()).find((c) => c.name === "Recruiting");
    expect(await named()).toMatchObject({ showInInbox: false });
    expect(made.filterSaved).toBe(true);
    expect((await backend.store.filters.list()).map((f) => f.source)).toEqual(["ai"]);
    await client.call("ai.actionUndo", { token: made.undoToken! });
    expect(await named()).toBeUndefined();
    expect(await backend.store.filters.list()).toEqual([]);

    // edited since: it's the user's now
    const again = await apply(await preview({ actionType: "createCategory", categoryName: "Recruiting", lookIn: "everywhere" }));
    await client.call("categories.update", { id: (await named())!.id, color: "cyan" });
    await client.call("ai.actionUndo", { token: again.undoToken! });
    expect(await named()).toBeDefined();
    await client.call("categories.delete", { id: (await named())!.id });

    // holding something else now: stays too
    const other = await put({ subject: "Lunch" });
    const third = await apply(await preview({ actionType: "createCategory", categoryName: "Recruiting", lookIn: "everywhere" }));
    await client.call("categories.addThreads", { categoryId: (await named())!.id, threadIds: [other], source: "picker" });
    await client.call("ai.actionUndo", { token: third.undoToken! });
    expect(await named()).toBeDefined();
    expect((await backend.store.filters.actionFacts([a], (await named())!.id))[0]!.inCategory).toBe(false);
  });

  it("a filter edited since survives the Undo", async () => {
    const { client, backend, put, preview, apply } = await setup();
    await put();
    const r = await apply(await preview({ future: true }), true);
    const [f] = await backend.store.filters.list();
    await backend.store.filters.save({ id: f!.id, name: "Mine now", enabled: f!.enabled, rule: f!.rule, source: f!.source }, NOW);
    await client.call("ai.actionUndo", { token: r.undoToken! });
    expect((await backend.store.filters.list()).map((x) => x.name)).toEqual(["Mine now"]);
  });

  it("a failure partway keeps what committed with its Undo, and says how much", async () => {
    const { client, backend, put, preview, apply, fact } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push(await put());
    const p = await preview();
    const act = backend.store.threads.act.bind(backend.store.threads);
    let calls = 0;
    const spy = vi.spyOn(backend.store.threads, "act").mockImplementation(async (q) => {
      if (++calls === 2) throw new Error("disk full");
      return act(q);
    });
    const r = await apply(p);
    spy.mockRestore();
    expect(r).toMatchObject({ failed: true, stopped: true });
    expect(r.done).toBeGreaterThan(0);
    expect(r.done).toBeLessThan(60);
    const gone = (await Promise.all(ids.map(fact))).filter((f) => !f.inInbox).length;
    expect(gone).toBe(r.done);
    await client.call("ai.actionUndo", { token: r.undoToken! });
    expect((await Promise.all(ids.map(fact))).every((f) => f.inInbox)).toBe(true);
  });

  it("nothing committed: the failure as it is, and the preview's gone", async () => {
    const { backend, put, preview, apply } = await setup();
    await put();
    const p = await preview();
    const spy = vi.spyOn(backend.store.threads, "act").mockRejectedValue(new Error("disk full"));
    await expect(apply(p)).rejects.toBeTruthy();
    spy.mockRestore();
  });

  it("Stop ends it between slices, in actions and moves, with Undo for what committed and nothing left for startup", async () => {
    const { client, backend, put, preview, apply, fact } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push(await put());
    const p = await preview();
    const act = backend.store.threads.act.bind(backend.store.threads);
    const spy = vi.spyOn(backend.store.threads, "act").mockImplementation(async (q) => {
      const r = await act(q);
      await client.call("ai.actionStop", { previewId: p.previewId });
      return r;
    });
    const r = await apply(p);
    spy.mockRestore();
    expect(r.stopped).toBe(true);
    expect(r.failed).toBe(false);
    expect(r.done).toBeLessThan(60);
    await client.call("ai.actionUndo", { token: r.undoToken! });
    expect((await Promise.all(ids.map(fact))).every((f) => f.inInbox)).toBe(true);

    const to = await client.call("categories.create", { name: "To", color: "lime" });
    const q = await preview({ actionType: "moveToCategory", categoryId: to.id, lookIn: "everywhere" });
    await client.call("ai.actionStop", { previewId: q.previewId });
    const stopped = await apply(q);
    expect(stopped).toMatchObject({ done: 0, stopped: true });
    expect(await backend.store.categories.unfinishedMoves()).toEqual([]);
  });

  it("a thread starred after a move's first slice stays, and Stop falls between its slices", async () => {
    const { client, backend, put, preview, apply } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push(await put());
    const to = await client.call("categories.create", { name: "To", color: "lime" });
    const p = await preview({ actionType: "moveToCategory", categoryId: to.id, lookIn: "everywhere" });
    const begin = backend.store.categories.beginMove.bind(backend.store.categories);
    let first = true;
    let late = 0;
    const spy = vi.spyOn(backend.store.categories, "beginMove").mockImplementation(async (m) => {
      if (first) {
        first = false;
        late = ids.find((id) => !m.threadIds.includes(id))!;
        await backend.store.threads.act({ threadIds: [late], action: "star", signal: null, now: NOW });
      }
      return begin(m);
    });
    const r = await apply(p);
    spy.mockRestore();
    expect(r.spared).toBe(1);
    expect((await backend.store.filters.actionFacts([late], to.id))[0]!.inCategory).toBe(false);
    expect(r.done).toBe(59);
  });

  it("a slice commits in the turn it was read: nothing can arrive or stop it between", async () => {
    const { client, backend, put, preview, apply } = await setup();
    await put();
    const to = await client.call("categories.create", { name: "To", color: "lime" });
    const p = await preview({ actionType: "moveToCategory", categoryId: to.id, lookIn: "everywhere" });
    const facts = backend.store.filters.actionFacts.bind(backend.store.filters);
    let turned = false;
    const read = vi.spyOn(backend.store.filters, "actionFacts").mockImplementation(async (...a) => {
      const r = await facts(...a);
      turned = false;
      setImmediate(() => (turned = true));
      return r;
    });
    const slice = backend.store.categories.applyMoveSlice.bind(backend.store.categories);
    let at: boolean | null = null;
    const write = vi.spyOn(backend.store.categories, "applyMoveSlice").mockImplementation(async (...a) => {
      at = turned;
      return slice(...a);
    });
    await apply(p);
    read.mockRestore();
    write.mockRestore();
    expect(at).toBe(false);
  });

  it("training that fails after the mail moved: what moved counts, and its Undo and reminders are in order", async () => {
    const { client, backend, put, preview, apply } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push(await put());
    const r0 = await apply(await preview({ actionType: "createCategory", categoryName: "Hidden", lookIn: "everywhere" }));
    await client.call("ai.actionUndo", { token: r0.undoToken! });
    const to = await client.call("categories.create", { name: "To", color: "lime" });
    const p = await preview({ actionType: "moveToCategory", categoryId: to.id, lookIn: "everywhere" });
    const ended = vi.spyOn(backend.reminders, "endDue");
    const train = vi.spyOn(backend.store.categories, "trainMoveSlice").mockRejectedValueOnce(new Error("disk full"));
    const r = await apply(p);
    const moved = (await backend.store.filters.actionFacts(ids, to.id)).filter((f) => f.inCategory).length;
    expect(moved).toBeGreaterThan(0);
    expect(r).toMatchObject({ failed: true, done: moved });
    expect(ended.mock.calls.flatMap((c) => c[0])).toEqual(expect.arrayContaining((await backend.store.filters.actionFacts(ids, to.id)).filter((f) => f.inCategory).map((f) => f.id)));
    train.mockRestore();
    ended.mockRestore();
    await client.call("ai.actionUndo", { token: r.undoToken! });
    expect((await backend.store.filters.actionFacts(ids, to.id)).filter((f) => f.inCategory)).toEqual([]);
  });

  it("a move's slice that fails keeps its Undo, and nothing's left for the next start", async () => {
    const { client, backend, put, preview, apply } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push(await put());
    const to = await client.call("categories.create", { name: "To", color: "lime" });
    const p = await preview({ actionType: "moveToCategory", categoryId: to.id, lookIn: "everywhere" });
    const slice = backend.store.categories.applyMoveSlice.bind(backend.store.categories);
    let calls = 0;
    const spy = vi.spyOn(backend.store.categories, "applyMoveSlice").mockImplementation(async (...a) => {
      if (++calls === 2) throw new Error("disk full");
      return slice(...a);
    });
    const r = await apply(p);
    spy.mockRestore();
    expect(r).toMatchObject({ failed: true, stopped: true });
    expect(r.undoToken).not.toBeNull();
    const inTo = async () => (await backend.store.filters.actionFacts(ids, to.id)).filter((f) => f.inCategory).length;
    expect(await inTo()).toBeGreaterThan(0);
    await vi.waitFor(async () => expect((await backend.store.categories.unfinishedMoves()).filter((m) => m.phase === "moving")).toEqual([]));
    await client.call("ai.actionUndo", { token: r.undoToken! });
    expect(await inTo()).toBe(0);
  });
}));

onBoth(() => describe("the check's order", () => {
  it("newest first whichever store answers, so what's left unchecked is the oldest", async () => {
    const { model, backend, preview, check } = await setup();
    const account = (await backend.store.accounts.list())[0]!;
    await backend.ingestSliced(Array.from({ length: 700 }, (_, i) => msg({ accountId: account.id, date: NOW - DAY - (700 - i) * 60_000, from: { name: `N${i}`, email: `n${i}@d${i}.test` }, subject: "Invoice", providerMsgId: `x-${i}` })), true);
    const r = await check(await preview({ meaning: true }));
    if (r.status !== "done") throw new Error(r.status);
    const sent = model.checks.map((q) => promptText(q.messages[0]!.content)).join();
    expect(sent).toContain(">N699 ·");
    expect(sent).not.toContain(">N0 ·");
    expect(r.preview.unchecked).toBe(100);
  });
}));

describe("the check", () => {
  const meaning = { meaning: true };

  it("sends a sender's name, domain and a subject's shape: never a body, never an address, in any field", async () => {
    const { model, put, preview, check, rows } = await setup();
    await put({ subject: "Invoice 12 for bob@secret.test", bodyText: "BODY-CANARY", from: { name: "", email: "nameless@acme.test" } });
    await put({ subject: "Invoice 13", from: { name: "carla@secret.test", email: "carla@acme.test" } });
    const p = await preview(meaning);
    const r = await check(p);
    expect(r.status).toBe("done");
    const sent = model.checks.map((q) => JSON.stringify(q.messages) + promptText(q.system)).join();
    expect(sent).toContain("acme.test");
    expect(sent).not.toContain("BODY-CANARY");
    expect(sent).not.toContain("@");
    expect(await rows(p)).toHaveLength(2);
  });

  it("unusual addresses go too: an accent, a quoted name", async () => {
    const { model, put, preview, check } = await setup();
    await put({ subject: 'Invoice from josé@example.com, admin@[192.168.1.10], root@[IPv6:2001:db8::1] and "anna smith"@example.com', from: { name: "josé@example.com", email: "a@acme.test" } });
    await check(await preview(meaning));
    expect(model.checks.map((q) => promptText(q.messages[0]!.content)).join()).not.toMatch(/@|anna smith|josé|192\.168|2001:db8/i);
  });

  it("Skip after a check that failed leaves the rule's matches in", async () => {
    const { model, put, preview, check, apply } = await setup();
    await put();
    model.check = () => {
      throw new Error("down");
    };
    const p = await preview(meaning);
    await expect(check(p)).rejects.toBeTruthy();
    const r = await check(p, { skip: true });
    if (r.status !== "done") throw new Error(r.status);
    expect(r.preview).toMatchObject({ count: 1, unchecked: 0, check: "skipped" });
    expect((await apply(p)).done).toBe(1);
  });

  it.each(["cancel", "account", "clear"] as const)("%s while a check runs: nothing more goes", async (how) => {
    const { client, model, backend, preview, check, account } = await setup();
    await backend.ingestSliced(Array.from({ length: 450 }, (_, i) => msg({ accountId: account.id, date: NOW - DAY, from: { name: `N${i}`, email: `n${i}@d${i}.test` }, subject: "Invoice", providerMsgId: `x-${i}` })), true);
    const p = await preview(meaning);
    model.check = () => {
      if (how === "cancel") void client.call("ai.actionCancel", { previewId: p.previewId });
      else backend.actions.invalidate(how === "account" ? account.id : null);
      return JSON.stringify({ drop: [] });
    };
    await check(p).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(model.checks).toHaveLength(1);
    await expect(client.call("ai.actionPage", { previewId: p.previewId, offset: 0, limit: 1, leftOut: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cleared while its groups are being built: nothing goes, and it holds nothing", async () => {
    const { model, backend, put, preview, check } = await setup();
    await put();
    const p = await preview(meaning);
    const facts = backend.store.filters.actionFacts.bind(backend.store.filters);
    const spy = vi.spyOn(backend.store.filters, "actionFacts").mockImplementation(async (...a) => {
      backend.actions.invalidate(null);
      return facts(...a);
    });
    await expect(check(p)).rejects.toBeTruthy();
    spy.mockRestore();
    expect(model.checks).toEqual([]);
  });

  it("only drop removes; an unknown label is ignored; left-out rows come last, unticked, and can be ticked back", async () => {
    const { client, model, put, preview, check, rows, apply, fact } = await setup();
    const keep = await put({ subject: "Invoice one", from: { name: "Ana", email: "ana@acme.test" }, date: NOW - DAY });
    const drop = await put({ subject: "Invoice two", from: { name: "Bob", email: "bob@other.test" }, date: NOW - 2 * DAY });
    model.check = (req) => {
      const label = /<group id="(g\d+)"[^>]*>Bob/.exec(promptText(req.messages[0]!.content))![1];
      return JSON.stringify({ drop: [label, "g99"] });
    };
    const p = await preview(meaning);
    expect(p.check).toBe("needed");
    await expect(apply(p)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const r = await check(p);
    if (r.status !== "done") throw new Error(r.status);
    expect(r.preview).toMatchObject({ count: 1, leftOut: 1, check: "done" });
    expect(await rows(p)).toEqual([keep]);
    const all = await client.call("ai.actionPage", { previewId: p.previewId, offset: 0, limit: 10, leftOut: true });
    expect(all.items.map((t) => t.id)).toEqual([keep, drop]);
    expect(all.unticked).toEqual([drop]);
    expect((await client.call("ai.actionToggle", { previewId: p.previewId, threadId: drop, included: true })).count).toBe(2);
    await client.call("ai.actionToggle", { previewId: p.previewId, threadId: drop, included: false });
    await apply(p);
    expect((await fact(drop)).inInbox).toBe(true);
    expect((await fact(keep)).inInbox).toBe(false);
  });

  it("200 groups a request, 3 requests at most; what's left is left out and named, and Check more goes on", async () => {
    const { client, model, backend, preview, check } = await setup();
    const account = (await backend.store.accounts.list())[0]!;
    const many = Array.from({ length: 700 }, (_, i) => msg({ accountId: account.id, date: NOW - DAY, from: { name: `N${i}`, email: `n${i}@d${i}.test` }, subject: "Invoice", providerMsgId: `x-${i}` }));
    await backend.ingestSliced(many, true);
    const p = await preview(meaning);
    const r = await check(p);
    if (r.status !== "done") throw new Error(r.status);
    expect(model.checks).toHaveLength(3);
    for (const q of model.checks) expect(promptText(q.messages[0]!.content).match(/<group /g)!.length).toBeLessThanOrEqual(200);
    expect(r.preview).toMatchObject({ count: 600, unchecked: 100 });
    expect(r.preview.keep).toEqual({ kind: "disabled", reason: "exceptions" });
    const more = await check(p);
    if (more.status !== "done") throw new Error(more.status);
    expect(more.preview).toMatchObject({ count: 700, unchecked: 0 });
    expect(await client.call("ai.actionPage", { previewId: p.previewId, offset: 0, limit: 1, leftOut: false })).toMatchObject({ total: 700 });
  });

  it("broken answers cost repairs, and at most 6 requests go for one check", async () => {
    const { model, backend, preview, check } = await setup();
    const account = (await backend.store.accounts.list())[0]!;
    await backend.ingestSliced(Array.from({ length: 450 }, (_, i) => msg({ accountId: account.id, date: NOW - DAY, from: { name: `N${i}`, email: `n${i}@d${i}.test` }, subject: "Invoice", providerMsgId: `x-${i}` })), true);
    model.check = (_req, n) => (n < 2 ? "not json" : JSON.stringify({ drop: [] }));
    const p = await preview(meaning);
    await check(p).catch(() => null);
    expect(model.checks.length).toBeLessThanOrEqual(6);
    model.checks.length = 0;
    model.check = () => "not json";
    const q = await preview(meaning);
    await check(q).catch(() => null);
    expect(model.checks.length).toBeLessThanOrEqual(6);
  });

  it("a literal sentence sends nothing past its plan, and Skip sends nothing", async () => {
    const { model, put, preview, check, apply } = await setup();
    await put();
    const literal = await preview();
    expect(literal.check).toBe("none");
    await check(literal);
    expect(model.checks).toEqual([]);
    await apply(literal);
    await put({ subject: "Invoice 2" });
    const p = await preview(meaning);
    const r = await check(p, { skip: true });
    if (r.status !== "done") throw new Error(r.status);
    expect(r.preview).toMatchObject({ check: "skipped", count: 1 });
    expect(model.checks).toEqual([]);
    expect((await apply(p)).done).toBe(1);
  });

  it("consent is once a destination, tells where, and nothing leaves before it", async () => {
    const { client, model, put, preview, check } = await setup({ cloud: true });
    await put();
    const acked = await client.call("ai.ask", { requestId: crypto.randomUUID(), question: "x", timezone: "UTC" });
    if (acked.status !== "consent") throw new Error(acked.status);
    await client.call("ai.ask", { requestId: crypto.randomUUID(), question: "x", timezone: "UTC", acknowledge: acked.destination });
    const p = await preview(meaning);
    const first = await check(p);
    if (first.status !== "consent") throw new Error(first.status);
    expect(first.provider).toBe("anthropic");
    expect(model.checks).toEqual([]);
    expect((await check(p, { acknowledge: "somewhere-else" })).status).toBe("consent");
    expect(model.checks).toEqual([]);
    expect((await check(p, { acknowledge: first.destination })).status).toBe("done");
    expect(model.checks).toHaveLength(1);
    const q = await preview(meaning);
    expect((await check(q)).status).toBe("done");
  });

  it("the sentence itself needs the question's agreement first", async () => {
    const { model, put, start } = await setup({ cloud: true });
    await put();
    expect(await start()).toMatchObject({ status: "consent" });
    expect(model.plans).toEqual([]);
  });
});

describe("+ new mail too", () => {
  it("unticked saves nothing; ticked saves one under Your filters, reused when it's the same, and it matches what arrives", async () => {
    const { backend, put, preview, apply, fact } = await setup();
    await put();
    await apply(await preview());
    expect(await backend.store.filters.list()).toEqual([]);
    await put({ subject: "Invoice 2" });
    const r = await apply(await preview({ future: true, summary: "Archive invoices" }), true);
    expect(r.filterSaved).toBe(true);
    const [f] = await backend.store.filters.list();
    expect(f).toMatchObject({ name: "Archive invoices", source: "ai", auto: false, enabled: true });
    expect(f!.rule.conditions).toHaveLength(1);
    // it holds for new mail: this one never stays in the Inbox
    const arrival = await put({ subject: "Invoice 3" });
    expect((await fact(arrival)).inInbox).toBe(false);
    await backend.store.threads.act({ threadIds: [arrival], action: "moveToInbox", signal: null, now: NOW });
    expect((await apply(await preview({ future: true }), true)).filterSaved).toBe(true);
    expect(await backend.store.filters.list()).toHaveLength(1);
  });

  it("an age limit hides it; nothing asks for it from a preview that can't", async () => {
    const { backend, put, preview, apply } = await setup();
    await put({ date: NOW - 60 * DAY });
    const p = await preview({ conditions: [subjectHas("invoice"), { field: "ageDays", op: "gt", value: "30", negate: false }] });
    expect(p.keep).toEqual({ kind: "hidden" });
    const r = await apply(p, true);
    expect(r.filterSaved).toBe(false);
    expect(await backend.store.filters.list()).toEqual([]);
  });

  it("a category that forwards can't take a filter; a move into it forwards nothing, one conversation or many", async () => {
    const { client, backend, preview, apply } = await setup();
    const category = await client.call("categories.create", { name: "Boss", color: "rose" });
    await client.call("categories.setForward", { categoryId: category.id, forward: { addresses: [{ name: "Boss", email: "boss@x.test" }], enabled: true } });
    const account = (await backend.store.accounts.list())[0]!;
    const live = msg({ accountId: account.id, date: NOW - 1000, subject: "Invoice live", providerMsgId: "live" });
    const { inserted } = await backend.ingestSliced([live], true);
    expect(inserted).toHaveLength(1);
    const p = await preview({ actionType: "moveToCategory", categoryId: category.id, lookIn: "everywhere", future: true });
    expect(p.keep).toEqual({ kind: "disabled", reason: "forwarding" });
    expect(p.forwards).toBe(true);
    const r = await apply(p, true);
    expect(r).toMatchObject({ done: 1, filterSaved: false });
    expect(await backend.store.filters.list()).toEqual([]);
    expect(await backend.store.forwards.list(NOW, 10)).toEqual([]);
    // the next sync's touch, or the start's sweep, reads the same membership
    backend.planForwards({ threadIds: [await threadOf(backend.store, "live")] });
    await vi.waitFor(async () => expect(await backend.store.forwards.list(NOW, 10)).toEqual([]));
  });

  it("forwarding is read again at Apply", async () => {
    const { client, backend, put, preview, apply } = await setup();
    const category = await client.call("categories.create", { name: "Later", color: "rose" });
    await put();
    const p = await preview({ actionType: "moveToCategory", categoryId: category.id, lookIn: "everywhere", future: true });
    expect(p.keep).toEqual({ kind: "ok" });
    await client.call("categories.setForward", { categoryId: category.id, forward: { addresses: [{ name: "Boss", email: "boss@x.test" }], enabled: true } });
    const r = await apply(p, true);
    expect(r).toMatchObject({ filterSaved: false, filterFailed: true });
    expect(await backend.store.filters.list()).toEqual([]);
  });

  describe("what the check dropped", () => {
    const dropping = (name: string) => (req: CompletionRequest) => JSON.stringify({ drop: [...promptText(req.messages[0]!.content).matchAll(new RegExp(`<group id="(g\\d+)"[^>]*>${name}`, "g"))].map((m) => m[1]) });

    it("a wholly dropped domain becomes an exception the rule states, and a new arrival follows it", async () => {
      const { backend, model, put, preview, check, apply } = await setup();
      await put({ from: { name: "Ana", email: "ana@keep.test" } });
      await put({ from: { name: "Bob", email: "bob@drop.test" } });
      model.check = dropping("Bob");
      const p = await preview({ meaning: true, future: true });
      const r = await check(p);
      if (r.status !== "done") throw new Error(r.status);
      expect(r.preview.keep).toEqual({ kind: "ok" });
      expect(r.preview.keepConditions).toContainEqual({ field: "fromDomain", op: "equals", value: "drop.test", negate: true });
      await apply(p, true);
      const [f] = await backend.store.filters.list();
      const one = await backend.ingestSliced([msg({ accountId: (await backend.store.accounts.list())[0]!.id, date: NOW, subject: "Invoice new", from: { name: "Bob", email: "bob@drop.test" }, providerMsgId: "n1" })], true);
      const two = await backend.ingestSliced([msg({ accountId: (await backend.store.accounts.list())[0]!.id, date: NOW, subject: "Invoice new", from: { name: "Ana", email: "ana@keep.test" }, providerMsgId: "n2" })], true);
      expect(await backend.store.filters.matchMessages(f!.rule, NOW, [...one.inserted, ...two.inserted])).toEqual(two.inserted);
    });

    it("a domain with something kept can't say it, nor can a shared mail domain: disabled, with its reason", async () => {
      const { model, put, preview, check, backend } = await setup();
      await put({ subject: "Invoice one", from: { name: "Ana", email: "ana@both.test" } });
      await put({ subject: "Invoice two", from: { name: "Bob", email: "bob@both.test" } });
      model.check = dropping("Bob");
      const p = await preview({ meaning: true });
      const r = await check(p);
      if (r.status !== "done") throw new Error(r.status);
      expect(r.preview.keep).toEqual({ kind: "disabled", reason: "exceptions" });
      await backend.store.threads.act({ threadIds: await backend.store.filters.threadsOf(await backend.store.filters.messageWalk().next(100)), action: "archive", signal: null, now: NOW });
      await put({ subject: "Invoice three", from: { name: "Cara", email: "cara@gmail.com" } });
      model.check = dropping("Cara");
      const q = await preview({ meaning: true });
      const s = await check(q);
      if (s.status !== "done") throw new Error(s.status);
      expect(s.preview.keep).toEqual({ kind: "disabled", reason: "exceptions" });
    });
  });
});

describe("history", () => {
  it("a command is a turn with its sentence, what it meant and what came of it, and no rows", async () => {
    const { client, put, preview, apply } = await setup();
    await put();
    const r = await apply(await preview({ summary: "Archive invoices" }));
    expect(r.conversationId).not.toBeNull();
    const c = await client.call("ai.askConversation", { conversationId: r.conversationId! });
    expect(c!.turns[0]).toMatchObject({ kind: "command", question: "the sentence", sources: [], status: "answered" });
    expect(c!.turns[0]!.answer).toContain("Archive invoices");
    expect(c!.turns[0]!.answer).toContain("Archived 1 conversation");
  });
});

describe("what the real-mail panel changed", () => {
  it("\"from now on\" acts on what's here too, and keeps the rule for what comes", async () => {
    const { client, backend, put, preview } = await setup();
    const id = await put();
    const p = await preview({ future: true });
    expect(p).toMatchObject({ count: 1, plan: { future: true } });
    expect(await client.call("ai.actionApply", { previewId: p.previewId, future: true })).toMatchObject({ done: 1, filterSaved: true });
    expect(await backend.store.filters.list()).toHaveLength(1);
    expect((await backend.store.threads.summaries([id]))[0]!.inInbox).toBe(false);
  });

  it("nothing to do says how many the rule found that are already done or out of reach", async () => {
    const { client, backend, put, model } = await setup();
    const id = await put();
    await backend.store.threads.act({ threadIds: [id], action: "spam", signal: null, now: NOW });
    model.plan = planWire({ actionType: "spam", lookIn: "everywhere" });
    const r = await client.call("ai.actionStart", { requestId: crypto.randomUUID(), sentence: "spam the invoices", timezone: "UTC" } as never);
    expect(r).toMatchObject({ status: "noMatch", done: 1 });
  });

  it("a delete's check tells the model to keep out what it's unsure of", async () => {
    const { put, preview, client, model } = await setup();
    await put();
    const p = await preview({ actionType: "trash", lookIn: "everywhere", meaning: true });
    await client.call("ai.actionCheck", { previewId: p.previewId, requestId: crypto.randomUUID() } as never);
    expect(model.checks[0]!.system).toMatch(/aren't sure/);
  });
});


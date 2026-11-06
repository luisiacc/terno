/**
 * Plan 144 through the real backend, with a scripted model and a recording transport: nothing leaves this process.
 * Rows are the conformance suite's; here, what opens spend, what they don't, and that nothing can send.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { msg, threadOf } from "@terno/store/conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = new Date(2026, 10, 5, 12).getTime();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(o: { on?: boolean; cloud?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-replies-"));
  const model = {
    checks: [] as CompletionRequest[],
    drafts: [] as CompletionRequest[],
    configs: [] as ProviderConfig[],
    wanted: true as boolean | Error,
    /** held until released: what happens while it writes */
    gate: null as Promise<void> | null,
    checkGate: null as Promise<void> | null,
  };
  const factory = (config: ProviderConfig, options: AiOptions) => {
    model.configs.push(config);
    return createAi(config, {
      ...options,
      transport: {
        complete: async (req): Promise<Completion> => {
          if (req.schema?.name === "needs_reply") {
            model.checks.push(req);
            if (model.checkGate) await model.checkGate;
            if (req.signal?.aborted) throw new Error("aborted");
            if (model.wanted instanceof Error) throw model.wanted;
            return { text: JSON.stringify({ needsReply: model.wanted }), stop: "end" };
          }
          model.drafts.push(req);
          return { text: "<email>Hola Ana, el 19 me viene bien.</email>", stop: "end" };
        },
        stream: async function* (req: CompletionRequest) {
          model.drafts.push(req);
          yield { type: "delta" as const, text: "<email>Hola Ana, " };
          if (model.gate) await model.gate;
          if (req.signal?.aborted) throw new Error("aborted");
          yield { type: "delta" as const, text: "el 19 me viene bien.</email>" };
          yield { type: "done" as const, stop: "end" as const };
        },
      },
    });
  };
  const clock = { now: NOW };
  const backend = new Backend({ dbPath: join(dir, "a.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now });
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
  if (o.on !== false) await client.call("settings.update", { replies: { enabled: true } });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const raw = (backend.store as unknown as { db: { run(sql: string, ...a: unknown[]): unknown } }).db;
  const put = async (over: Partial<IncomingMessage> = {}) => {
    const m = msg({ accountId: account.id, date: NOW - 3_600_000, from: { name: "Ana", email: "ana@acme.test" }, to: [{ name: "Me", email: account.email }], subject: "The 19th", bodyText: "Can you make the 19th?", providerMsgId: `m-${seq++}`, ...over });
    await backend.ingestSliced([m], true);
    const id = await threadOf(backend.store, m.providerMsgId!);
    raw.run("UPDATE threads SET waiting_since = ? WHERE id = ?", NOW - 3_600_000, id);
    return id;
  };
  const ANA = { name: "Ana", email: "ana@acme.test" };
  const prepare = (threadId: number, c = client) => c.call("ai.prepareReply", { threadId, accountId: account.id, to: [ANA], cc: [], timezone: "UTC" });
  const row = (threadId: number) => backend.store.replies.get(threadId);
  const settled = (threadId: number, state: string) => vi.waitFor(async () => expect((await row(threadId))?.state).toBe(state));
  return { backend, client, connect, model, account, put, prepare, row, settled, ANA, clock, raw };
}

describe("what an open spends", () => {
  it("off: nothing goes, and no row", async () => {
    const { model, put, prepare, row } = await setup({ on: false });
    const t = await put();
    expect(await prepare(t)).toEqual({ status: "none" });
    expect(model.checks).toEqual([]);
    expect(await row(t)).toBeNull();
  });

  it("each condition alone stops it, whatever the window thought", async () => {
    const { backend, client, model, put, prepare, account, raw } = await setup();
    const notWaiting = await put();
    raw.run("UPDATE threads SET waiting_since = NULL WHERE id = ?", notWaiting);
    expect(await prepare(notWaiting)).toEqual({ status: "none" });
    const old = await put({ subject: "Old" });
    raw.run("UPDATE threads SET waiting_since = ? WHERE id = ?", NOW - 31 * 86_400_000, old);
    expect(await prepare(old)).toEqual({ status: "none" });
    const spam = await put({ subject: "Spam" });
    await backend.store.threads.act({ threadIds: [spam], action: "spam", signal: null, now: NOW });
    expect(await prepare(spam)).toEqual({ status: "none" });
    const archived = await put({ subject: "Archived" });
    await backend.store.threads.act({ threadIds: [archived], action: "archive", signal: null, now: NOW });
    expect(await prepare(archived)).toEqual({ status: "none" });
    const muted = await put({ subject: "Muted" });
    await client.call("writing.prefs.set", { account: { accountId: account.id, prefs: { prepareReplies: false } } });
    expect(await prepare(muted)).toEqual({ status: "none" });
    await client.call("writing.prefs.set", { account: { accountId: account.id, prefs: { prepareReplies: true } } });
    const drafted = await put({ subject: "Drafted" });
    await backend.store.drafts.save({ thread_id: drafted, account_id: account.id, subject: "x", body_text: "x", body_html: "<p>x</p>" } as never, NOW).catch(() => null);
    expect(model.checks).toEqual([]);
  });

  it("a yes writes it and stores it; reopening at that state costs nothing, in every state", async () => {
    const { client, model, put, prepare, row, settled } = await setup();
    const t = await put();
    expect(await prepare(t)).toEqual({ status: "started" });
    await settled(t, "ready");
    expect((await row(t))!.body).toContain("Hola Ana");
    expect(model.checks).toHaveLength(1);
    expect(model.drafts).toHaveLength(1);
    expect(await prepare(t)).toMatchObject({ status: "ready" });
    expect(model.checks).toHaveLength(1);
    const r = await row(t);
    await client.call("ai.replyAct", { threadId: t, rowId: r!.rowId, revision: r!.revision, action: "dismiss" });
    expect(await prepare(t)).toEqual({ status: "none" });
    expect(model.checks).toHaveLength(1);
  });

  it("a no is kept and sends no draft; a failure is kept too, and no retry", async () => {
    const { model, put, prepare, settled } = await setup();
    model.wanted = false;
    const no = await put();
    await prepare(no);
    await settled(no, "skipped");
    expect(model.drafts).toEqual([]);
    expect(await prepare(no)).toEqual({ status: "none" });
    expect(model.checks).toHaveLength(1);
    model.wanted = new Error("boom");
    const bad = await put({ subject: "Broken" });
    await prepare(bad);
    await settled(bad, "failed");
    const n = model.checks.length;
    expect(await prepare(bad)).toEqual({ status: "none" });
    expect(model.checks).toHaveLength(n);
  });

  it("a new message hides what was there, and the next open starts over", async () => {
    const { model, put, prepare, settled } = await setup();
    const t = await put({ providerThreadId: "x" });
    await prepare(t);
    await settled(t, "ready");
    await put({ providerThreadId: "x", subject: "Re: The 19th", bodyText: "Or the 20th?" });
    expect(await prepare(t)).toEqual({ status: "started" });
    await vi.waitFor(() => expect(model.drafts).toHaveLength(2));
  });

  it("two windows pay once, and leaving stops it only before the first word, once nobody's left", async () => {
    const { model, put, prepare, connect, row, settled, client } = await setup();
    let release!: () => void;
    model.checkGate = new Promise((r) => (release = r));
    const t = await put();
    const other = connect("other");
    await prepare(t);
    expect(await prepare(t, other)).toEqual({ status: "started" });
    await client.call("ai.replyLeave", { threadId: t });
    await other.call("ai.replyLeave", { threadId: t });
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(model.drafts).toEqual([]);
    expect(await row(t)).toBeNull();

    // after it: paid for, so it finishes and is kept
    model.checkGate = null;
    let write!: () => void;
    model.gate = new Promise((r) => (write = r));
    const u = await put({ subject: "Later" });
    await prepare(u);
    await vi.waitFor(() => expect(model.drafts.length).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    await client.call("ai.replyLeave", { threadId: u });
    write();
    await settled(u, "ready");
  });

  it("the switch going off, Clear AI data or moving to Spam mid-way write nothing", async () => {
    const { backend, client, model, put, prepare, row } = await setup();
    let write!: () => void;
    model.gate = new Promise((r) => (write = r));
    const t = await put();
    await prepare(t);
    await vi.waitFor(() => expect(model.drafts.length).toBe(1));
    await client.call("settings.update", { replies: { enabled: false } });
    write();
    await new Promise((r) => setTimeout(r, 30));
    expect(await row(t)).toBeNull();
    await client.call("settings.update", { replies: { enabled: true } });

    model.gate = new Promise((r) => (write = r));
    model.drafts.length = 0;
    const u = await put({ subject: "Two" });
    await prepare(u);
    await vi.waitFor(() => expect(model.drafts.length).toBe(1));
    await client.call("ai.summaries.clear", {});
    write();
    await new Promise((r) => setTimeout(r, 30));
    expect(await row(u)).toBeNull();

    let check!: () => void;
    model.gate = null;
    model.checkGate = new Promise((r) => (check = r));
    model.drafts.length = 0;
    const v = await put({ subject: "Three" });
    await prepare(v);
    await vi.waitFor(() => expect(model.checks.length).toBeGreaterThan(0));
    await backend.store.threads.act({ threadIds: [v], action: "spam", signal: null, now: NOW });
    check();
    await new Promise((r) => setTimeout(r, 30));
    expect(model.drafts).toEqual([]);
    expect(await row(v)).toBeNull();
  });

  it("charges its own task, and past the day's limit nothing goes and ⌘J still runs", async () => {
    const { backend, client, model, put, prepare, row, account, ANA } = await setup({ cloud: true });
    const t = await put();
    await prepare(t);
    await vi.waitFor(async () => expect((await row(t))?.state).toBe("ready"));
    const book = (await backend.store.settings.get("ai:usage", {})) as Record<string, Record<string, { requests: number }>> | undefined;
    const today = book ? Object.values(book)[0] : undefined;
    if (today) expect(today.reply?.requests).toBe(2);
    expect(model.configs.some((c) => c.model === "claude-haiku-5-5")).toBe(true);
    const limiter = (backend as unknown as { aiService: { limiter: { checkCeilings(): void } } }).aiService.limiter;
    const { DailyLimitError } = await import("./ai-limiter");
    const ceilings = vi.spyOn(limiter, "checkCeilings").mockImplementation(() => {
      throw new DailyLimitError();
    });
    const before = model.checks.length;
    const u = await put({ subject: "Over" });
    await prepare(u);
    await new Promise((r) => setTimeout(r, 30));
    expect(model.checks).toHaveLength(before);
    expect(await row(u)).toBeNull();
    ceilings.mockRestore();
    const compose = await client.call("ai.compose", { requestId: crypto.randomUUID(), session: "s", accountId: account.id, kind: "reply", threadId: u, to: [ANA], cc: [], timezone: "UTC" } as never);
    expect((compose as { status: string }).status).toBe("done");
  });

  it("read again as a request is about to leave, after any wait: Spam, or a thread that moved, stops it", async () => {
    const { backend, model, put, prepare, row } = await setup();
    const t = await put();
    const limiter = (backend as unknown as { aiService: { limiter: { host: { beforeAhead(): Promise<void> } } } }).aiService.limiter;
    const real = limiter.host.beforeAhead;
    // as a local model's slot opening later: the thread went to Spam during the wait
    limiter.host.beforeAhead = async () => {
      await backend.store.threads.act({ threadIds: [t], action: "spam", signal: null, now: NOW });
      await real();
    };
    await prepare(t);
    await new Promise((r) => setTimeout(r, 40));
    limiter.host.beforeAhead = real;
    expect(model.checks).toEqual([]);
    expect(await row(t)).toBeNull();
  });

  it("revoking what a draft may read stops a preparation, as it stops a person's", async () => {
    const { client, model, put, prepare, row } = await setup();
    let write!: () => void;
    model.gate = new Promise((r) => (write = r));
    const t = await put();
    await prepare(t);
    await vi.waitFor(() => expect(model.drafts.length).toBe(1));
    await client.call("writing.prefs.set", { global: { enabled: false } });
    write();
    await new Promise((r) => setTimeout(r, 30));
    expect(await row(t)).toBeNull();
  });

  it("an auth failure pauses it; a new key lifts that", async () => {
    const { client, model, put, prepare } = await setup({ cloud: true });
    const { AiError } = await import("@terno/ai");
    model.wanted = new AiError("bad key", "auth");
    const t = await put();
    await prepare(t);
    await vi.waitFor(async () => expect((await client.call("ai.replyStatus", {})).blockedBy?.kind).toBe("auth"));
    model.wanted = true;
    const u = await put({ subject: "Next" });
    expect(await prepare(u)).toEqual({ status: "none" });
    await client.call("ai.setKey", { provider: "anthropic", value: "sk-test-another" });
    expect(await prepare(u)).toEqual({ status: "started" });
  });

  it("Clear AI data tells every window", async () => {
    const { client, put, prepare, settled } = await setup();
    const t = await put();
    await prepare(t);
    await settled(t, "ready");
    const heard: unknown[] = [];
    client.on("aiReply", (e) => heard.push(e));
    await client.call("ai.summaries.clear", {});
    await vi.waitFor(() => expect(heard).toContainEqual({ threadId: 0, phase: "cleared" }));
  });

  it("an old Undo can't reach a newer reply of the same thread", async () => {
    const { client, put, prepare, row, settled } = await setup();
    const t = await put();
    await prepare(t);
    await settled(t, "ready");
    const first = (await row(t))!;
    const dismissed = await client.call("ai.replyAct", { threadId: t, rowId: first.rowId, revision: first.revision, action: "dismiss" });
    await client.call("ai.summaries.clear", {});
    await prepare(t);
    await settled(t, "ready");
    const newer = (await row(t))!;
    await client.call("ai.replyAct", { threadId: t, rowId: newer.rowId, revision: newer.revision, action: "dismiss" });
    expect(await client.call("ai.replyAct", { threadId: t, rowId: first.rowId, revision: dismissed!.revision, action: "undismiss" })).toBeNull();
    expect((await row(t))!.state).toBe("dismissed");
  });

  it("starts no learning, and what goes is what the hint says", async () => {
    const { backend, model, put, prepare, row } = await setup();
    const activate = vi.spyOn(backend.writing.learner, "activate");
    const t = await put({ subject: "CANARY-SUBJECT", bodyText: "CANARY-BODY can you?" });
    await prepare(t);
    await vi.waitFor(async () => expect((await row(t))?.state).toBe("ready"));
    expect(activate).not.toHaveBeenCalled();
    activate.mockRestore();
    const sent = model.checks.map((r) => promptText(r.messages[0]!.content)).join();
    expect(sent).toContain("CANARY-BODY");
    expect(sent).toContain("CANARY-SUBJECT");
  });
});

describe("what can happen to a reply", () => {
  it("Use makes no request, holds to the same people and thread, and only once; restore needs what Use left", async () => {
    const { client, model, put, prepare, row, settled, ANA } = await setup();
    const t = await put({ providerThreadId: "x" });
    await prepare(t);
    await settled(t, "ready");
    const r = (await row(t))!;
    const n = model.drafts.length + model.checks.length;
    // someone else on To: the words were for another person
    expect(await client.call("ai.replyAct", { threadId: t, rowId: r.rowId, revision: r.revision, action: "use", to: [{ name: "Tom", email: "tom@x.test" }], cc: [], timezone: "UTC" })).toBeNull();
    const used = await client.call("ai.replyAct", { threadId: t, rowId: r.rowId, revision: r.revision, action: "use", to: [ANA], cc: [], timezone: "UTC" });
    expect(used).toMatchObject({ state: "used", body: r.body });
    expect(model.drafts.length + model.checks.length).toBe(n);
    expect(await client.call("ai.replyAct", { threadId: t, rowId: r.rowId, revision: r.revision, action: "use", to: [ANA], cc: [], timezone: "UTC" })).toBeNull();
    expect(await client.call("ai.replyAct", { threadId: t, rowId: r.rowId, revision: r.revision, action: "restore" })).toBeNull();
    expect(await client.call("ai.replyAct", { threadId: t, rowId: r.rowId, revision: used!.revision, action: "restore" })).toMatchObject({ state: "ready" });
  });

  it("a thread changed since refuses Use", async () => {
    const { client, put, prepare, row, settled, ANA } = await setup();
    const t = await put({ providerThreadId: "x" });
    await prepare(t);
    await settled(t, "ready");
    const r = (await row(t))!;
    await put({ providerThreadId: "x", subject: "Re: The 19th" });
    expect(await client.call("ai.replyAct", { threadId: t, rowId: r.rowId, revision: r.revision, action: "use", to: [ANA], cc: [], timezone: "UTC" })).toBeNull();
  });

  it("nothing leaves: no op is queued and no draft row made, whatever happens to a reply", async () => {
    const { backend, client, put, prepare, row, settled, ANA } = await setup();
    const t = await put();
    await prepare(t);
    await settled(t, "ready");
    const r = (await row(t))!;
    await client.call("ai.replyAct", { threadId: t, rowId: r.rowId, revision: r.revision, action: "use", to: [ANA], cc: [], timezone: "UTC" });
    expect(await backend.store.drafts.list()).toEqual([]);
    const sent = (backend.store as unknown as { db: { get<T>(sql: string): T } }).db.get<{ n: number }>("SELECT count(*) n FROM messages WHERE is_sent = 1");
    expect(sent.n).toBe(0);
  });

});

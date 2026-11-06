/**
 * Plan 145 through the real backend, with a scripted model and a clock the test moves: nothing leaves this process. The
 * store's rows are the conformance suite's; here, who sees what, what goes to a model and when.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import { todayKey } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { msg, threadOf } from "@terno/store/conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = new Date(2026, 10, 5, 9).getTime();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(o: { provider?: "fake" | "none" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-today-"));
  const model = {
    reqs: [] as CompletionRequest[],
    answer: (req: CompletionRequest) => {
      const labels = [...promptText(req.messages[0]!.content).matchAll(/<mail id="(d\d+)">\nFrom: ([^\n]*)/g)];
      return { items: labels.map((m) => ({ label: m[1]!, kind: /Acme/.test(m[2]!) ? "other" : "newsletter", line: `On ${m[2]}` })) };
    },
    failWith: null as Error | null,
    gate: null as Promise<void> | null,
  };
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async (req) => {
          model.reqs.push(req);
          if (model.gate) await model.gate;
          if (model.failWith) throw model.failWith;
          return { text: JSON.stringify(model.answer(req)), stop: "end" };
        },
      },
    });
  const clock = { now: NOW };
  const backend = new Backend({ dbPath: join(dir, "a.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@terno.test", displayName: "Me", color: "indigo", now: 0 });
  if (o.provider !== "none") await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const raw = (backend.store as unknown as { db: { run(sql: string, ...a: unknown[]): unknown } }).db;
  let seq = 0;
  const put = async (over: Partial<IncomingMessage> = {}, waiting = true) => {
    const id = `m-${seq++}`;
    const m = msg({ accountId: account.id, date: clock.now - 60_000 - seq, from: { name: "Ana", email: "ana@people.test" }, to: [{ name: "Me", email: account.email }], subject: `Subject ${seq}`, providerMsgId: id, isRead: false, ...over });
    await backend.store.sync.ingest([m], { applyFilters: false, now: clock.now, classifier: null });
    const thread = await threadOf(backend.store, id);
    raw.run("UPDATE threads SET waiting_since = ? WHERE id = ?", waiting ? clock.now - 60_000 : null, thread);
    return thread;
  };
  const letter = async (from: string, over: Partial<IncomingMessage> = {}) => {
    const thread = await put({ from: { name: from, email: `news@${from.toLowerCase().replace(/\s/g, "")}.test` }, listId: `l-${seq}`, bodyText: `BODY-CANARY of ${from}`, ...over }, false);
    raw.run("UPDATE threads SET person = 0 WHERE id = ?", thread);
    raw.run("UPDATE messages SET created_at = ? WHERE thread_id = ?", clock.now - 60_000, thread);
    return thread;
  };
  return { backend, client, model, account, put, letter, clock, raw };
}

describe("who sees it", () => {
  it("no provider: no sections, no timer, no count", async () => {
    const { backend, client, put } = await setup({ provider: "none" });
    await put();
    expect(await client.call("today.list", { heldIds: [] })).toMatchObject({ sections: [], digest: null });
    await backend.today.arm();
    expect(backend.today.nextAt).toBeNull();
    expect((await client.call("counts.get", {})).today).toBeUndefined();
  });

  it("with nothing to prepare there's no timer; a time change re-arms it; stop clears it", async () => {
    const { backend, client, clock } = await setup();
    await backend.today.arm();
    expect(backend.today.nextAt).toBeNull();
    await client.call("settings.update", { today: { digest: true, prepareAt: "10:00" } });
    await vi.waitFor(() => expect(backend.today.nextAt).toBe(new Date(2026, 10, 5, 10).getTime()));
    await client.call("settings.update", { today: { prepareAt: "11:30" } });
    await vi.waitFor(() => expect(backend.today.nextAt).toBe(new Date(2026, 10, 5, 11, 30).getTime()));
    await backend.today.stop();
    expect(backend.today.nextAt).toBeNull();
    void clock;
  });
});

describe("the list", () => {
  it("waiting threads, newest first, capped, with how many more", async () => {
    const { client, put } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 15; i++) ids.push(await put());
    const list = await client.call("today.list", { heldIds: [] });
    const needs = list.sections.find((s) => s.kind === "needsYou")!;
    expect(needs.items).toHaveLength(12);
    expect(needs.kind === "needsYou" && needs.more).toBe(3);
    expect(needs.items.map((i) => i.why.kind)).toEqual(Array(12).fill("waiting"));
    const dates = needs.items.map((i) => i.thread.lastDate);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it("a thread appears once: two due promises and a reminder are one row in Needs you, and count once", async () => {
    const { backend, client, account, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    const me = { name: "Me", email: account.email };
    const m = msg({ accountId: account.id, from: me, to: [{ name: "Tom", email: "tom@acme.test" }], isSent: true, inInbox: true, date: clock.now - 86_400_000, providerMsgId: "s-1", subject: "The contract" });
    const r = await backend.store.sync.ingest([m], { applyFilters: false, now: clock.now, classifier: null, liveSent: { wanted: true } });
    const t = await threadOf(backend.store, "s-1");
    const row = (item: number, text: string) => ({ kind: "promise" as const, item, text, quote: "I'll send it", personName: "Tom", personEmail: "tom@acme.test", dueAt: clock.now + 1000, dated: false });
    const finished = await backend.store.followups.finish({ messageId: r.inserted[0]!, threadId: t, fromScan: false, now: clock.now, kept: [], model: "m", provider: "p", promptVersion: 1, clearGeneration: backend.store.followups.clearGeneration(), rows: [row(0, "send the contract"), row(1, "and the deck")] });
    expect(finished).not.toBe("gone");
    clock.now += 5000;
    await client.call("reminders.set", { threadIds: [t], dueAt: clock.now - 500, kind: "always" });
    const list = await client.call("today.list", { heldIds: [] });
    const sections = list.sections.map((s) => [s.kind, s.items.map((i) => i.thread.id)]);
    expect(sections).toEqual([["needsYou", [t]]]);
    expect(list.sections[0]!.items[0]!.why.kind).toBe("promise");
    expect((await client.call("counts.get", {})).today).toBe(1);
  });

  it("held rows come back", async () => {
    const { client, put, raw } = await setup();
    const t = await put();
    raw.run("UPDATE threads SET waiting_since = NULL WHERE id = ?", t);
    const list = await client.call("today.list", { heldIds: [t] });
    expect(list.held.map((x) => x.id)).toEqual([t]);
  });
});

describe("the digest", () => {
  const on = async (t: Awaited<ReturnType<typeof setup>>) => t.client.call("settings.update", { today: { digest: true, prepareAt: "08:00" } });
  const day = () => todayKey(NOW);

  it("off, nothing's sent; on, what's not a newsletter falls out, and what it forgets", async () => {
    const t = await setup();
    await t.letter("Stratechery");
    await t.letter("Acme Store");
    await t.letter("Forgotten");
    await t.backend.today.tick();
    expect(t.model.reqs).toEqual([]);
    expect(await t.backend.store.today.digest.get(day())).toBeNull();
    t.model.answer = (req) => {
      const labels = [...promptText(req.messages[0]!.content).matchAll(/<mail id="(d\d+)">\nFrom: ([^\n]*)/g)].filter((m) => !/Forgotten/.test(m[2]!));
      return { items: [...labels.map((m) => ({ label: m[1]!, kind: /Acme/.test(m[2]!) ? "other" : "newsletter", line: `On ${m[2]}` })), { label: "d99", kind: "newsletter", line: "nobody" }] };
    };
    await on(t);
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
    const row = (await t.backend.store.today.digest.get(day()))!;
    expect(row.items.map((i) => i.from)).toEqual(["Stratechery"]);
    expect(t.model.reqs).toHaveLength(1);
    expect(promptText(t.model.reqs[0]!.messages[0]!.content)).toContain("BODY-CANARY");
  });

  it("a code, a person, a read one aren't candidates; a day with none writes and sends nothing", async () => {
    const t = await setup();
    await t.letter("Sign In", { subject: "Your code is 482913", snippet: "Your verification code is 482913" });
    await t.put();
    await t.letter("Read One", { isRead: true });
    await on(t);
    await t.backend.today.tick();
    expect(t.model.reqs).toEqual([]);
    expect(await t.backend.store.today.digest.get(day())).toBeNull();
  });

  it("two wake-ups start one, and a pending row left by a quit goes on from its checkpoint", async () => {
    const t = await setup();
    await t.letter("One");
    await t.letter("Two");
    await on(t);
    await Promise.all([t.backend.today.tick(), t.backend.today.tick()]);
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
    expect(t.model.reqs).toHaveLength(1);
    const { digest } = t.backend.store.today;
    const item = (await digest.get(day()))!.items[0]!;
    const tomorrow = todayKey(NOW + 86_400_000);
    await digest.begin(tomorrow, { at: 0, id: 0 }, [item], digest.clearGeneration());
    await digest.write({ ...(await digest.get(tomorrow))!, items: [{ ...item, line: "already done" }], pending: [] }, digest.clearGeneration());
    await t.backend.today.drain();
    expect(await digest.get(tomorrow)).toMatchObject({ state: "ready", items: [{ line: "already done" }] });
    expect(t.model.reqs).toHaveLength(1);
  });

  it("the next one starts after what the last read: what's listed isn't listed twice, and what arrived meanwhile isn't lost", async () => {
    const t = await setup();
    await t.letter("One");
    await on(t);
    await t.backend.today.tick();
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
    t.clock.now += 86_400_000;
    await t.letter("Two");
    await t.backend.today.tick();
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(todayKey(t.clock.now)))?.state).toBe("ready"));
    expect((await t.backend.store.today.digest.get(todayKey(t.clock.now)))!.items.map((i) => i.from)).toEqual(["Two"]);
  });

  it("turning it off mid-run writes nothing; Clear AI data empties it", async () => {
    const t = await setup();
    await t.letter("One");
    let release!: () => void;
    t.model.gate = new Promise((r) => (release = r));
    await on(t);
    await vi.waitFor(() => expect(t.model.reqs).toHaveLength(1));
    await t.client.call("settings.update", { today: { digest: false } });
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect((await t.backend.store.today.digest.get(day()))?.state).toBe("pending");
    expect((await t.backend.store.today.digest.get(day()))?.items).toEqual([]);
    await t.client.call("ai.summaries.clear", {});
    expect(await t.backend.store.today.digest.get(day())).toBeNull();
  });

  it("a bad key pauses it and says so, spending no attempts; Settings moving resume it; Try again counts as a person's", async () => {
    const t = await setup();
    await t.letter("One");
    const { AiError } = await import("@terno/ai");
    t.model.failWith = new AiError("no", "auth");
    await on(t);
    await vi.waitFor(async () => expect((await t.client.call("today.digest", {}))?.errorKind).toBe("auth"));
    expect(await t.client.call("today.digest", {})).toMatchObject({ state: "failed" });
    expect((await t.backend.store.today.digest.get(day()))).toMatchObject({ state: "pending", attempts: 0 });
    const n = t.model.reqs.length;
    await t.backend.today.drain();
    expect(t.model.reqs).toHaveLength(n);
    t.model.failWith = null;
    await t.client.call("settings.update", { today: { prepareAt: "07:00" } });
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
  });

  it("what fails for good says so, and Try again goes on", async () => {
    const t = await setup();
    await t.letter("One");
    const { AiError } = await import("@terno/ai");
    t.model.failWith = new AiError("no", "refused");
    await on(t);
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("failed"));
    t.model.failWith = null;
    await t.client.call("today.digestRetry", {});
    expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready");
  });

  it("what moved to Spam or changed before it's read goes no further; what's deleted leaves stored digests", async () => {
    const t = await setup();
    const spam = await t.letter("Spammy");
    const kept = await t.letter("Kept");
    await on(t).catch(() => null);
    const { digest } = t.backend.store.today;
    const tomorrow = todayKey(NOW + 86_400_000);
    await vi.waitFor(async () => expect((await digest.get(day()))?.state).toBe("ready"));
    const listed = (await digest.get(day()))!.items;
    expect(listed).toHaveLength(2);
    t.model.reqs.length = 0;
    await digest.begin(tomorrow, { at: 0, id: 0 }, listed.map((i) => ({ ...i, line: null })), digest.clearGeneration());
    await t.backend.store.threads.act({ threadIds: [spam], action: "spam", signal: null, now: NOW });
    await t.backend.today.drain();
    const sent = t.model.reqs.map((r) => promptText(r.messages[0]!.content)).join();
    expect(sent).toContain("Kept");
    expect(sent).not.toContain("Spammy");
    expect((await digest.get(tomorrow))!.items.map((i) => i.threadId)).toEqual([kept]);
    await t.client.call("accounts.remove", { id: t.account.id });
    await t.backend.today.purgeGone();
    expect((await digest.all()).flatMap((r) => [...r.items, ...r.pending])).toEqual([]);
  });

  it("stopping waits for what's underway, and leaves no timer", async () => {
    const t = await setup();
    await t.letter("One");
    let release!: () => void;
    t.model.gate = new Promise((r) => (release = r));
    await on(t);
    await vi.waitFor(() => expect(t.model.reqs).toHaveLength(1));
    const stopped = t.backend.today.stop();
    release();
    await stopped;
    expect(t.backend.today.nextAt).toBeNull();
  });

  it("Archive all: only what's listed, spares what changed or was starred, and one Undo brings them back", async () => {
    const t = await setup();
    const a = await t.letter("One");
    const b = await t.letter("Two");
    const c = await t.letter("Three", { providerThreadId: "ct" });
    const later = await t.letter("Later");
    await on(t);
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
    await t.backend.store.threads.act({ threadIds: [b], action: "star", signal: null, now: NOW });
    await t.put({ providerThreadId: "ct", subject: "Re: Three", from: { name: "Three", email: "news@three.test" } }, false);
    const inbox = async (id: number) => (await t.backend.store.filters.actionFacts([id]))[0]!.inInbox;
    const listed = (await t.backend.store.today.digest.get(day()))!.items;
    const asListed = [a, b, c].map((id) => {
      const i = listed.find((x) => x.threadId === id)!;
      return { threadId: id, lastDate: i.lastDate, messageCount: i.messageCount };
    });
    const r = await t.client.call("today.digestArchive", { items: [...asListed, { threadId: 999_999, lastDate: 1, messageCount: 1 }] });
    expect(r).toMatchObject({ archived: 1, spared: 1, changed: 2 });
    expect([await inbox(a), await inbox(b), await inbox(c), await inbox(later)]).toEqual([false, true, true, true]);
    await t.client.call("threads.undo", { undoId: r.undoId! });
    expect(await inbox(a)).toBe(true);
  });

  it("the digest off shows what's automated, unticked and unsorted, and sends nothing", async () => {
    const t = await setup();
    await t.letter("Acme Store");
    await t.client.call("today.list", { heldIds: [] });
    await vi.waitFor(async () => expect((await t.client.call("today.digest", {}))?.automated).toBe(true));
    const row = (await t.client.call("today.digest", {}))!;
    expect(row.items[0]).toMatchObject({ line: null, from: "Acme Store" });
    expect(t.model.reqs).toEqual([]);
  });

  it("the notice: off by default, once a day, never who or what, and never hours late", async () => {
    const t = await setup();
    await t.put();
    const remind = vi.spyOn(t.backend.attention, "remind");
    await t.backend.today.tick();
    expect(remind).not.toHaveBeenCalled();
    await t.client.call("settings.update", { today: { notify: true, prepareAt: "08:30" } });
    await vi.waitFor(() => expect(remind).toHaveBeenCalledTimes(1));
    const notice = remind.mock.calls[0]![0];
    expect(notice).toMatchObject({ kind: "brief", senders: [], subject: "", snippet: "" });
    await t.backend.today.tick();
    expect(remind).toHaveBeenCalledTimes(1);
    remind.mockClear();
    t.clock.now += 86_400_000 + 4 * 3_600_000;
    await t.backend.today.tick();
    expect(remind).not.toHaveBeenCalled();
    t.clock.now -= 4 * 3_600_000;
    const none = await setup();
    const quiet = vi.spyOn(none.backend.attention, "remind");
    await none.client.call("settings.update", { today: { notify: true, prepareAt: "08:30" } });
    await none.backend.today.tick();
    expect(quiet).not.toHaveBeenCalled();
  });
});

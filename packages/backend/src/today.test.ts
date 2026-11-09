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

async function setup(o: { provider?: "fake" | "none"; devAi?: { anthropic: string } } = {}) {
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
  const backend = new Backend({ dbPath: join(dir, "a.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now, ...(o.devAi ? { devAi: o.devAi, lookup: async () => [{ address: "93.184.216.34", family: 4 as const }] } : {}) });
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
    raw.run("UPDATE threads SET waiting_since = ?, has_sent = ? WHERE id = ?", waiting ? clock.now - 60_000 : null, waiting ? 1 : 0, thread);
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
  it("needs you is a conversation you're in: a bank's notice and a calendar's answer aren't, and the count agrees (real mail)", async () => {
    const { client, put, raw } = await setup();
    const yours = await put();
    const notice = await put({ from: { name: "Bank", email: "notices@bank.test" } });
    raw.run("UPDATE threads SET has_sent = 0 WHERE id = ?", notice);
    await put({ subject: "Aceptado: Demo" });
    await put({ subject: "Accepted: Demo" });
    // someone they've written to: their one new conversation counts, a service's many don't
    raw.run("INSERT INTO correspondents (email, written, own) VALUES ('colleague@people.test', 1, 0), ('service@machine.test', 1, 0), ('other-me@people.test', 1, 1)");
    // their own forward from another address of theirs
    raw.run("UPDATE threads SET has_sent = 0 WHERE id = ?", await put({ from: { name: "Me", email: "other-me@people.test" } }));
    // correspondents hold the address without its +tag, as everything that writes them does
    const colleague = await put({ from: { name: "Col", email: "colleague+work@people.test" } });
    raw.run("UPDATE threads SET has_sent = 0 WHERE id = ?", colleague);
    for (let i = 0; i < 2; i++) raw.run("UPDATE threads SET has_sent = 0 WHERE id = ?", await put({ from: { name: "Svc", email: "service@machine.test" } }));
    const list = await client.call("today.list", { heldIds: [] });
    const needs = list.sections.find((s) => s.kind === "needsYou")!;
    expect(new Set(needs.items.map((i) => i.thread.id))).toEqual(new Set([yours, colleague]));
    expect((await client.call("counts.get", {})).today).toBe(2);
  });

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

  it("plan 162: a key without permission pauses it as a bad key does, stored apart so the page says which", async () => {
    const t = await setup();
    await t.letter("One");
    const { AiError } = await import("@terno/ai");
    const { L } = await import("@terno/i18n");
    t.model.failWith = new AiError(L("errors.ai.noPermission", { provider: "OpenAI" }), "auth");
    await on(t);
    await vi.waitFor(async () => expect((await t.client.call("today.digest", {}))?.errorKind).toBe("provider_no_permission"));
    expect(await t.client.call("today.digest", {})).toMatchObject({ state: "failed" });
    expect((await t.backend.store.today.digest.get(day()))).toMatchObject({ state: "pending", attempts: 0 });
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

  it("moved to Spam as the request waits to leave: it doesn't go, and the rest are asked about without it", async () => {
    const t = await setup();
    const spam = await t.letter("Spammy");
    await t.letter("Kept");
    const limiter = (t.backend as unknown as { aiService: { limiter: { host: { beforeAhead(task: string): Promise<void> } } } }).aiService.limiter;
    const real = limiter.host.beforeAhead;
    let once = true;
    limiter.host.beforeAhead = async (task) => {
      if (task === "digest" && once) {
        once = false;
        await t.backend.store.threads.act({ threadIds: [spam], action: "spam", signal: null, now: NOW });
      }
      await real(task);
    };
    await on(t);
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
    limiter.host.beforeAhead = real;
    const sent = t.model.reqs.map((r) => promptText(r.messages[0]!.content)).join();
    expect(sent).toContain("Kept");
    expect(sent).not.toContain("Spammy");
  });

  it("a purge while a batch is out stays: its checkpoint doesn't write back what went", async () => {
    const t = await setup();
    await t.letter("Gone");
    await t.letter("Stays");
    let release!: () => void;
    const { digest } = t.backend.store.today;
    const g = digest.clearGeneration();
    const listed = (await t.backend.store.filters.actionFacts([1, 2])).map((f) => ({ threadId: f.id, messageId: f.id, lastDate: f.lastDate, messageCount: f.messageCount, from: f.subject, subject: f.subject, line: "old" as string | null }));
    await digest.begin(day(), { at: 0, id: 0 }, [listed[1]!], g);
    await digest.write({ ...(await digest.get(day()))!, items: [listed[0]!] }, g);
    t.model.gate = new Promise((r) => (release = r));
    await t.client.call("settings.update", { today: { digest: true } });
    await vi.waitFor(() => expect(t.model.reqs).toHaveLength(1));
    await digest.write({ ...(await digest.get(day()))!, items: [] }, g);
    release();
    await vi.waitFor(async () => expect((await digest.get(day()))?.state).toBe("ready"));
    expect((await digest.get(day()))!.items.some((i) => i.threadId === listed[0]!.threadId)).toBe(false);
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

  it("plan 161: the page is newest first by date; an opened one is kept and said so, and Archive leaves one read since", async () => {
    const t = await setup();
    const old = await t.letter("Old", { date: NOW - 3 * 3_600_000 });
    const fresh = await t.letter("Fresh", { date: NOW - 3_600_000 });
    const mid = await t.letter("Mid", { date: NOW - 2 * 3_600_000 });
    await on(t);
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
    const row = (await t.client.call("today.digest", {}))!;
    expect(row.items.map((i) => i.threadId)).toEqual([fresh, mid, old]);
    expect(row.readIds).toEqual([]);
    // opened from the page: read, still in the Inbox
    await t.backend.store.threads.act({ threadIds: [mid], action: "markRead", signal: null, now: NOW });
    const after = (await t.client.call("today.digest", {}))!;
    expect([after.liveIds.sort(), after.readIds]).toEqual([[fresh, old].sort(), [mid]]);
    // a page drawn before the read still asks for it: it stays, counted as left alone
    const asListed = row.items.map((i) => ({ threadId: i.threadId, lastDate: i.lastDate, messageCount: i.messageCount }));
    const r = await t.client.call("today.digestArchive", { items: asListed });
    expect(r).toMatchObject({ archived: 2, spared: 1, changed: 0 });
    // Codex review: exactly which went, so the page hides only those
    expect(r.archivedIds.sort()).toEqual([fresh, old].sort());
    expect((await t.backend.store.filters.actionFacts([mid]))[0]!.inInbox).toBe(true);
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

  describe("plan 166: Not a newsletter", () => {
    const sent = (t: Awaited<ReturnType<typeof setup>>) => t.model.reqs.map((r) => promptText(r.messages[0]!.content)).join();

    it("leaves the digest at once, and Undo (only its own entry) brings it back where it was", async () => {
      const t = await setup();
      const strat = await t.letter("Stratechery");
      const brew = await t.letter("Morning Brew");
      await on(t);
      await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
      const before = (await t.client.call("today.digest", {}))!;
      expect(before.items.map((i) => [i.threadId, i.fromEmail])).toEqual([[strat, "news@stratechery.test"], [brew, "news@morningbrew.test"]]);
      const events: unknown[] = [];
      const off = t.client.on("todayDigest", (e) => void events.push(e));
      // any case, any +tag: one sender
      const r = await t.client.call("today.notNewsletter", { email: "News+weekly@Stratechery.test", name: "Stratechery" });
      expect(r.added).toMatchObject({ email: "News+weekly@Stratechery.test", name: "Stratechery" });
      expect(r.evicted).toEqual([]);
      const after = (await t.client.call("today.digest", {}))!;
      expect(after.items.map((i) => i.threadId)).toEqual([brew]);
      expect(after.liveIds).toEqual([brew]);
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
      off();
      // said twice, it's one entry, and the second adds nothing for its Undo to take
      expect((await t.client.call("today.notNewsletter", { email: "news@stratechery.test", name: "S" })).added).toBeNull();
      expect((await t.client.call("today.notNewsletters", {})).senders.map((e) => e.email)).toEqual(["News+weekly@Stratechery.test"]);
      // the snack's Undo, by the entry's id
      await t.client.call("today.notNewslettersUndo", { remove: { email: r.added!.email, id: r.added!.id }, restore: [] });
      expect((await t.client.call("today.notNewsletters", {})).senders).toEqual([]);
      expect((await t.client.call("today.digest", {}))!.items.map((i) => i.threadId)).toEqual([strat, brew]);
      // no model was asked about any of it
      expect(t.model.reqs).toHaveLength(1);
    });

    it("keeps the sender out of the next scan before any model call, and gives its place among the 40 to another", async () => {
      const t = await setup();
      await t.client.call("today.notNewsletter", { email: "news@stratechery.test", name: "Stratechery" });
      await t.letter("Stratechery");
      await t.letter("Kept");
      await on(t);
      await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
      expect(sent(t)).toContain("Kept");
      expect(sent(t)).not.toContain("Stratechery");
      expect((await t.backend.store.today.digest.get(day()))!.items.map((i) => i.from)).toEqual(["Kept"]);
    });

    it("said while a request waits to leave: that sender doesn't go, and the rest are asked about without it", async () => {
      const t = await setup();
      await t.letter("Spammy");
      await t.letter("Kept");
      const limiter = (t.backend as unknown as { aiService: { limiter: { host: { beforeAhead(task: string): Promise<void> } } } }).aiService.limiter;
      const real = limiter.host.beforeAhead;
      let once = true;
      limiter.host.beforeAhead = async (task) => {
        if (task === "digest" && once) {
          once = false;
          await t.backend.today.notNewsletter({ email: "news@spammy.test", name: "Spammy" });
        }
        await real(task);
      };
      await on(t);
      await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
      limiter.host.beforeAhead = real;
      expect(sent(t)).toContain("Kept");
      expect(sent(t)).not.toContain("Spammy");
    });

    it("a digest stored before items carried a sender: its own message's, not the thread's last, and pending ones too", async () => {
      const t = await setup();
      const one = await t.letter("Old Letter");
      const two = await t.letter("Still Pending");
      const { digest } = t.backend.store.today;
      const g = digest.clearGeneration();
      const facts = (await t.backend.store.filters.actionFacts([one, two])).map((f) => ({ threadId: f.id, messageId: f.id, lastDate: f.lastDate, messageCount: f.messageCount, from: f.subject, subject: f.subject, line: "old" as string | null }));
      // as stored before plan 166: no fromEmail
      await digest.begin(day(), { at: 0, id: 0 }, [facts[1]!], g);
      await digest.write({ ...(await digest.get(day()))!, items: [facts[0]!] }, g);
      // the thread's last sender isn't the newsletter's any more (a reply in it): the item's own message decides
      t.raw.run("UPDATE threads SET last_from_email = 'ana@people.test' WHERE id = ?", one);
      await t.client.call("today.notNewsletter", { email: "news@oldletter.test", name: "Old Letter" });
      await t.client.call("today.notNewsletter", { email: "news@stillpending.test", name: "Still Pending" });
      // the pending one is dropped before it's sent: no model call at all
      await t.client.call("settings.update", { today: { digest: true } });
      await vi.waitFor(async () => expect((await digest.get(day()))?.state).toBe("ready"));
      expect(t.model.reqs).toEqual([]);
      expect((await t.client.call("today.digest", {}))!.items).toEqual([]);
      // let back in, the stored one shows again, with its sender filled from its message
      await t.client.call("today.newsletterAgain", { email: "news@oldletter.test" });
      expect((await t.client.call("today.digest", {}))!.items.map((i) => [i.threadId, i.fromEmail])).toEqual([[one, "news@oldletter.test"]]);
    });

    it("Archive leaves a sender said not to be one meanwhile, and doesn't count it", async () => {
      const t = await setup();
      const a = await t.letter("One");
      const b = await t.letter("Two");
      await on(t);
      await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(day()))?.state).toBe("ready"));
      const listed = (await t.client.call("today.digest", {}))!.items;
      await t.client.call("today.notNewsletter", { email: "news@two.test", name: "Two" });
      const r = await t.client.call("today.digestArchive", { items: listed.map((i) => ({ threadId: i.threadId, lastDate: i.lastDate, messageCount: i.messageCount, fromEmail: i.fromEmail })) });
      expect(r).toMatchObject({ archived: 1, changed: 0, spared: 0, archivedIds: [a] });
      expect((await t.backend.store.filters.actionFacts([b]))[0]!.inInbox).toBe(true);
    });

    it("at the cap the oldest goes and is said; Undo, in one unit, puts it back even if the slot was filled meanwhile (Codex review)", async () => {
      const t = await setup();
      const full = Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, email: `s${i}@x.test`, name: `S${i}`, at: 1000 + i }));
      await t.backend.store.settings.set("today:notNewsletters", full);
      const r = await t.client.call("today.notNewsletter", { email: "new@x.test", name: "New" });
      expect(r.evicted).toEqual([full[0]]);
      let list = (await t.client.call("today.notNewsletters", {})).senders;
      expect(list).toHaveLength(500);
      expect(list[0]!.email).toBe("new@x.test");
      // another window says another sender meanwhile: it takes the slot New will free
      const other = await t.client.call("today.notNewsletter", { email: "other@x.test", name: "Other" });
      expect(other.evicted).toEqual([full[1]]);
      // the snack's Undo: off what it added, back what it dropped, as it was, in one unit: S0 isn't dropped again
      expect(await t.client.call("today.notNewslettersUndo", { remove: { email: "new@x.test", id: r.added!.id }, restore: r.evicted })).toEqual({ restored: 1 });
      list = (await t.client.call("today.notNewsletters", {})).senders;
      expect(list.some((e) => e.email === "new@x.test")).toBe(false);
      expect(list.find((e) => e.email === "s0@x.test")).toEqual(full[0]);
      expect(list).toHaveLength(500);
      // the next one said trims back to the cap, the oldest first
      const next = await t.client.call("today.notNewsletter", { email: "next@x.test", name: "Next" });
      expect(next.evicted).toEqual([full[0]]);
    });

    it("an old Undo can't take off a sender removed and said again since, even within one millisecond (Codex review)", async () => {
      const t = await setup();
      const first = await t.client.call("today.notNewsletter", { email: "a@x.test", name: "A" });
      // Settings' Remove, then said again from the digest, the clock unmoved
      await t.client.call("today.newsletterAgain", { email: "a@x.test", id: first.added!.id });
      const again = await t.client.call("today.notNewsletter", { email: "a@x.test", name: "A" });
      expect(again.added!.id).not.toBe(first.added!.id);
      await t.client.call("today.notNewslettersUndo", { remove: { email: "a@x.test", id: first.added!.id }, restore: [] });
      expect((await t.client.call("today.notNewsletters", {})).senders.map((e) => e.id)).toEqual([again.added!.id]);
      // and a Remove's Undo doesn't list a sender twice
      expect(await t.client.call("today.notNewslettersUndo", { restore: [first.added!] })).toEqual({ restored: 0 });
    });

    it("Codex review, round 2: one millisecond keeps the order, a clock set back can't drop the one just said, Undos can't grow it without bound, and an entry stored without an id still has one", async () => {
      const t = await setup();
      const a = await t.client.call("today.notNewsletter", { email: "a@x.test", name: "A" });
      const b = await t.client.call("today.notNewsletter", { email: "b@x.test", name: "B" });
      expect(b.added!.at).toBeGreaterThan(a.added!.at);
      // a full list whose times are all after now (the clock set back): the new one is the newest, never the one dropped
      const ahead = Array.from({ length: 500 }, (_, i) => ({ id: `f${i}`, email: `f${i}@x.test`, name: `F${i}`, at: NOW + 1_000_000 + i }));
      await t.backend.store.settings.set("today:notNewsletters", ahead);
      const late = await t.client.call("today.notNewsletter", { email: "late@x.test", name: "Late" });
      expect(late.evicted.map((e) => e.id)).toEqual(["f0"]);
      expect((await t.client.call("today.notNewsletters", {})).senders[0]!.email).toBe("late@x.test");
      // window A says X (S dropped); window B lets X back in and says Y; A's Undo puts S back: 501, at most NOT_NEWSLETTERS_OVER over
      for (let i = 0; i < 15; i++) {
        const x = await t.client.call("today.notNewsletter", { email: `x${i}@x.test`, name: "X" });
        await t.client.call("today.newsletterAgain", { email: `x${i}@x.test` });
        await t.client.call("today.notNewsletter", { email: `y${i}@x.test`, name: "Y" });
        await t.client.call("today.notNewslettersUndo", { remove: { email: x.added!.email, id: x.added!.id }, restore: x.evicted });
      }
      expect((await t.client.call("today.notNewsletters", {})).senders.length).toBeLessThanOrEqual(510);
      // the next addition trims it back, and its Undo still passes the RPC's check
      const next = await t.client.call("today.notNewsletter", { email: "next@x.test", name: "Next" });
      expect((await t.client.call("today.notNewsletters", {})).senders).toHaveLength(500);
      await expect(t.client.call("today.notNewslettersUndo", { remove: { email: "next@x.test", id: next.added!.id }, restore: next.evicted })).resolves.toBeDefined();
      // stored before ids: named by the address, removable, and its Undo accepted
      await t.backend.store.settings.set("today:notNewsletters", [{ email: "Old@x.test", name: "Old", at: 5 }]);
      const [old] = (await t.client.call("today.notNewsletters", {})).senders;
      expect(old!.id).toBe("key:old@x.test");
      const gone = await t.client.call("today.newsletterAgain", { email: "old@x.test", id: old!.id });
      expect(await t.client.call("today.notNewslettersUndo", { restore: [gone.removed!] })).toEqual({ restored: 1 });
    });

    it("two said at once are both kept; a name past 200 characters is kept to 200", async () => {
      const t = await setup();
      await Promise.all([t.client.call("today.notNewsletter", { email: "a@x.test", name: "A" }), t.client.call("today.notNewsletter", { email: "b@x.test", name: "B" })]);
      expect((await t.client.call("today.notNewsletters", {})).senders.map((e) => e.email).sort()).toEqual(["a@x.test", "b@x.test"]);
      const long = await t.client.call("today.notNewsletter", { email: "c@x.test", name: "N".repeat(400) });
      expect(long.added!.name).toHaveLength(200);
    });

    it("with the digest off, Automated mail leaves it too, and a scan begun before isn't kept", async () => {
      const t = await setup();
      await t.letter("Acme Store");
      await t.letter("Other Shop");
      await t.client.call("today.list", { heldIds: [] });
      await vi.waitFor(async () => expect((await t.client.call("today.digest", {}))?.items).toHaveLength(2));
      await t.client.call("today.notNewsletter", { email: "news@acmestore.test", name: "Acme Store" });
      expect((await t.client.call("today.digest", {}))!.items.map((i) => i.from)).toEqual(["Other Shop"]);
      // a scan underway when the list changes isn't kept: it was read with the list as it was
      const service = t.backend.today as unknown as { candidates(since: null): Promise<unknown>; automated: { at: number; candidates: { items: { from: string }[] } } | null };
      const idle = () => vi.waitFor(() => expect((t.backend.today as unknown as { refreshing: unknown }).refreshing).toBeNull());
      await idle();
      const real = service.candidates.bind(service);
      let release!: () => void;
      let started!: () => void;
      const scanning = new Promise<void>((r) => (started = r));
      service.candidates = async (since) => {
        // only the first scan waits
        service.candidates = real;
        const found = await real(since);
        started();
        await new Promise<void>((r) => (release = r));
        return found;
      };
      await t.client.call("today.newsletterAgain", { email: "news@acmestore.test" });
      await t.client.call("today.digest", {});
      await scanning;
      await t.client.call("today.notNewsletter", { email: "news@othershop.test", name: "Other Shop" });
      const held = service.automated;
      release();
      await idle();
      expect(service.automated).toBe(held);
      // the next read scans again, with the list as it is now
      await vi.waitFor(async () => expect((await t.client.call("today.digest", {}))?.items.map((i) => i.from)).toEqual(["Acme Store"]));
      expect(t.model.reqs).toEqual([]);
    });
  });

  it("plan 147: a local build with Dev mode's switch off gives no notice, whatever is saved, and doesn't use up the day's", async () => {
    const t = await setup({ devAi: { anthropic: "env-anthropic" } });
    await t.put();
    const remind = vi.spyOn(t.backend.attention, "remind");
    await t.client.call("settings.update", { today: { notify: true, prepareAt: "08:30" } });
    await t.backend.today.tick();
    expect(remind).not.toHaveBeenCalled();
    // it hears of the switch by itself
    await t.client.call("settings.update", { devAi: true });
    await vi.waitFor(() => expect(remind).toHaveBeenCalledTimes(1));
  });

  it("plan 150: the switch off, no timer waits, no digest is prepared and the list is empty; on, all of it, with no restart", async () => {
    const t = await setup({ devAi: { anthropic: "env-anthropic" } });
    await t.put();
    await t.letter("Stratechery");
    await t.client.call("settings.update", { today: { digest: true, prepareAt: "08:30" } });
    await t.backend.today.tick();
    expect(t.backend.today.nextAt).toBeNull();
    expect(await t.backend.store.today.digest.get(todayKey(t.clock.now))).toBeNull();
    expect(t.model.reqs).toEqual([]);
    expect((await t.client.call("today.list", { heldIds: [] })).sections).toEqual([]);
    await t.client.call("settings.update", { devAi: true });
    await vi.waitFor(() => expect(t.backend.today.nextAt).not.toBeNull());
    await vi.waitFor(async () => expect((await t.backend.store.today.digest.get(todayKey(t.clock.now)))?.state).toBe("ready"));
    expect(t.model.reqs.length).toBeGreaterThan(0);
    expect((await t.client.call("today.list", { heldIds: [] })).sections.length).toBeGreaterThan(0);
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

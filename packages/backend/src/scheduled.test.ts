import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type ScheduledSnapshot } from "@terno/core/rpc";
import { SCHEDULED_BYTES_MAX, SCHEDULED_MAX, UNDO_SEND_DEFAULT } from "@terno/core";

const UNDO_SEND_MS = UNDO_SEND_DEFAULT * 1000;
import { createAccount, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { FAILED_KEY, retryDelay, ScheduledSends } from "./scheduled";

const NOW = Date.UTC(2026, 9, 31, 12);
const HOUR = 3_600_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const turn = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 8; i++) await turn();
}

/** A backend on a clock the test moves (its timers faked), one account, and the scheduled events it sent. */
async function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = { now: NOW };
  const dir = mkdtempSync(join(tmpdir(), "terno-sched-"));
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => clock.now, autoSync: false });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const account = createAccount(sqlDb(backend.store), { kind: "gmail", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
  const events: ScheduledSnapshot[] = [];
  const drafts: unknown[] = [];
  client.on("scheduled", (e) => events.push(e));
  client.on("drafts", (e) => drafts.push(e));
  const advance = async (ms: number) => {
    clock.now += ms;
    vi.advanceTimersByTime(ms);
    await settle();
  };
  const draft = async (subject = "Lunch") => (await client.call("drafts.save", { accountId: account, to: [{ name: "Ana", email: "ana@friends.com" }], cc: [], subject, bodyText: "Friday?" }))!;
  const schedule = async (d: Awaited<ReturnType<typeof draft>>, sendAt: number) =>
    client.call("compose.schedule", { accountId: account, to: [{ name: "Ana", email: "ana@friends.com" }], subject: d.subject, bodyText: "Friday?\n\n-- \nMe", draftId: d.id, draftGeneration: d.generation!, draftRevision: d.revision, sendAt });
  const sends = async () => (await backend.store.ops.recent(50)).filter((o) => o.kind === "send");
  return { backend, client, account, events, drafts, clock, advance, draft, schedule, sends };
}

describe("scheduled sends (plan 94)", () => {
  it("waits for its moment (one timer, the draft kept and out of drafts.list), then sends the prepared message", async () => {
    const { backend, client, events, advance, draft, schedule, sends } = await setup();
    const d = await draft();
    await schedule(d, NOW + HOUR);
    await settle();
    expect(events.at(-1)!.items).toEqual([{ draftId: d.id, sendAt: NOW + HOUR, accountId: expect.any(Number), threadId: null, mode: "new", to: [{ name: "Ana", email: "ana@friends.com" }], subject: "Lunch", error: null, retryAt: null }]);
    expect(backend.scheduled.nextAt).toBe(NOW + HOUR);
    expect(await client.call("drafts.list", {})).toEqual([]);
    await advance(HOUR - 1);
    expect(await sends()).toEqual([]);
    await advance(1);
    const [op] = await sends();
    expect(JSON.parse(op!.payload_json)).toMatchObject({ subject: "Lunch", text: "Friday?\n\n-- \nMe" });
    expect(events.at(-1)!.items).toEqual([]);
    expect(backend.scheduled.nextAt).toBeNull();
    expect(await backend.store.drafts.list()).toEqual([]);
  });

  describe("Send's Undo window (plan 158)", () => {
    const hold = (client: RpcClient, account: number, d: { id: number; subject: string; generation?: string | null; revision: number }) =>
      client.call("compose.hold", { accountId: account, to: [{ name: "Ana", email: "ana@friends.com" }], subject: d.subject, bodyText: "Friday?", draftId: d.id, draftGeneration: d.generation!, draftRevision: d.revision });

    it("isn't a scheduled send to the user, and goes once, at its moment on the backend's clock", async () => {
      const { backend, client, account, events, advance, draft, sends } = await setup();
      const d = await draft();
      await hold(client, account, d);
      await settle();
      expect(events.at(-1)?.items ?? []).toEqual([]);
      expect((await client.call("scheduled.list", {})).items).toEqual([]);
      expect(await client.call("drafts.list", {})).toEqual([]);
      expect(backend.scheduled.nextAt).toBe(NOW + UNDO_SEND_MS);
      await advance(UNDO_SEND_MS - 1);
      expect(await sends()).toEqual([]);
      await advance(1);
      expect(await sends()).toHaveLength(1);
      await advance(UNDO_SEND_MS * 2);
      expect(await sends()).toHaveLength(1);
      expect(await backend.store.drafts.list()).toEqual([]);
      expect(backend.scheduled.nextAt).toBeNull();
    });

    it("plan 188: holds for the window the renderer's countdown shows, else the user's setting", async () => {
      const { backend, client, account, advance, draft, sends } = await setup();
      await client.call("settings.update", { undoSendSeconds: 30 });
      const first = await draft();
      await client.call("compose.hold", { accountId: account, to: [{ name: "Ana", email: "ana@friends.com" }], subject: first.subject, bodyText: "Friday?", draftId: first.id, draftGeneration: first.generation!, draftRevision: first.revision, holdSeconds: 10 });
      expect(backend.scheduled.nextAt).toBe(NOW + 10_000);
      await client.call("scheduled.cancel", { draftId: first.id });
      await client.call("settings.update", { undoSendSeconds: 20 });
      await hold(client, account, await draft());
      expect(backend.scheduled.nextAt).toBe(NOW + 20_000);
      await advance(20_000 - 1);
      expect(await sends()).toEqual([]);
      await advance(1);
      expect(await sends()).toHaveLength(1);
    });

    it("plan 182: when it goes, the windows hear which copy it became, once; a cancelled one says nothing", async () => {
      const { backend, client, account, advance, draft } = await setup();
      const went: { draftId: number; threadId: number; messageId: number }[] = [];
      client.on("scheduledSent", (e) => went.push(e));
      const kept = await draft("Kept");
      await hold(client, account, kept);
      await client.call("scheduled.cancel", { draftId: kept.id });
      const d = await draft();
      await hold(client, account, d);
      await advance(UNDO_SEND_MS);
      await advance(UNDO_SEND_MS * 2);
      expect(went).toHaveLength(1);
      expect(went[0]!.draftId).toBe(d.id);
      const copy = (await backend.store.threads.get(went[0]!.threadId))?.messages.find((m) => m.id === went[0]!.messageId);
      expect(copy).toMatchObject({ isSent: true });
    });

    it("Undo puts the draft back exactly and nothing goes, and tells the other windows; once gone, Undo finds nothing", async () => {
      const { backend, client, account, drafts, advance, draft, sends } = await setup();
      const d = await draft();
      await hold(client, account, d);
      await settle();
      const before = drafts.length;
      await client.call("scheduled.cancel", { draftId: d.id });
      await settle();
      expect(drafts.length).toBeGreaterThan(before);
      expect(await client.call("drafts.list", {})).toEqual([d]);
      await advance(UNDO_SEND_MS * 2);
      expect(await sends()).toEqual([]);

      await hold(client, account, d);
      await advance(UNDO_SEND_MS);
      expect(await sends()).toHaveLength(1);
      await expect(client.call("scheduled.cancel", { draftId: d.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await backend.store.drafts.list()).toEqual([]);
    });

    it("a full list of scheduled sends doesn't stop Send, and holds have a budget: past it, a plain send, no Undo", async () => {
      const { client, account, draft, backend, sends } = await setup();
      const d = await draft();
      const real = backend.store.scheduled.put;
      const caps: { count: number; bytes: number }[] = [];
      backend.store.scheduled.put = (row, cap) => { caps.push(cap); return real.call(backend.store.scheduled, row, cap); };
      expect(await hold(client, account, d)).toEqual({ held: true });
      expect(caps).toEqual([{ count: SCHEDULED_MAX * 2, bytes: SCHEDULED_BYTES_MAX * 2 }]);
      await client.call("scheduled.cancel", { draftId: d.id });
      backend.store.scheduled.put = async () => "full";
      expect(await hold(client, account, d)).toEqual({ held: false, threadId: expect.any(Number), messageId: expect.any(Number) });
      expect(await sends()).toHaveLength(1);
      expect(await backend.store.drafts.list()).toEqual([]);
    });

    it("a hold that can't go yet is listed, saying why", async () => {
      const { backend, client, account, events, advance, draft } = await setup();
      const d = await draft();
      await hold(client, account, d);
      await settle();
      const real = backend.store.compose.queueSend;
      backend.store.compose.queueSend = () => Promise.reject(new Error("disk full"));
      await advance(UNDO_SEND_MS);
      backend.store.compose.queueSend = real;
      expect(events.at(-1)!.items).toEqual([expect.objectContaining({ draftId: d.id, error: "disk full" })]);
    });

    it("one that couldn't go is a scheduled send from then on: moved to tomorrow, a quit doesn't send it", async () => {
      const { backend, client, account, events, advance, draft, sends } = await setup();
      const d = await draft();
      await hold(client, account, d);
      await settle();
      const real = backend.store.compose.queueSend;
      backend.store.compose.queueSend = () => Promise.reject(new Error("disk full"));
      await advance(UNDO_SEND_MS);
      backend.store.compose.queueSend = real;
      const tomorrow = NOW + 24 * HOUR;
      await client.call("scheduled.reschedule", { draftId: d.id, sendAt: tomorrow });
      await settle();
      expect(events.at(-1)!.items).toEqual([expect.objectContaining({ draftId: d.id, sendAt: tomorrow, error: null })]);
      vi.useRealTimers();
      await backend.quiesce(500);
      expect(await sends()).toEqual([]);
      expect((await backend.store.scheduled.list()).map((s) => s.sendAt)).toEqual([tomorrow]);
    });

    it("a restart neither loses it nor sends it twice: it's due, and goes once", async () => {
      const { backend, client, account, clock, draft, sends } = await setup();
      const d = await draft();
      await hold(client, account, d);
      await settle();
      clock.now += UNDO_SEND_MS;
      // what starting up does, with nothing of the hold in memory (a new ScheduledSends over the same store)
      const restarted = new ScheduledSends({ store: backend.store, now: () => clock.now, emit: () => {}, send: (p) => backend.queueComposeSend(p, { renderer: true, scheduledAt: p.scheduledAt }), sent: () => {}, draftsBack: () => {}, log: () => {} });
      await restarted.refresh();
      await restarted.refresh();
      await backend.scheduled.refresh();
      expect(await sends()).toHaveLength(1);
      expect((await backend.store.scheduled.list())).toEqual([]);
      await restarted.stop();
    });

    it("a hold made while a look is reading stays a hold; a quit leaves a hold another window just moved to tomorrow", async () => {
      const { backend, client, account, events, draft, sends } = await setup();
      const during = await draft("During");
      const real = backend.store.settings.get.bind(backend.store.settings);
      let once = true;
      backend.store.settings.get = (async (key: string, fallback: unknown) => {
        if (once && key === FAILED_KEY) { once = false; await hold(client, account, during); }
        return real(key, fallback);
      }) as typeof backend.store.settings.get;
      await backend.scheduled.refresh();
      await settle();
      backend.store.settings.get = real;
      await backend.scheduled.refresh();
      expect(events.at(-1)?.items ?? []).toEqual([]);

      const moved = await draft("Moved");
      await hold(client, account, moved);
      await settle();
      const tomorrow = NOW + 24 * HOUR;
      const reschedule = backend.store.scheduled.reschedule.bind(backend.store.scheduled);
      let first = true;
      backend.store.scheduled.reschedule = async (id, at) => {
        const ok = await reschedule(id, at);
        if (first) { first = false; await client.call("scheduled.reschedule", { draftId: moved.id, sendAt: tomorrow }); }
        return ok;
      };
      await backend.scheduled.releaseHolds();
      backend.store.scheduled.reschedule = reschedule;
      await settle();
      expect((await sends()).map((o) => JSON.parse(o.payload_json).subject)).toEqual(["During"]);
      expect((await backend.store.scheduled.list()).map((s) => [s.draftId, s.sendAt])).toEqual([[moved.id, tomorrow]]);
    });

    it("a quit sends what's held, within its deadline, rather than leaving it for the next launch; a real schedule stays", async () => {
      const { backend, client, account, draft, schedule, sends } = await setup();
      const held = await draft("Held");
      const later = await draft("Later");
      await schedule(later, NOW + HOUR);
      await hold(client, account, held);
      await settle();
      // (the send itself takes real time)
      vi.useRealTimers();
      expect(await backend.quiesce(3000)).toBe("idle");
      // sent, not waiting: a queued one would still be listed here
      expect(await sends()).toEqual([]);
      expect(sqlDb(backend.store).all("SELECT subject FROM messages WHERE is_sent = 1 AND subject = 'Held'")).toHaveLength(1);
      expect((await backend.store.scheduled.list()).map((s) => s.draftId)).toEqual([later.id]);
    });
  });

  it("a moment already past sends at once; nothing scheduled, no timer", async () => {
    const { backend, draft, schedule, sends } = await setup();
    backend.scheduled.poke();
    await settle();
    expect(backend.scheduled.nextAt).toBeNull();
    await schedule(await draft(), NOW - 1);
    await settle();
    expect(await sends()).toHaveLength(1);
    expect(backend.scheduled.nextAt).toBeNull();
  });

  it("cancel makes it a draft again; reschedule moves the timer; both refuse one that isn't scheduled", async () => {
    const { backend, client, draft, schedule, advance, sends } = await setup();
    const d = await draft();
    await schedule(d, NOW + HOUR);
    await client.call("scheduled.reschedule", { draftId: d.id, sendAt: NOW + 2 * HOUR });
    await settle();
    expect(backend.scheduled.nextAt).toBe(NOW + 2 * HOUR);
    await client.call("scheduled.cancel", { draftId: d.id });
    await settle();
    expect(backend.scheduled.nextAt).toBeNull();
    expect((await client.call("drafts.list", {})).map((x) => x.id)).toEqual([d.id]);
    await advance(3 * HOUR);
    expect(await sends()).toEqual([]);
    await expect(client.call("scheduled.cancel", { draftId: d.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.call("scheduled.reschedule", { draftId: d.id, sendAt: NOW })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a draft edited after it was prepared can't be scheduled", async () => {
    const { client, account, draft, schedule } = await setup();
    const d = await draft();
    await client.call("drafts.save", { id: d.id, generation: d.generation, baseRevision: d.revision, accountId: account, to: [], cc: [], subject: "Lunch!", bodyText: "x" });
    await expect(schedule(d, NOW + HOUR)).rejects.toMatchObject({ code: "STALE" });
  });

  it("an edit from another window unschedules it (the edit wins) and the windows load the draft back", async () => {
    const { client, account, draft, schedule, drafts, events } = await setup();
    const d = await draft();
    await schedule(d, NOW + HOUR);
    await settle();
    await client.call("drafts.save", { id: d.id, generation: d.generation, baseRevision: d.revision, accountId: account, to: [], cc: [], subject: "Lunch!", bodyText: "x" });
    await settle();
    expect(drafts).toContainEqual({ reason: "scheduled" });
    expect(events.at(-1)!.items).toEqual([]);
    expect((await client.call("drafts.list", {})).map((x) => x.subject)).toEqual(["Lunch!"]);
  });

  it("a cancel while the due send is being prepared wins: nothing is sent", async () => {
    const { backend, client, draft, schedule, advance, sends } = await setup();
    const d = await draft();
    await schedule(d, NOW + HOUR);
    await settle();
    // the send reads its row, then the cancel lands before the queue's transaction
    const get = backend.store.scheduled.get.bind(backend.store.scheduled);
    vi.spyOn(backend.store.scheduled, "get").mockImplementationOnce(async (id) => {
      const row = await get(id);
      await client.call("scheduled.cancel", { draftId: d.id });
      return row;
    });
    await advance(HOUR);
    expect(await sends()).toEqual([]);
    expect((await client.call("drafts.list", {})).map((x) => x.id)).toEqual([d.id]);
    expect((await client.call("scheduled.list", {})).failed).toEqual([]);
  });

  it("a draft that changed or went is given back, and the failure is kept until it's seen", async () => {
    const { backend, client, draft, schedule, advance, drafts } = await setup();
    const d = await draft();
    await schedule(d, NOW + HOUR);
    await settle();
    // changed behind the schedule's back (not through drafts.save): the send's fence refuses it
    sqlDb(backend.store).run("UPDATE drafts SET revision = revision + 1 WHERE id = ?", d.id);
    await advance(HOUR);
    expect(drafts).toContainEqual({ reason: "scheduled" });
    const snap = await client.call("scheduled.list", {});
    expect(snap.items).toEqual([]);
    expect(snap.failed).toEqual([expect.objectContaining({ draftId: d.id, subject: "Lunch" })]);
    expect((await client.call("drafts.list", {})).map((x) => x.id)).toEqual([d.id]);
    await client.call("scheduled.ackFailed", { ids: [snap.failed[0]!.id] });
    expect((await client.call("scheduled.list", {})).failed).toEqual([]);
    expect(await backend.store.settings.get(FAILED_KEY, null)).toEqual([]);
  });

  it("anything else keeps it scheduled, says why, and tries again later (never a spin)", async () => {
    const { backend, draft, schedule, advance, sends, events } = await setup();
    await schedule(await draft(), NOW + HOUR);
    await settle();
    const queue = vi.spyOn(backend.store.compose, "queueSend").mockRejectedValueOnce(new Error("disk full"));
    await advance(HOUR);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(events.at(-1)!.items[0]).toMatchObject({ error: "disk full", retryAt: NOW + HOUR + retryDelay(0) });
    expect(backend.scheduled.nextAt).toBe(NOW + HOUR + 60_000);
    queue.mockRestore();
    await advance(60_000);
    expect(await sends()).toHaveLength(1);
    expect(events.at(-1)!.items).toEqual([]);
  });

  it("a store that refuses even the failure note keeps a timer (a minute on), and sends once it works", async () => {
    const { backend, draft, schedule, advance, sends } = await setup();
    await schedule(await draft(), NOW + HOUR);
    await settle();
    const queue = vi.spyOn(backend.store.compose, "queueSend").mockRejectedValueOnce(new Error("disk full"));
    const fail = vi.spyOn(backend.store.scheduled, "fail").mockRejectedValueOnce(new Error("disk full"));
    await advance(HOUR);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(backend.scheduled.nextAt).toBe(NOW + HOUR + 60_000);
    queue.mockRestore();
    fail.mockRestore();
    await advance(60_000);
    expect(await sends()).toHaveLength(1);
  });

  it("a list that can't be read looks again in a minute", async () => {
    const { backend, draft, schedule, advance, sends } = await setup();
    await schedule(await draft(), NOW + HOUR);
    await settle();
    vi.spyOn(backend.store.scheduled, "list").mockRejectedValueOnce(new Error("disk full"));
    await advance(HOUR);
    expect(backend.scheduled.nextAt).toBe(NOW + HOUR + 60_000);
    await advance(60_000);
    expect(await sends()).toHaveLength(1);
  });

  it("a reply whose original is gone is given back, not retried forever", async () => {
    const { backend, client, account, advance, drafts } = await setup();
    const db = sqlDb(backend.store);
    const { ingestMessages } = await import("@terno/db");
    const original = ingestMessages(db, [{ accountId: account, providerMsgId: "o1", providerThreadId: null, rfcMessageId: "o1@x", inReplyTo: null, references: [], from: { name: "Ana", email: "ana@friends.com" }, to: [{ name: "Me", email: "me@example.com" }], cc: [], bcc: [], subject: "Lunch", date: NOW - HOUR, snippet: "", bodyText: "Friday?", bodyHtml: null, bodyState: "full", listId: null, isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 10 }], NOW).inserted[0]!;
    const d = (await client.call("drafts.save", { accountId: account, to: [{ name: "Ana", email: "ana@friends.com" }], cc: [], subject: "Re: Lunch", bodyText: "Yes", inReplyToMessageId: original }))!;
    await client.call("compose.schedule", { accountId: account, to: [{ name: "Ana", email: "ana@friends.com" }], subject: "Re: Lunch", bodyText: "Yes", inReplyToMessageId: original, draftId: d.id, draftGeneration: d.generation!, draftRevision: d.revision, sendAt: NOW + HOUR });
    await settle();
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM messages WHERE id = ?", original);
    db.run("PRAGMA foreign_keys = ON");
    await advance(HOUR);
    const snap = await client.call("scheduled.list", {});
    expect(snap.items).toEqual([]);
    expect(snap.failed).toEqual([expect.objectContaining({ draftId: d.id })]);
    expect(drafts).toContainEqual({ reason: "scheduled" });
  });

  it("a wake and a window's focus look again (a timer runs late across sleep)", async () => {
    const { backend, client, clock, draft, schedule, sends } = await setup();
    await schedule(await draft(), NOW + HOUR);
    await settle();
    // the clock jumps without the timer firing (asleep)
    clock.now += 2 * HOUR;
    backend.networkChanged(true, "wake");
    await settle();
    expect(await sends()).toHaveLength(1);
    await schedule(await draft("Two"), clock.now + HOUR);
    await settle();
    clock.now += 2 * HOUR;
    await client.call("sync.now", { reason: "focus" });
    await settle();
    expect(await sends()).toHaveLength(2);
  });

  it("refuses past the cap", async () => {
    const { backend, draft, schedule } = await setup();
    const put = vi.spyOn(backend.store.scheduled, "put").mockResolvedValueOnce("full");
    await expect(schedule(await draft(), NOW + HOUR)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(put).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ count: SCHEDULED_MAX }));
  });

  it("deleting a scheduled draft takes its schedule (and the timer) with it", async () => {
    const { backend, client, draft, schedule, events } = await setup();
    const d = await draft();
    await schedule(d, NOW + HOUR);
    await settle();
    await client.call("drafts.delete", { id: d.id, generation: d.generation });
    await settle();
    expect(events.at(-1)!.items).toEqual([]);
    expect(backend.scheduled.nextAt).toBeNull();
  });

  it("stop() clears the timer and waits for a send in flight", async () => {
    const { backend, draft, schedule, advance } = await setup();
    await schedule(await draft(), NOW + HOUR);
    await settle();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = backend.store.compose.queueSend.bind(backend.store.compose);
    let finished = false;
    vi.spyOn(backend.store.compose, "queueSend").mockImplementationOnce(async (p) => {
      await gate;
      const r = await real(p);
      finished = true;
      return r;
    });
    await advance(HOUR);
    const stopping = backend.scheduled.stop();
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await settle();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
    expect(backend.scheduled.nextAt).toBeNull();
  });
});

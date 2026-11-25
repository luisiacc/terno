/**
 * Plan 210 (iteration 4, Hand to…) through the real backend, with a scripted provider: the hand-off resolved as an act on its
 * row would be, saved with the forward's draft, carried by the send; the item closes as handed only when the provider
 * confirms that send: never while it's held for Undo or queued, never after a cancel, a failure or an uncertain delivery.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, type AiOptions, type ProviderConfig } from "@terno/ai";
import { HANDED } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { ProviderError, type MailProvider, type ProviderOp, type ProviderRegistry } from "@terno/mail";
import { AWAITING_ITEM, type DatedWrite } from "@terno/store";
import { msg, threadOf } from "@terno/store/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = new Date(2026, 10, 13, 9).getTime();
const DAY = 86_400_000;
const school = { name: "School", email: "office@school.test" };
const jess = { name: "Jess Okafor", email: "jess@home.test" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Scripted extends MailProvider {
  failNext: ProviderError | null;
  gate: Promise<void> | null;
  sent: ProviderOp[];
}

async function setup(row: Partial<DatedWrite> = {}) {
  const providers = new Map<number, Scripted>();
  const registry: ProviderRegistry = {
    create(ctx) {
      const p: Scripted = {
        failNext: null,
        gate: null,
        sent: [],
        async verify() {},
        async sync() {},
        async execute(op) {
          if (p.gate) await p.gate;
          if (p.failNext) {
            const e = p.failNext;
            p.failNext = null;
            throw e;
          }
          if (op.kind === "send") {
            p.sent.push(op);
            return { providerMsgId: `srv-${op.id}` };
          }
        },
        async close() {},
      };
      providers.set(ctx.account.id, p);
      return p;
    },
    async verifyImap() {},
    async connectGmail() {
      throw new Error("not in tests");
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-handto-"));
  // the readers' model finds nothing, and says the forward expects no reply: its wait comes from the hand-off alone
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async (req) =>
          req.schema?.name === "sent_mail"
            ? { text: JSON.stringify({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [], theirs: [], owedKept: [] }), stop: "end" as const }
            : { text: JSON.stringify({ items: [], settled: [], moved: [], replaced: [] }), stop: "end" as const },
      },
    });
  const backend = new Backend({ dbPath: join(dir, "a.db"), version: "t", cipher: plaintextCipher, providers: registry, autoSync: false, demoAi: true, aiFactory: factory, now: () => NOW });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@terno.test", displayName: "Me", color: "brown", now: 0 });
  await backend.provider(account.id);
  const provider = providers.get(account.id)!;
  // follow-ups on, so the forward's own wait is seeded (no model is asked for it)
  await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  await client.call("settings.update", { dated: { enabled: true }, followups: { enabled: true, nudgeAfterDays: 3 } });
  const m = msg({ accountId: account.id, from: school, to: [{ name: "Me", email: account.email }], subject: "Field trip", date: NOW - DAY, providerMsgId: "school-1" });
  const r = await backend.store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
  const source = { id: r.inserted[0]!, thread: await threadOf(backend.store, "school-1") };
  const write = (over: Partial<DatedWrite>): DatedWrite => ({ kind: "respond", item: 0, text: "Sign the field trip form", quote: "sign it by Friday", dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: false, dated: true, actAt: NOW, ...over });
  await backend.store.dated.finish({ messageId: source.id, threadId: source.thread, fromScan: false, rows: [write(row)], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: backend.store.dated.clearGeneration() });
  const [form] = await backend.store.dated.ofThread(source.thread);
  /** Hand to… as the app does it: the hand-off asked for, a forward saved with it, ready to send */
  const forward = async () => {
    const h = await client.call("today.handoff", { source: "dated", id: form!.id, revision: form!.revision });
    const d = (await client.call("drafts.save", { accountId: account.id, mode: "forward", threadId: h.threadId, forwardOfMessageId: h.messageId, to: [jess], cc: [], subject: "Fwd: Field trip", bodyText: "Could you take care of this: sign the field trip form (by Fri)?", handoff: { items: h.items } }))!;
    const params = { accountId: account.id, to: [jess], subject: d.subject, bodyText: d.bodyText, forwardOfMessageId: h.messageId, draftId: d.id, draftGeneration: d.generation!, draftRevision: d.revision };
    return { h, d, params };
  };
  const item = () => backend.store.dated.get(form!.id);
  return { backend, client, account, provider, source, form: form!, forward, item };
}

describe("Hand to…", () => {
  it("resolves the row as Done would, with the message its forward forwards; a revision seen before a change is stale", async () => {
    const { client, source, form } = await setup();
    const h = await client.call("today.handoff", { source: "dated", id: form.id, revision: form.revision });
    expect(h).toEqual({ threadId: source.thread, messageId: source.id, items: [{ source: "dated", id: form.id, revision: form.revision, named: true }], text: "Sign the field trip form", dueAt: form.dueAt, timed: false, partOfDay: null });
    await expect(client.call("today.handoff", { source: "dated", id: form.id, revision: form.revision + 1 })).rejects.toMatchObject({ code: "STALE" });
  });

  it("round 14's faults: a timed item's time and an untimed one's part of the day come with its day, for the line", async () => {
    const timed = await setup({ text: "Wire $187,420.55 for Lumora payroll", dueDay: "2026-11-13", dueAt: NOW + 3 * 3_600_000, timed: true });
    expect(await timed.client.call("today.handoff", { source: "dated", id: timed.form.id, revision: timed.form.revision })).toMatchObject({ dueAt: NOW + 3 * 3_600_000, timed: true, partOfDay: null });
    const part = await setup({ partOfDay: "morning" });
    expect(await part.client.call("today.handoff", { source: "dated", id: part.form.id, revision: part.form.revision })).toMatchObject({ timed: false, partOfDay: "morning" });
  });

  it("the draft keeps it; held for Undo and then cancelled, nothing closes and the draft is back with it", async () => {
    const { client, forward, item, form } = await setup();
    const { d, params } = await forward();
    expect((await client.call("drafts.list", {})).find((x) => x.id === d.id)!.handoff).toEqual({ items: [{ source: "dated", id: form.id, revision: form.revision, named: true }] });
    expect(await client.call("compose.hold", { ...params, holdSeconds: 10 })).toEqual({ held: true });
    expect(await item()).toMatchObject({ state: "open", revision: form.revision });
    await client.call("scheduled.cancel", { draftId: d.id });
    expect((await client.call("drafts.list", {})).find((x) => x.id === d.id)!.handoff?.items[0]).toMatchObject({ id: form.id, named: true });
    expect(await item()).toMatchObject({ state: "open", revision: form.revision, handedTo: null });
  });

  it("queued is not sent: the item closes as handed to whom it went only when the provider confirms, and the forward waits on them", async () => {
    const { backend, client, provider, forward, item, form } = await setup();
    const { params } = await forward();
    let release!: () => void;
    provider.gate = new Promise((r) => (release = r));
    const changed: unknown[] = [];
    client.on("todayChanged", (e) => changed.push(e));
    const sent = await client.call("compose.send", params);
    const running = backend.runWorker();
    await new Promise((r) => setTimeout(r, 20));
    // queued and on its way: nothing claimed
    expect(await item()).toMatchObject({ state: "open", revision: form.revision });
    release();
    await running;
    await backend.runWorker();
    expect(provider.sent).toHaveLength(1);
    expect(await item()).toMatchObject({ state: "done", closedReason: HANDED, revision: form.revision + 1, handedTo: { name: jess.name, email: jess.email } });
    expect(changed.length).toBeGreaterThan(0);
    const waits = await backend.store.followups.ofThread(sent.threadId);
    expect(waits).toEqual([expect.objectContaining({ kind: "awaiting", item: AWAITING_ITEM, personEmail: jess.email, messageId: sent.messageId, state: "open" })]);
    // Earlier says so
    const history = await client.call("today.history", { after: { at: NOW + DAY, src: 0, id: 1 }, limit: 10, held: [] });
    expect(history.items.map((i) => [i.outcome, i.handedTo?.email])).toEqual([["handed", jess.email]]);
  });

  it("a send that fails for good, or whose delivery is uncertain, claims nothing", async () => {
    const { backend, client, provider, forward, item, form } = await setup();
    provider.failNext = new ProviderError("550 mailbox unavailable", false);
    await client.call("compose.send", (await forward()).params);
    await backend.runWorker();
    expect((await client.call("ops.list", {}))[0]).toMatchObject({ state: "failed" });
    provider.failNext = new ProviderError("connection closed after DATA", false, true);
    const unsure = await client.call("compose.send", (await forward()).params);
    await backend.runWorker();
    expect((await backend.store.ops.get(unsure.opId))!.state).toBe("unknown");
    expect(await item()).toMatchObject({ state: "open", revision: form.revision, handedTo: null });
  });

  it("a reply's row hands its other promises with it, as its Done takes them; one changed since is stale (iteration 4, merge)", async () => {
    const { backend, client, account } = await setup();
    const mine = msg({ accountId: account.id, from: { name: "Me", email: account.email }, to: [school], isSent: true, inInbox: false, subject: "The trip", date: NOW - 1000, providerMsgId: "mine-1", rfcMessageId: "mine-1@x" });
    const sent = await backend.store.sync.ingest([mine], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
    const thread = await threadOf(backend.store, "mine-1");
    const promise = (item: number, text: string, dated: boolean) => ({ kind: "promise" as const, item, text, quote: text, personName: school.name, personEmail: school.email, dueAt: NOW + DAY, dated });
    await backend.store.followups.finish({ messageId: sent.inserted[0]!, threadId: thread, fromScan: false, rows: [promise(0, "send the signed slip", true), promise(1, "bring the snacks", false)], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: backend.store.followups.clearGeneration() });
    const [slip, snacks] = (await backend.store.followups.ofThread(thread)).filter((p) => p.kind === "promise").sort((a, b) => a.item - b.item);
    // one row, the slip leading, the snacks its Also line
    const row = (await client.call("today.list", { held: [] })).sections.flatMap((x) => x.items).find((i) => i.id === `promise:${slip!.id}`)!;
    expect(row.why.with).toEqual([{ source: "promise", id: snacks!.id, revision: snacks!.revision }]);
    const h = await client.call("today.handoff", { source: "promise", id: slip!.id, revision: slip!.revision, with: [{ source: "promise", id: snacks!.id, revision: snacks!.revision }] });
    expect(h.items).toEqual([
      { source: "promise", id: slip!.id, revision: slip!.revision, named: true },
      { source: "promise", id: snacks!.id, revision: snacks!.revision, named: true },
    ]);
    expect(h).toMatchObject({ threadId: thread, text: "send the signed slip" });
    // the Also line changed since it was shown: the row isn't handed as it was
    await expect(client.call("today.handoff", { source: "promise", id: slip!.id, revision: slip!.revision, with: [{ source: "promise", id: snacks!.id, revision: snacks!.revision + 1 }] })).rejects.toMatchObject({ code: "STALE" });
  });

  it("an agent's save can't set a hand-off", async () => {
    const { backend, account, form, source } = await setup();
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "agent", origin: "mcp" });
    const agent = new RpcClient(c);
    const d = (await agent.call("drafts.save", { accountId: account.id, mode: "forward", threadId: source.thread, forwardOfMessageId: source.id, to: [], cc: [], subject: "Fwd", bodyText: "x", handoff: { items: [{ source: "dated", id: form.id, revision: form.revision, named: true }] } }).catch(() => null));
    if (d) expect(d.handoff ?? null).toBeNull();
  });
});

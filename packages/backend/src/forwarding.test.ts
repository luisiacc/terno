import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, RpcError } from "@terno/core/rpc";
import { FORWARD_CAP, FORWARD_DELAY_MS, MAX_RECIPIENTS, type ForwardSnapshot } from "@terno/core";
import { L, LOCALES } from "@terno/i18n";
import { createAccount, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { msg } from "@terno/store/conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 10, 1, 12);
const ANA = { name: "Ana", email: "ana@books.test" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const turn = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 12; i++) await turn();
}

/** A backend on a clock the test moves, one account, a category that forwards to Ana, and a filter that files "factura" there. */
async function setup(o: { trigger?: boolean; name?: string } = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = { now: NOW };
  const dir = mkdtempSync(join(tmpdir(), "terno-fwd-"));
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => clock.now, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  const [mc, ms] = createMemoryTransportPair();
  backend.connect(ms, { clientId: "agent", origin: "mcp" });
  const agent = new RpcClient(mc);
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const account = createAccount(sqlDb(backend.store), { kind: "gmail", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
  const cat = await client.call("categories.create", { name: o.name ?? "Facturas", color: "amber" });
  await client.call("filters.save", { name: "Facturas", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "factura" }], actions: [{ type: "addCategory", categoryId: cat.id }] } });
  if (o.trigger !== false) await client.call("categories.setForward", { categoryId: cat.id, forward: { addresses: [ANA], enabled: true } });
  const events: ForwardSnapshot[] = [];
  client.on("forwards", (e) => events.push(e));
  const advance = async (ms: number) => {
    clock.now += ms;
    vi.advanceTimersByTime(ms);
    await settle();
  };
  /** mail arriving now (live by default), its subject a "factura" */
  const arrive = async (over: Partial<Parameters<typeof msg>[0]> = {}, live = true) => {
    const m = msg({ accountId: account, subject: "Tu factura de octubre", date: clock.now - 60_000, from: { name: "Shop", email: "billing@shop.test" }, bodyText: "Total: 10", ...over });
    const r = await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, live);
    await settle();
    return r.inserted[0]!;
  };
  const sends = async () => (await backend.store.ops.recent(200)).filter((op) => op.kind === "send");
  const last = () => events[events.length - 1]!;
  return { backend, client, agent, account, cat, events, clock, advance, arrive, sends, last };
}

describe("forwarding (plan 116)", () => {
  it("forwards live mail filed into the category 10 s later, once, as the composer's Forward writes it", async () => {
    const { backend, arrive, advance, sends, last } = await setup();
    const id = await arrive();
    expect(last().items).toMatchObject([{ messageId: id, status: "waiting", dueAt: NOW + FORWARD_DELAY_MS, ruleName: "Facturas", to: [ANA] }]);
    expect(backend.forwards.nextAt).toBe(NOW + FORWARD_DELAY_MS);
    await advance(FORWARD_DELAY_MS - 1);
    expect(await sends()).toEqual([]);
    await advance(1);
    const [op, ...more] = await sends();
    expect(more).toEqual([]);
    const payload = JSON.parse(op!.payload_json) as { to: unknown; subject: string; text: string };
    expect(payload.to).toEqual([ANA]);
    expect(payload.subject).toBe("Fwd: Tu factura de octubre");
    expect(payload.text).toContain("---------- Forwarded message ----------\nFrom: Shop <billing@shop.test>");
    expect(payload.text).toContain("Subject: Tu factura de octubre");
    expect(payload.text).toContain("Total: 10");
    expect(last().items[0]).toMatchObject({ status: "sending" });
    // nothing waits: no timer
    expect(backend.forwards.nextAt).toBeNull();
    await advance(60_000);
    expect(await sends()).toHaveLength(1);
  });

  it("never forwards what didn't arrive live (a first sync, a backfill)", async () => {
    const { backend, arrive, advance, sends } = await setup();
    await arrive({}, false);
    await advance(FORWARD_DELAY_MS * 2);
    expect(await sends()).toEqual([]);
    expect(backend.forwards.nextAt).toBeNull();
  });

  it("does no work while nothing forwards: live mail isn't even marked", async () => {
    const { backend, arrive } = await setup({ trigger: false });
    expect(backend.forwards.isActive).toBe(false);
    const id = await arrive();
    expect(await backend.store.forwards.eligiblePage(NOW, 0, 10)).toEqual([]);
    expect(id).toBeGreaterThan(0);
  });

  it("Cancel within the 10 s, or the mail leaving the category, sends nothing", async () => {
    const { backend, client, cat, arrive, advance, sends, last } = await setup();
    await arrive();
    const [first] = last().items;
    expect(await client.call("forwards.cancel", { ids: [first!.id] })).toEqual({ cancelled: 1 });
    const second = await arrive({ subject: "Otra factura" });
    const thread = (await backend.store.forwards.list(NOW, 10)).find((r) => r.messageId === second)!.threadId;
    await client.call("categories.removeThreads", { categoryId: cat.id, threadIds: [thread], reason: "user" });
    await advance(FORWARD_DELAY_MS);
    expect(await sends()).toEqual([]);
    expect(last().items.map((i) => [i.status, i.reason])).toEqual(expect.arrayContaining([["cancelled", null], ["cancelled", "forward.reason.left"]]));
  });

  it("files one conversation by hand: it goes; a bulk filing never", async () => {
    const { backend, client, cat, arrive, advance, sends } = await setup();
    await client.call("filters.delete", { id: (await backend.store.filters.list())[0]!.id });
    const one = await arrive({ subject: "hola" }), two = await arrive({ subject: "hola 2" }), three = await arrive({ subject: "hola 3" });
    const threadOf = async (id: number) => (await backend.store.debug.snapshot()).messages.find((m) => m.id === id)!.threadId;
    await client.call("categories.addThreads", { categoryId: cat.id, threadIds: [await threadOf(one)], source: "picker" });
    await client.call("categories.addThreads", { categoryId: cat.id, threadIds: [await threadOf(two), await threadOf(three)], source: "picker" });
    await settle();
    await advance(FORWARD_DELAY_MS);
    expect(await sends()).toHaveLength(1);
  });

  it("holds what passes the cap until the user answers; Keep forwarding sends it, Stop turns the trigger off", async () => {
    const { backend, client, cat, arrive, advance, sends, last } = await setup();
    for (let i = 0; i < FORWARD_CAP; i++) await arrive({ subject: `factura ${i}` });
    await advance(FORWARD_DELAY_MS);
    expect(await sends()).toHaveLength(FORWARD_CAP);
    await arrive({ subject: "factura de más" });
    await advance(FORWARD_DELAY_MS);
    expect(await sends()).toHaveLength(FORWARD_CAP);
    expect(last().questions).toEqual([{ rule: { kind: "category", id: cat.id }, ruleName: "Facturas", count: FORWARD_CAP, held: 1 }]);
    await client.call("forwards.answer", { rule: { kind: "category", id: cat.id }, keep: true });
    await settle();
    expect(last().questions).toEqual([]);
    await advance(FORWARD_DELAY_MS);
    expect(await sends()).toHaveLength(FORWARD_CAP + 1);

    // approved for the day: the next ones go without asking
    await arrive({ subject: "factura extra" });
    await advance(FORWARD_DELAY_MS);
    expect(await sends()).toHaveLength(FORWARD_CAP + 2);
    await client.call("forwards.answer", { rule: { kind: "category", id: cat.id }, keep: false });
    expect((await backend.store.categories.list()).find((c) => c.id === cat.id)?.forward?.enabled).toBe(false);
    expect(backend.forwards.isActive).toBe(false);
  });

  it("writes the forward in the language set (Spanish)", async () => {
    const { client, arrive, advance, sends } = await setup();
    // the catalog loads on first use (a dynamic import): loaded here, so the forward doesn't wait on the module graph
    await LOCALES.es.load();
    await client.call("settings.update", { language: "es" });
    await arrive();
    await advance(FORWARD_DELAY_MS);
    // the Spanish catalog loads on first use (a dynamic import): a few more turns
    for (let i = 0; i < 100 && !(await sends()).length; i++) await new Promise((r) => setImmediate(r));
    const payload = JSON.parse((await sends())[0]!.payload_json) as { subject: string; text: string };
    expect(payload.subject).toBe("Fwd: Tu factura de octubre");
    expect(payload.text).toContain("---------- Mensaje reenviado ----------");
  });

  it("an agent can't set up or change forwarding through a filter", async () => {
    const { agent, cat } = await setup();
    await expect(agent.call("filters.save", { name: "x", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "a" }], actions: [{ type: "forward", to: [ANA] }] } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.call("categories.setForward", { categoryId: cat.id, forward: null })).rejects.toBeTruthy();
  });

  it("finishes a forward a quit interrupted after it was claimed, without sending it twice", async () => {
    const { backend, arrive, advance, sends } = await setup();
    const id = await arrive();
    const row = (await backend.store.forwards.list(NOW, 10)).find((r) => r.messageId === id)!;
    // claimed (as if the quit came right after), nothing queued yet
    expect((await backend.store.forwards.claim(row.id, NOW + FORWARD_DELAY_MS, { filesMissing: false, own: [] })).kind).toBe("go");
    await advance(FORWARD_DELAY_MS);
    backend.forwards.poke();
    await settle();
    expect(await sends()).toHaveLength(1);
    backend.forwards.poke();
    await settle();
    expect(await sends()).toHaveLength(1);
  });

  describe("after the Codex code review", () => {
    it("#7: a full Sent-copy queue waits and tries again; it never fails the forward", async () => {
      const { backend, arrive, advance, sends, last } = await setup();
      await arrive();
      const queue = backend.store.compose.queueSend.bind(backend.store.compose);
      let refused = 0;
      const spy = vi.spyOn(backend.store.compose, "queueSend").mockImplementation(async (c) => {
        if (refused++ === 0) throw new RpcError("BAD_REQUEST", L("errors.recipientReceipt.capacity"));
        return queue(c);
      });
      await advance(FORWARD_DELAY_MS);
      expect(await sends()).toEqual([]);
      expect(last().items[0]).toMatchObject({ status: "sending" });
      await advance(60_000);
      expect(await sends()).toHaveLength(1);
      spy.mockRestore();
    });

    it("#7/#10: a send that can never go after another went: partly sent, said so", async () => {
      const { backend, client, cat, arrive, advance, sends, last } = await setup();
      const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({ name: "", email: `p${i}@many.test` }));
      await client.call("categories.setForward", { categoryId: cat.id, forward: { addresses: many, enabled: true } });
      await arrive();
      const queue = backend.store.compose.queueSend.bind(backend.store.compose);
      const spy = vi.spyOn(backend.store.compose, "queueSend").mockImplementation(async (c) => {
        if (c.forward?.chunk === 1) throw new RpcError("BAD_REQUEST", L("attachments.unavailable"));
        return queue(c);
      });
      await advance(FORWARD_DELAY_MS);
      expect(await sends()).toHaveLength(1);
      expect(last().items[0]).toMatchObject({ status: "partial", reason: "forward.reason.failed" });
      spy.mockRestore();
    });

    it("#8: a body that arrives later and makes its filter file it: forwarded", async () => {
      const { backend, client, cat, account, advance, sends } = await setup();
      await client.call("filters.save", { name: "Total", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "Total a pagar" }], actions: [{ type: "addCategory", categoryId: cat.id }] } });
      const headers = msg({ accountId: account, providerMsgId: "late-body", subject: "Su estado de cuenta", date: NOW - 60_000, bodyText: null, bodyState: "none" });
      await backend.ingestSliced([headers], true, undefined, undefined, undefined, undefined, undefined, true);
      await settle();
      await advance(FORWARD_DELAY_MS);
      expect(await sends()).toEqual([]);
      await backend.ingestSliced([{ ...headers, bodyText: "Total a pagar: 10", bodyState: "full" }], true, undefined, undefined, undefined, undefined, undefined, true);
      await settle();
      await advance(FORWARD_DELAY_MS);
      expect(await sends()).toHaveLength(1);
    });

    it("#9: a message whose thread merged into another still goes", async () => {
      const { backend, arrive, advance, sends } = await setup();
      const elsewhere = await arrive({ subject: "Otra conversación" }, false);
      const id = await arrive();
      const db = sqlDb(backend.store);
      const other = (await backend.store.debug.snapshot()).messages.find((m) => m.id === elsewhere)!.threadId;
      // as a merge does: the message moves, and its conversation's categories with it
      const from = (await backend.store.debug.snapshot()).messages.find((m) => m.id === id)!.threadId;
      db.run("INSERT INTO thread_categories (thread_id, category_id, added_by, added_at) SELECT ?, category_id, added_by, added_at FROM thread_categories WHERE thread_id = ?", other, from);
      db.run("UPDATE messages SET thread_id = ? WHERE id = ?", other, id);
      expect((await backend.store.forwards.get((await backend.store.forwards.list(NOW, 10))[0]!.id))?.threadId).toBe(other);
      await advance(FORWARD_DELAY_MS);
      expect(await sends()).toHaveLength(1);
    });

    it("#13: an export's category forwarding comes back, turned off", async () => {
      const { client, cat } = await setup();
      const data = await client.call("app.export", {});
      expect(data.categories.find((c) => c.id === cat.id)?.forward).toEqual({ addresses: [ANA], enabled: true });
      const { client: fresh } = await setup({ trigger: false, name: "Otra" });
      await fresh.call("app.import", { data: { ...data, categories: data.categories.map((c) => ({ ...c, name: c.id === cat.id ? "Facturas importadas" : c.name })) } });
      const imported = (await fresh.call("app.bootstrap", {})).categories.find((c) => c.name === "Facturas importadas");
      expect(imported?.forward).toEqual({ addresses: [ANA], enabled: false });
    });
  });

  describe("after the Codex code review, round 2", () => {
    it("#2: an agent can't make a filter file new mail into a category that forwards, unless agents may send", async () => {
      const { agent, client, cat } = await setup();
      const rule = { match: "all" as const, conditions: [{ field: "subject" as const, op: "contains" as const, value: "a" }], actions: [{ type: "addCategory" as const, categoryId: cat.id }] };
      await expect(agent.call("filters.save", { name: "x", enabled: true, source: "manual", rule })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(agent.call("categorize.apply", { categoryId: cat.id, scope: { kind: "sender", email: "a@b.test" }, always: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await client.call("settings.update", { allowAgentSend: true });
      await expect(agent.call("filters.save", { name: "x", enabled: true, source: "manual", rule })).resolves.toMatchObject({ name: "x" });
    });

    it("#3/#4: the real capacity refusals wait for room, and the forwards after them still go", async () => {
      const { backend, advance, arrive, sends, last } = await setup();
      for (let i = 0; i < 52; i++) await arrive({ subject: `factura ${i}` });
      const blocked = new Set((await backend.store.forwards.list(NOW, 200)).map((r) => r.id).sort((a, b) => a - b).slice(0, 51));
      const queue = backend.store.compose.queueSend.bind(backend.store.compose);
      const keys = ["errors.sentCopy.capacity", "errors.recipientReceipt.wireCapacity"] as const;
      let n = 0;
      const spy = vi.spyOn(backend.store.compose, "queueSend").mockImplementation(async (c) => {
        if (blocked.has(c.forward!.id)) throw new RpcError("BAD_REQUEST", L(keys[n++ % 2]!));
        return queue(c);
      });
      await advance(FORWARD_DELAY_MS);
      expect(await sends()).toHaveLength(1);
      expect(last().items.filter((i) => i.status === "failed")).toEqual([]);
      spy.mockRestore();
      await advance(60_000);
      expect(await sends()).toHaveLength(52);
    });
  });
});

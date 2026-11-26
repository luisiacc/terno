/**
 * Plan 282 on the backend: Put away's page, the reader's why, Back to Inbox with one exact Undo (both halves: the move
 * back and a rule's hidden filing), Stop this rule only while the rule is as it was, and the Inbox line's seen mark.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { CategorizerModel, encodeFeatures, extractFeatures, type FilterRule } from "@terno/core";
import { demoRegistry } from "@terno/mail";
import { msg, threadOf, withAccounts } from "@terno/store/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 10, 25, 12);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const from = (email: string, actions: FilterRule["actions"]): FilterRule => ({ match: "all", conditions: [{ field: "from", op: "equals", value: email }], actions });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-put-away-"));
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: `renderer-${Math.random()}`, origin: "renderer" });
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const [acct] = await withAccounts(backend.store, 1);
  let n = 0;
  const arrive = async (email: string, over: Partial<Parameters<typeof msg>[0]> = {}) => {
    const m = msg({ accountId: acct!, providerMsgId: `pa-${++n}`, from: { name: email.split("@")[0]!, email }, date: NOW - 1000 + n, ...over });
    await backend.store.sync.ingest([m], { applyFilters: true, now: NOW, classifier: null });
    return threadOf(backend.store, m.providerMsgId!);
  };
  const rule = (email: string, actions: FilterRule["actions"], name = "Rule") => backend.store.filters.save({ name, enabled: true, source: "manual", rule: from(email, actions) }, NOW - 1);
  return { backend, client: new RpcClient(c), acct: acct!, arrive, rule };
}

describe("Put away (plan 282)", () => {
  it("lists what a rule archived, says why in the reader, and Back to Inbox with its Undo is exact", async () => {
    const { client, arrive, rule } = await setup();
    const f = await rule("news@xataka.test", [{ type: "archive" }], "Xataka");
    const t = await arrive("news@xataka.test");
    const page = await client.call("putAway.page", { limit: 10 });
    expect(page.items.map((i) => i.id)).toEqual([t]);
    expect(page.placements[0]).toMatchObject({ threadId: t, detail: { by: "rule", filterId: f.id, action: "archive" } });
    expect((await client.call("threads.get", { threadId: t })).putAway).toMatchObject({ ruleLive: true, detail: { name: "Xataka" } });
    const at = (await client.call("threads.get", { threadId: t })).putAway!.at;
    // a window showing an older placement is refused, and nothing moves
    await expect(client.call("putAway.back", { items: [{ threadId: t, at: at - 1 }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const back = await client.call("putAway.back", { items: [{ threadId: t, at }] });
    expect(back.affected).toBe(1);
    expect((await client.call("threads.get", { threadId: t })).putAway).toBeNull();
    expect((await client.call("putAway.page", { limit: 10 })).items).toEqual([]);
    await client.call("threads.undo", { undoId: back.undoId! });
    expect((await client.call("putAway.page", { limit: 10 })).items.map((i) => i.id)).toEqual([t]);
  });

  it("a rule's hidden filing: Back to Inbox takes it out with no example, and Undo files it back", async () => {
    const { backend, client, arrive, rule } = await setup();
    const hidden = await backend.store.categories.create("Lecturas", "violet", { showInInbox: false });
    await rule("digest@x.test", [{ type: "addCategory", categoryId: hidden.id }]);
    const t = await arrive("digest@x.test");
    const back = await client.call("putAway.back", { items: [{ threadId: t, at: NOW }] });
    expect(back.undoId).not.toBeNull();
    expect((await backend.store.threads.summaries([t]))[0]!.categoryIds).toEqual([]);
    await client.call("threads.undo", { undoId: back.undoId! });
    expect((await backend.store.threads.summaries([t]))[0]!.categoryIds).toEqual([hidden.id]);
    expect((await client.call("threads.get", { threadId: t })).putAway).toMatchObject({ detail: { action: "addCategory" } });
  });

  it("Stop this rule turns it off while it's as it was; an edited rule is refused; Don't file … is only for Terno's own filing", async () => {
    const { backend, client, arrive, rule } = await setup();
    const f = await rule("news@xataka.test", [{ type: "archive" }]);
    const t = await arrive("news@xataka.test");
    await expect(client.call("putAway.keep", { threadId: t, at: NOW })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const stopped = await client.call("putAway.stopRule", { threadId: t, at: NOW });
    expect((await backend.store.filters.list()).find((x) => x.id === f.id)!.enabled).toBe(false);
    expect(stopped.filterUndo).not.toBeNull();
    // edited since: Stop is refused
    const g = await rule("deals@shop.test", [{ type: "archive" }]);
    const u = await arrive("deals@shop.test");
    await backend.store.filters.save({ id: g.id, name: g.name, enabled: true, source: "manual", rule: from("deals@shop.test", [{ type: "trash" }]) }, NOW);
    await expect(client.call("putAway.stopRule", { threadId: u, at: NOW })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // stopped already (another window): nothing to do, and said so
    expect(await client.call("putAway.stopRule", { threadId: t, at: NOW })).toEqual({ filterUndo: null });
  });

  it("Stop's second step: the reader counts what a rule that's off still keeps away; Bring back lists it, refused once the rule is on again", async () => {
    const { client, arrive, rule } = await setup();
    const f = await rule("news@xataka.test", [{ type: "archive" }]);
    const a = await arrive("news@xataka.test", { subject: "a" });
    const b = await arrive("news@xataka.test", { subject: "b" });
    expect((await client.call("threads.get", { threadId: a })).putAway).not.toHaveProperty("ruleHolding");
    await client.call("putAway.stopRule", { threadId: a, at: NOW });
    expect((await client.call("threads.get", { threadId: a })).putAway).toMatchObject({ ruleEnabled: false, ruleHolding: 2 });
    expect((await client.call("putAway.byRule", { threadId: a, at: NOW })).items.map((i) => i.threadId).sort()).toEqual([a, b].sort());
    await client.call("filters.setEnabled", { ids: [f.id], enabled: true });
    await expect(client.call("putAway.byRule", { threadId: a, at: NOW })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("Not {category} on Terno's own filing: out, a correction, and its Undo puts back Terno's filing exactly", async () => {
    const { backend, client, acct, arrive } = await setup();
    const category = await backend.store.categories.create("Facturas", "amber", { showInInbox: false });
    await backend.store.categories.update(category.id, { autoApply: true });
    const sender = "billing@shop.test";
    const own = { ownDomains: new Set(["example.com"]) };
    const enc = encodeFeatures(extractFeatures({ fromEmail: sender, fromName: "Shop", listId: null, subject: "Tu recibo", bodyText: "Total pagado", replied: false, attachmentNames: [] }, own));
    const model = new CategorizerModel({ decayRef: NOW });
    for (let i = 0; i < 12; i++) {
      const old = await arrive(sender, { from: { name: "Shop", email: sender }, subject: "Tu recibo", bodyText: "Total pagado", date: NOW - 86_400_000 - i });
      await backend.store.categories.add({ categoryId: category.id, threadIds: [old], addedBy: "user", now: NOW - 86_400_000 });
      model.train({ categoryId: category.id, label: 1, weight: 1, at: NOW, content: true, features: enc });
    }
    for (let i = 0; i < 200; i++) model.addBackground(10_000 + i, encodeFeatures(extractFeatures({ fromEmail: `amigo${i % 20}@gmail.com`, fromName: "Amigo", listId: null, subject: "Comida", bodyText: "Hola amigo", replied: false, attachmentNames: [] }, own)));
    const m = msg({ accountId: acct, providerMsgId: "filed", from: { name: "Shop", email: sender }, subject: "Tu recibo", bodyText: "Total pagado", date: NOW });
    await backend.store.sync.ingest([m], { applyFilters: true, now: NOW, classifier: { mode: "auto", model } });
    const t = await threadOf(backend.store, "filed");
    expect((await client.call("threads.get", { threadId: t })).putAway).toMatchObject({ detail: { by: "terno", categoryId: category.id } });
    // a box showing an older placement is refused
    await expect(client.call("putAway.not", { threadId: t, at: NOW - 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const not = await client.call("putAway.not", { threadId: t, at: NOW });
    expect(not).toMatchObject({ inInbox: true });
    expect((await backend.store.threads.summaries([t]))[0]!.categoryIds).toEqual([]);
    await client.call("categorize.undo", { batchId: not.batchId! });
    expect((await backend.store.threads.summaries([t]))[0]!.categoryIds).toEqual([category.id]);
    expect((await client.call("threads.get", { threadId: t })).putAway).toMatchObject({ detail: { by: "terno", categoryId: category.id } });
  });

  it("the Inbox's line: who needs a look, until it's seen", async () => {
    const { backend, client, acct, arrive, rule } = await setup();
    await rule("javier@acme.test", [{ type: "archive" }]);
    await backend.store.sync.ingest([msg({ accountId: acct, providerMsgId: "sent", from: { name: "Me", email: "me0@example.com" }, to: [{ name: "Javier", email: "javier@acme.test" }], isSent: true, inInbox: false, date: NOW - 86_400_000 })], { applyFilters: false, now: NOW - 86_400_000, classifier: null });
    const t = await arrive("javier@acme.test", { from: { name: "Javier Ortiz", email: "javier@acme.test" } });
    const line = await client.call("putAway.needsLook", {});
    expect(line).toEqual({ count: 1, first: { threadId: t, name: "Javier Ortiz" }, through: NOW });
    let told = 0;
    client.on("putAwayChanged", () => told++);
    // two windows acknowledge at once, one with an older mark: it never moves back, and the windows hear it once
    await Promise.all([client.call("putAway.seen", { through: line.through }), client.call("putAway.seen", { through: line.through - 5 })]);
    expect((await client.call("putAway.needsLook", {})).count).toBe(0);
    await expect.poll(() => told).toBe(1);
  });
});

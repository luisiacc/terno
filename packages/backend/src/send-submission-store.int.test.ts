import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import { SMTPServer } from "smtp-server";
import { Backend, plaintextCipher } from "./backend";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqlMailStore, sqlDb } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import type { MailStore, OpRow } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const terminal = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.addEventListener("complete", () => resolve()); tx.addEventListener("abort", () => reject(tx.error)); });
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((r) => setImmediate(r)) };

async function setup(adapter: "SQL" | "IDB", appendToSent = false) {
  const dir = mkdtempSync(join(tmpdir(), "terno-submission-")), name = crypto.randomUUID(), factory = new IDBFactory();
  const opened: MailStore[] = [];
  const open = async () => {
    const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "s.db"))) : await IdbMailStore.open({ name, factory, platform, instantSearch: false });
    opened.push(store); return store;
  };
  cleanup.push(async () => { for (const store of opened) if (store.isOpen) await store.close(); rmSync(dir, { recursive: true, force: true }); });
  let store = await open();
  const { account } = await store.accounts.create({ kind: "imap", email: "sender@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent }, now: 1 });
  const command = { accountId: account.id, to: [{ email: "recipient@example.test", name: "" }], cc: [], bcc: [], subject: "Synthetic", bodyText: "Original captured body", recordReply: false, now: 2 };
  const { opId } = await store.compose.queueSend(command);
  const messageId = (JSON.parse((await store.ops.get(opId))!.target_json) as { messageIds: number[] }).messageIds[0]!;
  const mutate = async (patch: Partial<Pick<OpRow, "target_json" | "state">>) => {
    if (adapter === "SQL") {
      if (patch.target_json !== undefined) sqlDb(store).run("UPDATE ops SET target_json=? WHERE id=?", patch.target_json, opId);
      if (patch.state !== undefined) sqlDb(store).run("UPDATE ops SET state=? WHERE id=?", patch.state, opId);
    } else {
      await store.close();
      const raw = await request(factory.open(`terno-${name}`));
      try {
        const tx = raw.transaction(["op_target", "op_control"], "readwrite"), done = terminal(tx);
        if (patch.target_json !== undefined) tx.objectStore("op_target").put({ target_json: patch.target_json }, opId);
        if (patch.state !== undefined) {
          const control = tx.objectStore("op_control"), prior = await request(control.get(opId));
          control.put({ ...prior, state: patch.state }, opId);
        }
        await done;
      } finally { raw.close(); }
      store = await open();
    }
    return store;
  };
  return { store, open, opId, messageId, command, mutate, factory, name };
}
const accepted = (op: OpRow | null) => op && JSON.parse(op.target_json).submissionAccepted;

for (const adapter of ["SQL", "IDB"] as const) describe(`${adapter} proven submission`, () => {
  it.each(["complete", "markUnknown"] as const)("%s atomically merges acceptance with the current pruned target and reopens", async (outcome) => {
    const t = await setup(adapter); let store = t.store;
    const before = (await store.ops.get(t.opId))!;
    store = await t.mutate({ target_json: JSON.stringify({ ...JSON.parse(before.target_json), synthetic: "keep" }) });
    await store.ops.claimReady(2, 1);
    await store.sync.remove([t.messageId]);
    if (outcome === "complete") await store.ops.complete(t.opId, { sendAccepted: { warning: null } }, 3);
    else await store.ops.markUnknown(t.opId, "Synthetic completion failed", 3, { warning: null });
    await store.close(); store = await t.open();
    const after = (await store.ops.get(t.opId))!;
    expect(JSON.parse(after.target_json)).toEqual({ messageIds: [], synthetic: "keep", submissionAccepted: true });
    expect(after.payload_json).toBe(before.payload_json);
    expect(await store.ops.sendSubmission(t.opId)).toEqual({ state: after.state, accepted: true });
    expect(after.target_json.length - JSON.stringify({ messageIds: [], synthetic: "keep" }).length).toBe(26);
    if (outcome === "markUnknown") {
      await expect(store.ops.resolveUnknown(t.opId, "retry", 4)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await store.ops.claimReady(100000, 1)).toEqual([]);
    }
  });

  it.each(["markSent", "discard"] as const)("%s and stale callbacks preserve acceptance proof", async (resolution) => {
    const t = await setup(adapter); let store = t.store;
    await store.ops.claimReady(2, 1);
    await store.ops.markUnknown(t.opId, "Synthetic local error", 3, { warning: null });
    await store.ops.resolveUnknown(t.opId, resolution, 4);
    await store.ops.complete(t.opId, undefined, 5);
    await store.ops.markUnknown(t.opId, "Stale error", 6);
    await store.close(); store = await t.open();
    expect(accepted(await store.ops.get(t.opId))).toBe(true);
  });

  it.each(["forget", "admission"] as const)("transfers a legacy accepted copy's proof before %s retires its header", async (retirement) => {
    const t = await setup(adapter, true); let store = t.store;
    await store.ops.claimReady(2, 1);
    await store.sendCopies.startWire(t.opId, 1); await store.sendCopies.appendWire(t.opId, 0, "YQ=="); await store.sendCopies.sealWire(t.opId);
    await store.sendCopies.accepted(t.opId, null); await store.sendCopies.record(t.opId, "saved");
    while (await store.sendCopies.pruneSavedSlice(t.opId)) { /* bounded explicit cleanup */ }
    const target = JSON.parse((await store.ops.get(t.opId))!.target_json); delete target.submissionAccepted;
    store = await t.mutate({ target_json: JSON.stringify(target), state: "unknown" });
    if (retirement === "forget") while (await store.sendCopies.forgetSlice(t.opId)) { /* bounded explicit cleanup */ }
    else await store.compose.queueSend(t.command);
    expect(await store.sendCopies.get(t.opId)).toBeNull();
    await store.close(); store = await t.open();
    expect(accepted(await store.ops.get(t.opId))).toBe(true);
    await expect(store.ops.resolveUnknown(t.opId, "retry", 4)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("pending copy state does not certify acceptance", async () => {
    const t = await setup(adapter, true);
    expect(await t.store.ops.sendSubmission(t.opId)).toEqual({ state: "queued", accepted: false });
    await t.store.ops.claimReady(2, 1); await t.store.ops.markUnknown(t.opId, "Unproven outcome", 3);
    await t.store.close(); const next = await t.open();
    await next.ops.recover(4);
    expect(await next.ops.claimReady(100000, 1)).toEqual([]);
    await next.ops.resolveUnknown(t.opId, "retry", 5);
    expect((await next.ops.claimReady(6, 1))[0]?.id).toBe(t.opId);
    expect(accepted(await next.ops.get(t.opId))).toBeUndefined();
  });

  it("does not invent proof from warning text or a user markSent", async () => {
    const t = await setup(adapter);
    await t.store.ops.claimReady(2, 1);
    await t.store.ops.markUnknown(t.opId, "The message was accepted", 3);
    expect(accepted(await t.store.ops.get(t.opId))).toBeUndefined();
    await t.store.ops.resolveUnknown(t.opId, "retry", 4);
    expect((await t.store.ops.claimReady(5, 1))[0]?.id).toBe(t.opId);
    await t.store.ops.markUnknown(t.opId, "Unproven outcome", 6);
    await t.store.ops.resolveUnknown(t.opId, "markSent", 7);
    await t.store.close(); const next = await t.open();
    expect(accepted(await next.ops.get(t.opId))).toBeUndefined();
  });
});

it.each(["rollback", "committed rejection"] as const)("SQL acceptance %s is classified by actual transaction durability", async (fault) => {
  const t = await setup("SQL"), db = sqlDb(t.store);
  await t.store.ops.claimReady(2, 1);
  let armed = true, witnessed = false;
  const inject = () => {
    if (!armed) return;
    armed = false; witnessed = accepted(db.get<OpRow>("SELECT * FROM ops WHERE id=?", t.opId) ?? null) === true;
    throw new Error("Synthetic transaction acknowledgement failed");
  };
  if (fault === "rollback") db.onBeforeCommit(inject); else db.onCommit(inject);
  await expect(t.store.ops.markUnknown(t.opId, "Synthetic local completion failed", 3, { warning: null })).rejects.toThrow("acknowledgement");
  expect(witnessed).toBe(true);
  await t.store.close(); const next = await t.open();
  await next.ops.recover(4);
  expect((await next.ops.get(t.opId))?.state).toBe("unknown");
  expect(accepted(await next.ops.get(t.opId))).toBe(fault === "rollback" ? undefined : true);
  if (fault !== "rollback") await expect(next.ops.resolveUnknown(t.opId, "retry", 5)).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it.each([false, true])("IDB acceptance request %s: native abort versus hidden success poisons the adapter", async (hidden) => {
  const t = await setup("IDB");
  await t.store.ops.claimReady(2, 1);
  const put = IDBObjectStore.prototype.put;
  let hits = 0, actual: string | null = null;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const r = Reflect.apply(put, this, args) as IDBRequest;
    if (this.name !== "op_target" || this.transaction.db.name !== `terno-${t.name}` || args[1] !== t.opId) return r;
    hits++;
    this.transaction.addEventListener("complete", () => { actual = "complete"; });
    this.transaction.addEventListener("abort", () => { actual = "abort"; });
    r.addEventListener("success", (event) => { if (hidden) event.stopImmediatePropagation(); else this.transaction.abort(); });
    return r;
  });
  await expect(t.store.ops.markUnknown(t.opId, "Synthetic completion failed", 3, { warning: null })).rejects.toThrow();
  expect(hits).toBe(1); expect(actual).toBe(hidden ? "complete" : "abort");
  spy.mockRestore();
  if (hidden) await expect(t.store.ops.get(t.opId)).rejects.toThrow("closed");
  else expect(accepted(await t.store.ops.get(t.opId))).toBeUndefined();
  await t.store.close();
  if (hidden) await expect(t.open()).rejects.toMatchObject({ name: "UncertainWriteError" });
  else {
    const next = await t.open(); await next.ops.recover(4);
    expect((await next.ops.get(t.opId))?.state).toBe("unknown"); expect(accepted(await next.ops.get(t.opId))).toBeUndefined();
  }
});


it("real SMTP plus IDB completion abort commits acceptance through fallback, reopens and refuses public replay", async () => {
  const received: { raw: Buffer; recipients: string[] }[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["STARTTLS"], authOptional: true, onAuth: (_a, _s, cb) => cb(null, { user: "synthetic" }),
    onRcptTo(a, _s, cb) { cb(a.address === "no@example.test" ? Object.assign(new Error("Synthetic refusal"), { responseCode: 550 }) : undefined); },
    onData(stream, session, cb) {
      const chunks: Buffer[] = []; let size = 0;
      stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) stream.destroy(new Error("Synthetic fixture bound")); else chunks.push(chunk); });
      stream.on("error", cb); stream.on("end", () => { received.push({ raw: Buffer.concat(chunks), recipients: session.envelope.rcptTo.map((r) => r.address) }); cb(); });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => smtp.close(r)));
  const factory = new IDBFactory(), name = crypto.randomUUID(), stores: MailStore[] = [];
  const open = async () => { const s = await IdbMailStore.open({ factory, name, platform, instantSearch: false }); stores.push(s); return s; };
  cleanup.push(async () => { for (const s of stores) if (s.isOpen) await s.close(); });
  const store = await open();
  const { account } = await store.accounts.create({ kind: "imap", email: "sender@example.test", displayName: "Synthetic", color: "indigo", now: Date.now(), secret: { key: "password", blob: await plaintextCipher.encrypt("synthetic") }, providerConfig: {
    imap: { host: "127.0.0.1", port: 1, secure: false, user: "synthetic" }, smtp: { host: "127.0.0.1", port: (smtp.server.address() as { port: number }).port, secure: false, user: "synthetic" }, appendToSent: false,
  } });
  const connect = (s: MailStore) => {
    const backend = new Backend({ store: s, dbPath: ":memory:", version: "test", cipher: plaintextCipher, providers: createRegistry({ imap: { allowInsecure: true } }), platform, autoSync: false, iconTransport: null });
    const [c, server] = createMemoryTransportPair(); backend.connect(server, { clientId: "acceptance-idb", origin: "renderer" }); const client = new RpcClient(c);
    cleanup.push(async () => { client.close(); await backend.stop(); }); return { backend, client };
  };
  const first = connect(store);
  const put = IDBObjectStore.prototype.put;
  let faults = 0, aborted = false;
  const injection = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const r = Reflect.apply(put, this, args) as IDBRequest;
    if (!faults && this.transaction.db.name === `terno-${name}` && this.name === "op_control" && (args[0] as { state?: string }).state === "succeeded") {
      faults++; this.transaction.addEventListener("abort", () => { aborted = true; });
      r.addEventListener("success", () => this.transaction.abort());
    }
    return r;
  });
  const { opId } = await first.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "yes@example.test" }, { name: "", email: "no@example.test" }], bcc: [{ name: "", email: "hidden@example.test" }], subject: "IDB accepted", bodyText: "Exact synthetic bytes" });
  await first.backend.runWorker(); injection.mockRestore();
  expect({ faults, aborted }).toEqual({ faults: 1, aborted: true });
  expect(received).toHaveLength(1); expect(received[0]!.recipients).toEqual(["yes@example.test", "hidden@example.test"]); expect(received[0]!.raw.toString()).not.toMatch(/^Bcc:/mi);
  expect(await store.sendCopies.get(opId)).toBeNull();
  await first.backend.stop();
  const second = connect(await open()); await second.backend.ready;
  const retried = await second.client.call("ops.resolveUnknown", { opId, resolution: "retry" }).then(() => true, () => false);
  await second.backend.runWorker(); expect(received).toHaveLength(1); expect(retried).toBe(false);
  expect(await second.backend.store.ops.sendSubmission(opId)).toEqual({ state: "unknown", accepted: true });
  expect((await second.backend.store.recipientReceipts.get(opId))?.state).toBe("accepted");
  expect(JSON.parse((await second.backend.store.recipientReceipts.readPart(opId, "outcomes", 0))!)).toEqual(["accepted", "rejected", "accepted"]);
  await expect(second.client.call("ops.resolveUnknown", { opId, resolution: "retry" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

for (const adapter of ["SQL", "IDB"] as const) for (const appendToSent of [false, true]) for (const transition of ["complete", "markUnknown"] as const) {
  it(`${adapter} persists independent recipient evidence through ${transition}, append=${appendToSent}`, async () => {
    const t = await setup(adapter, appendToSent); let store = t.store;
    expect((await store.recipientReceipts.list(t.command.accountId)).map((row) => row.opId)).toContain(t.opId);
    await store.ops.claimReady(2, 1);
    if (appendToSent) { await store.sendCopies.startWire(t.opId, 1); await store.sendCopies.appendWire(t.opId, 0, "YQ=="); await store.sendCopies.sealWire(t.opId); }
    const evidence = { warning: null, outcomes: [{ email: "recipient@example.test", outcome: "accepted" as const }] };
    if (transition === "complete") await store.ops.complete(t.opId, { sendAccepted: evidence }, 3);
    else await store.ops.markUnknown(t.opId, "Synthetic local error", 3, evidence);
    await store.close(); store = await t.open();
    expect((await store.recipientReceipts.get(t.opId))?.state).toBe("accepted");
    expect(JSON.parse((await store.recipientReceipts.readPart(t.opId, "envelope", 0))!)).toEqual([{ role: "to", email: "recipient@example.test", name: "" }]);
    expect(JSON.parse((await store.recipientReceipts.readPart(t.opId, "outcomes", 0))!)).toEqual(["accepted"]);
    while (await store.recipientReceipts.retireSlice(t.opId)) { /* bounded */ }
    expect(await store.recipientReceipts.get(t.opId)).toBeNull();
    await store.close(); store = await t.open();
    expect(await store.ops.sendSubmission(t.opId)).toMatchObject({ accepted: true });
  });
}

it.each(["rollback", "committed rejection"] as const)("SQL recipient publication survives %s according to native commit", async (fault) => {
  const t = await setup("SQL"), db = sqlDb(t.store);
  await t.store.ops.claimReady(2, 1);
  let armed = true;
  const inject = () => { if (armed) { armed = false; throw new Error("Synthetic acknowledgement failure"); } };
  if (fault === "rollback") db.onBeforeCommit(inject); else db.onCommit(inject);
  await expect(t.store.ops.markUnknown(t.opId, "local failure", 3, { warning: null, outcomes: [{ email: "recipient@example.test", outcome: "accepted" }] })).rejects.toThrow("acknowledgement");
  await t.store.close(); const next = await t.open();
  expect((await next.recipientReceipts.get(t.opId))?.state).toBe(fault === "rollback" ? "pending" : "accepted");
  expect((await next.ops.sendSubmission(t.opId))?.accepted).toBe(fault !== "rollback");
  expect(await next.recipientReceipts.readPart(t.opId, "outcomes", 0)).toBe(fault === "rollback" ? null : '["accepted"]');
});

it("IDB recipient publication abort rolls back both receipt and acceptance marker", async () => {
  const t = await setup("IDB"); await t.store.ops.claimReady(2, 1);
  const put = IDBObjectStore.prototype.put; let hits = 0, actual: string | null = null;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const result = Reflect.apply(put, this, args) as IDBRequest;
    if (this.name === "recipient_receipts" && this.transaction.db.name === `terno-${t.name}` && args[1] === t.opId) {
      hits++; this.transaction.addEventListener("abort", () => { actual = "abort"; }); result.addEventListener("success", () => this.transaction.abort());
    }
    return result;
  });
  await expect(t.store.ops.markUnknown(t.opId, "local failure", 3, { warning: null, outcomes: [{ email: "recipient@example.test", outcome: "accepted" }] })).rejects.toThrow();
  expect(hits).toBe(1); expect(actual).toBe("abort"); spy.mockRestore();
  await t.store.close(); const next = await t.open();
  expect((await next.recipientReceipts.get(t.opId))?.state).toBe("pending");
  expect((await next.ops.sendSubmission(t.opId))?.accepted).toBe(false);
  expect(await next.recipientReceipts.readPart(t.opId, "outcomes", 0)).toBeNull();
});

for (const adapter of ["SQL", "IDB"] as const) it(`${adapter} refuses the 129th independent receipt without consuming a draft`, async () => {
  const t = await setup(adapter); const store = t.store;
  for (let i = 1; i < 128; i++) await store.compose.queueSend({ ...t.command, now: 2 + i });
  expect(await store.recipientReceipts.list(t.command.accountId)).toHaveLength(128);
  const draft = (await store.drafts.save({ accountId: t.command.accountId, to: t.command.to, cc: [], bcc: [], subject: t.command.subject, bodyText: t.command.bodyText }, 200))!;
  await expect(store.compose.queueSend({ ...t.command, now: 201, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await store.drafts.list()).find((row) => row.id === draft.id)).toEqual(draft);
  expect(await store.recipientReceipts.list(t.command.accountId)).toHaveLength(128);
});

it("IDB hidden recipient publication acknowledgement poisons rather than inventing rollback", async () => {
  const t = await setup("IDB"); await t.store.ops.claimReady(2, 1);
  const put = IDBObjectStore.prototype.put; let hits = 0, actual: string | null = null;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const result = Reflect.apply(put, this, args) as IDBRequest;
    if (this.name === "recipient_receipts" && this.transaction.db.name === `terno-${t.name}` && args[1] === t.opId) {
      hits++; this.transaction.addEventListener("complete", () => { actual = "complete"; }); result.addEventListener("success", (event) => event.stopImmediatePropagation());
    }
    return result;
  });
  await expect(t.store.ops.markUnknown(t.opId, "local failure", 3, { warning: null, outcomes: [{ email: "recipient@example.test", outcome: "accepted" }] })).rejects.toThrow();
  expect(hits).toBe(1); expect(actual).toBe("complete"); spy.mockRestore();
  await expect(t.store.recipientReceipts.get(t.opId)).rejects.toThrow("closed");
  await t.store.close(); await expect(t.open()).rejects.toMatchObject({ name: "UncertainWriteError" });
});

for (const adapter of ["SQL", "IDB"] as const) it(`${adapter} enforces the aggregate recipient metadata budget before draft removal`, async () => {
  const t = await setup(adapter); const store = t.store;
  const to = Array.from({ length: 1000 }, (_, i) => ({ name: "ñ".repeat(250), email: `r${i}@example.test` }));
  const large = { ...t.command, to, cc: to, bcc: to };
  let admitted = 0;
  while (admitted < 4) {
    try { await store.compose.queueSend({ ...large, now: 10 + admitted }); admitted++; }
    catch { break; }
  }
  expect(admitted).toBeGreaterThan(0); expect(admitted).toBeLessThan(4);
  const rows = await store.recipientReceipts.list(t.command.accountId);
  expect(rows.reduce((sum, row) => sum + row.charge, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
  const draft = (await store.drafts.save({ accountId: t.command.accountId, to, cc: to, bcc: to, subject: large.subject, bodyText: large.bodyText }, 100))!;
  await expect(store.compose.queueSend({ ...large, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, now: 101 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await store.drafts.list()).find((row) => row.id === draft.id)).toEqual(draft);
});

for (const adapter of ["SQL", "IDB"] as const) it(`${adapter} keeps a claimed recovery wire pinned until its child is terminal`, async () => {
  const t = await setup(adapter, true); let store = t.store;
  await store.sendCopies.startWire(t.opId, 1); await store.sendCopies.appendWire(t.opId, 0, "YQ=="); await store.sendCopies.sealWire(t.opId);
  await store.sendCopies.accepted(t.opId, null); await store.sendCopies.record(t.opId, "saved");
  const child = await store.compose.queueSend({ ...t.command, now: 3 });
  const set = async (terminalChild: boolean) => {
    if (adapter === "SQL") {
      const db = sqlDb(store);
      db.run("UPDATE recipient_receipts SET childOpId=? WHERE opId=?", child.opId, t.opId);
      if (terminalChild) db.run("UPDATE ops SET state='succeeded' WHERE id=?", child.opId);
    } else {
      await store.close(); const raw = await request(t.factory.open(`terno-${t.name}`));
      const tx = raw.transaction(["recipient_receipts", "op_control", "ops"], "readwrite"), done = terminal(tx);
      const headers = tx.objectStore("recipient_receipts"), header = await request(headers.get(t.opId));
      headers.put({ ...header, childOpId: child.opId }, t.opId);
      if (terminalChild) { const controls = tx.objectStore("op_control"), prior = await request(controls.get(child.opId)); const base = await request(tx.objectStore("ops").get(child.opId)); controls.put({ state: "succeeded", attempts: prior?.attempts ?? base.attempts, next_attempt_at: prior?.next_attempt_at ?? base.next_attempt_at, updated_at: 4 }, child.opId); }
      await done; raw.close(); store = await t.open();
    }
  };
  await set(false);
  await expect(store.sendCopies.pruneSavedSlice(t.opId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(store.sendCopies.forgetSlice(t.opId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(store.recipientReceipts.retireSlice(t.opId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await store.sendCopies.get(t.opId))?.ready).toBe(true);
  await set(true);
  expect(await store.sendCopies.pruneSavedSlice(t.opId)).toBe(false);
});

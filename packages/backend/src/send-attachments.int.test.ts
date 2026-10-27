import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import type { SendPayload, SyncSink } from "@terno/mail/portable";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function open(dir: string) {
  const submitted: SendPayload[] = [];
  let sink: SyncSink | undefined;
  const backend = new Backend({
    dbPath: join(dir, "mail.db"), version: "test", cipher: plaintextCipher, autoSync: false,
    providers: {
      create: () => ({
        async verify() {}, async close() {},
        async sync(value) { sink = value; },
        async execute(op) { submitted.push(op.payload as SendPayload); return { providerMsgId: `sent-${op.id}` }; },
      }),
      async verifyImap() {}, async connectGmail() { throw new Error("unused"); },
    },
  });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; client.close(); await backend.stop(); } };
  cleanups.push(stop);
  return { backend, client, submitted, stop, sink: () => sink! };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-dispatch-assets-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const t = open(dir);
  const accountId = createAccount(sqlDb(t.backend.store), { kind: "gmail", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
  return { ...t, dir, accountId };
}

async function queue(t: ReturnType<typeof setup>) {
  const ref = await t.client.call("attachments.create", { accountId: t.accountId, filename: "exact.bin", mime: "application/octet-stream", size: 5 });
  await t.client.call("attachments.append", { accountId: t.accountId, assetId: ref.assetId, index: 0, dataBase64: "AP+ADQo=" });
  await t.client.call("attachments.seal", { accountId: t.accountId, assetId: ref.assetId });
  const draft = (await t.client.call("drafts.save", { accountId: t.accountId, to: [{ name: "", email: "recipient@example.com" }], subject: "Exact bytes", bodyText: "snapshot", attachments: [ref] }))!;
  const send = await t.client.call("compose.send", { accountId: t.accountId, to: draft.to, subject: draft.subject, bodyText: "snapshot", draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, attachments: [ref] });
  return { ref, send };
}

it.each([false, true])("dispatch hydrates exact bytes while queued asset refs stay immutable (restart=%s)", async (restart) => {
  const t = setup();
  const { ref, send } = await queue(t);
  const before = (await t.backend.store.ops.get(send.opId))!.payload_json;
  expect(JSON.parse(before).attachments).toEqual([ref]);
  let active = t;
  if (restart) {
    await t.stop();
    active = { ...t, ...open(t.dir) };
  }
  await active.backend.runWorker();
  expect(active.submitted).toHaveLength(1);
  expect(active.submitted[0]).toMatchObject({ text: "snapshot", attachments: [{ ...ref, dataBase64: "AP+ADQo=" }] });
  expect((await active.backend.store.ops.get(send.opId))?.payload_json).toBe(before);
  expect((await active.client.call("ops.list", {})).find((o) => o.id === send.opId)?.state).toBe("succeeded");
  await active.backend.runWorker();
  expect(active.submitted).toHaveLength(1);
});

it("lost local bytes after queueing fail before submission and preserve the captured refs", async () => {
  const t = setup();
  const { ref, send } = await queue(t);
  const read = vi.spyOn(t.backend.store.attachments, "read").mockResolvedValueOnce(null);
  await t.backend.runWorker();
  read.mockRestore();
  expect(t.submitted).toEqual([]);
  expect((await t.client.call("ops.list", {})).find((o) => o.id === send.opId)).toMatchObject({ state: "failed" });
  expect(JSON.parse((await t.backend.store.ops.get(send.opId))!.payload_json).attachments).toEqual([ref]);
  await t.backend.runWorker();
  expect(t.submitted).toEqual([]);
});

it("quiesce owns an attachment send during local hydration and leaves it queued before submission", async () => {
  const t = setup();
  const { send } = await queue(t);
  const before = (await t.backend.store.ops.get(send.opId))!.payload_json;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = t.backend.store.attachments.read.bind(t.backend.store.attachments);
  const read = vi.spyOn(t.backend.store.attachments, "read").mockImplementationOnce(async (...args) => {
    entered(); await gate; return original(...args);
  });
  const running = t.backend.runWorker();
  await blocked;
  try {
    expect(await t.backend.quiesce(0)).toBe("sending");
    expect((await t.backend.store.ops.get(send.opId))?.state).toBe("running");
    expect(t.submitted).toEqual([]);
  } finally {
    release();
  }
  await running;
  read.mockRestore();
  expect((await t.backend.store.ops.get(send.opId))?.state).toBe("queued");
  expect(t.submitted).toEqual([]);
  t.backend.resume();
  await t.backend.runWorker();
  expect(t.submitted).toHaveLength(1);
  expect((await t.backend.store.ops.get(send.opId))?.payload_json).toBe(before);
});

it("removal while hydration is waiting cannot submit captured bytes through a stale provider", async () => {
  const t = setup();
  await queue(t);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = t.backend.store.attachments.read.bind(t.backend.store.attachments);
  const read = vi.spyOn(t.backend.store.attachments, "read").mockImplementationOnce(async (...args) => {
    const data = await original(...args);
    entered(); await gate; return data;
  });
  const running = t.backend.runWorker();
  await blocked;
  try {
    await t.client.call("accounts.remove", { id: t.accountId });
  } finally {
    release();
  }
  await running;
  read.mockRestore();
  expect(t.submitted).toEqual([]);
  expect((await t.client.call("app.bootstrap", {})).accounts).toEqual([]);
});

it.each(["before commit", "after commit", "outcome recording"] as const)("accepted attachment bytes are submitted once when completion fails %s", async (failure) => {
  const t = setup();
  const { ref, send } = await queue(t);
  const before = (await t.backend.store.ops.get(send.opId))!.payload_json;
  const complete = t.backend.store.ops.complete.bind(t.backend.store.ops);
  vi.spyOn(t.backend.store.ops, "complete").mockImplementationOnce(async (...args) => {
    if (failure === "after commit") await complete(...args);
    throw new Error("synthetic completion failure");
  });
  if (failure === "outcome recording") vi.spyOn(t.backend.store.ops, "markUnknown").mockRejectedValueOnce(new Error("synthetic outcome write failure"));
  await t.backend.runWorker();
  expect(t.submitted).toHaveLength(1);
  expect(t.submitted[0]?.attachments).toEqual([{ ...ref, dataBase64: "AP+ADQo=" }]);
  expect((await t.backend.store.ops.get(send.opId))?.state).toBe(failure === "after commit" ? "succeeded" : "unknown");
  expect((await t.backend.store.ops.get(send.opId))?.payload_json).toBe(before);
  await t.stop();
  const restarted = open(t.dir);
  await restarted.backend.runWorker();
  expect(restarted.submitted).toEqual([]);
  expect((await restarted.backend.store.ops.get(send.opId))?.payload_json).toBe(before);
});

it("local staging failures expose fixed recovery copy without synthetic sensitive error details", async () => {
  const t = setup();
  const { send } = await queue(t);
  const read = vi.spyOn(t.backend.store.attachments, "read").mockRejectedValueOnce(new Error("SYNTHETIC-SECRET recipient@example.com Private subject"));
  await t.backend.runWorker();
  read.mockRestore();
  const op = (await t.client.call("ops.list", {})).find((o) => o.id === send.opId)!;
  expect(op).toMatchObject({ state: "failed", lastErrorI18n: { key: "attachments.unavailable" } });
  expect(JSON.stringify(op)).not.toContain("SYNTHETIC-SECRET");
  expect(JSON.stringify(op)).not.toContain("Private subject");
  expect(t.submitted).toEqual([]);
});

it.each([{ payload: null }, { payload: [] }, { payload: { subject: 4 } }])("malformed persisted preparation data %j fails definitively and remains readable in the outbox", async ({ payload }) => {
  const t = setup();
  const { send } = await queue(t);
  // Simulate local snapshot corruption after a valid, attachment-pinned enqueue.
  sqlDb(t.backend.store).run("UPDATE ops SET payload_json = ? WHERE id = ?", JSON.stringify(payload), send.opId);
  await t.backend.runWorker();
  expect(t.submitted).toEqual([]);
  expect((await t.client.call("ops.list", {})).find((o) => o.id === send.opId)).toMatchObject({ state: "failed", lastErrorI18n: { key: "attachments.unavailable" } });
  await t.backend.runWorker();
  expect(t.submitted).toEqual([]);
});

it("provider body hydration preserves attachment bytes through the public reader and chunk RPC", async () => {
  const t = setup();
  await t.backend.ingestSliced([{
    accountId: t.accountId, providerMsgId: "partial", providerThreadId: "thread", rfcMessageId: "partial@example.com",
    inReplyTo: null, references: [], from: { name: "Sender", email: "sender@example.com" }, to: [], cc: [], bcc: [],
    subject: "Download", date: Date.now(), snippet: "", bodyText: null, bodyHtml: null, bodyState: "partial", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: true, size: 5,
  }]);
  const thread = (await t.client.call("threads.list", { view: "inbox" })).items[0]!;
  const original = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  await t.backend.syncAccount(t.accountId);
  await t.sink().setBody(original.id, "downloaded body", "<p>downloaded body</p>", [{ filename: "exact.bin", mime: "application/octet-stream", size: 5, bytes: new Uint8Array([0, 255, 128, 13, 10]) }]);
  const hydrated = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(hydrated.bodyText).toBe("downloaded body");
  expect(hydrated.attachments).toHaveLength(1);
  expect(hydrated.attachments[0]).toMatchObject({ filename: "exact.bin", size: 5, assetId: expect.any(String) });
  expect(await t.client.call("attachments.read", { accountId: t.accountId, assetId: hydrated.attachments[0]!.assetId!, index: 0 })).toEqual({ dataBase64: "AP+ADQo=" });
  await t.sink().setBody(original.id, null, null, undefined, { captureUnavailable: "size" });
  const unavailable = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(unavailable).toMatchObject({ bodyText: "downloaded body", bodyHtml: "<p>downloaded body</p>", bodyState: "full" });
  expect(unavailable.bodyUnavailable).toBeUndefined();
  expect(unavailable.attachments).toEqual(hydrated.attachments);
  expect(await t.client.call("attachments.read", { accountId: t.accountId, assetId: unavailable.attachments[0]!.assetId!, index: 0 })).toEqual({ dataBase64: "AP+ADQo=" });
  await t.sink().setBody(original.id, "downloaded again", null);
  const preserved = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(preserved.attachments).toEqual(hydrated.attachments);
  const stage = vi.spyOn(t.backend.store.attachments, "create").mockRejectedValueOnce(new Error("synthetic staging failure"));
  await expect(t.sink().setBody(original.id, "must not replace", null, [{ filename: "other.bin", mime: "application/octet-stream", size: 1, bytes: new Uint8Array([1]) }])).rejects.toThrow();
  stage.mockRestore();
  const unchanged = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(unchanged.bodyText).toBe("downloaded again");
  expect(unchanged.attachments).toEqual(hydrated.attachments);
  await t.sink().setBody(original.id, "attachment removed", null, []);
  expect((await t.client.call("threads.get", { threadId: thread.id })).messages[0]!.attachments).toEqual([]);
});

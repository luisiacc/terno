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
  const send = await t.client.call("compose.send", { accountId: t.accountId, to: draft.to, subject: draft.subject, bodyText: "snapshot", draftId: draft.id, draftRevision: draft.revision, attachments: [ref] });
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
  await t.sink().setBody(original.id, "downloaded body", null, [{ filename: "exact.bin", mime: "application/octet-stream", size: 5, bytes: new Uint8Array([0, 255, 128, 13, 10]) }]);
  const hydrated = (await t.client.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(hydrated.bodyText).toBe("downloaded body");
  expect(hydrated.attachments).toHaveLength(1);
  expect(hydrated.attachments[0]).toMatchObject({ filename: "exact.bin", size: 5, assetId: expect.any(String) });
  expect(await t.client.call("attachments.read", { accountId: t.accountId, assetId: hydrated.attachments[0]!.assetId!, index: 0 })).toEqual({ dataBase64: "AP+ADQo=" });
});

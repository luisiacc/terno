import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import imapkit from "imapkit";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { bounded, rawIdleMail } from "./test/imap-idle-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function setup(initialFlags: string[] = ["OtherClient"]) {
  const server = imapkit({
    plugins: ["MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
    storage: { INBOX: { allowPermanentFlags: false, permanentFlags: ["\\Seen", "\\Flagged", "\\Deleted", "OtherClient"] }, "": { separator: "/", folders: {
      Trash: { "special-use": "\\Trash" }, Projects: {},
    } } },
  });
  const commands: string[] = [];
  const responses: string[] = [];
  server.script.add([
    { on: "command", run: true, when(ctx) { commands.push(ctx.command!); return false; } },
    { on: "response", drop: true, when(ctx) { if (/PERMANENTFLAGS/i.test(ctx.data)) responses.push(ctx.data); return false; } },
  ]);
  const port = await server.start(0, "127.0.0.1");
  cleanups.push(async () => { await server.stop(); });
  const dir = mkdtempSync(join(tmpdir(), "terno-a27-"));
  const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher,
    providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "a27", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => { client.close(); await bounded(backend.stop(), "backend stop"); rmSync(dir, { recursive: true, force: true }); });
  const bytes = rawIdleMail("A27 boundary", "Exact remote bytes");
  const original = server.control.addMessage("INBOX", { raw: bytes, flags: initialFlags });
  server.control.addMessage("Projects", { raw: rawIdleMail("Other project"), flags: ["Unrelated"] });
  const account = await client.call("accounts.addImap", {
    email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "127.0.0.1", port, secure: false, user: "testuser" },
    smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" },
    password: "testpass", verify: false,
  });
  await backend.syncAccount(account.id);
  const thread = (await client.call("threads.list", { view: "inbox", accountId: account.id })).items[0]!;
  const message = (await client.call("threads.get", { threadId: thread.id })).messages[0]!;
  const snapshot = () => server.control.listMailboxes().map((box) => ({ path: box.path, uidvalidity: box.uidvalidity,
    messages: server.control.listMessages(box.path, { raw: true }).map((m) => ({ uid: m.uid, raw: m.raw, flags: [...m.flags].sort() })) }));
  return { server, commands, responses, backend, client, account, thread, message, original, bytes, snapshot };
}

describe("W06 A27: IMAP categories and keyword boundaries", () => {
  it("keeps local category operations off the wire with restricted permanent keywords", async () => {
    const t = await setup(["OtherClient", "\\Seen", "\\Flagged"]);
    expect(t.server.getMailbox("INBOX")!.allowPermanentFlags).toBe(false);
    const permanent = t.responses.find((r) => /PERMANENTFLAGS/i.test(r));
    expect(permanent).toContain("OtherClient");
    expect(permanent).not.toContain("\\*");
    const before = t.snapshot();
    const start = t.commands.length;
    const membership = async () => {
      const detail = await t.client.call("threads.get", { threadId: t.thread.id });
      expect(detail.messages[0]).toMatchObject({ isRead: true, isStarred: true });
      return detail.thread.categoryIds.sort((a, b) => a - b);
    };
    expect(await membership()).toEqual([]);
    const projects = await t.client.call("categories.create", { name: "Projects", color: "rose" });
    const other = await t.client.call("categories.create", { name: "OtherClient", color: "cyan" });
    const third = await t.client.call("categories.create", { name: "Third", color: "slate" });
    await t.client.call("categories.update", { id: projects.id, name: "Renamed" });
    await t.client.call("categories.addThreads", { categoryId: projects.id, threadIds: [t.thread.id] });
    await t.client.call("categories.addThreads", { categoryId: other.id, threadIds: [t.thread.id] });
    expect(await membership()).toEqual([projects.id, other.id].sort((a, b) => a - b));
    await t.backend.runWorker();
    await t.backend.syncAccount(t.account.id);
    expect(await membership()).toEqual([projects.id, other.id].sort((a, b) => a - b));
    expect(t.snapshot()).toEqual(before);
    const moved = await t.client.call("categories.moveThreads", { to: third.id, threadIds: [t.thread.id] });
    expect(await membership()).toEqual([third.id]);
    await t.client.call("categorize.undo", { batchId: moved.batchId });
    expect(await membership()).toEqual([projects.id, other.id].sort((a, b) => a - b));
    await t.client.call("categories.removeThreads", { categoryId: projects.id, threadIds: [t.thread.id] });
    expect(await membership()).toEqual([other.id]);
    const added = await t.client.call("categories.addThreads", { categoryId: third.id, threadIds: [t.thread.id] });
    await t.client.call("categorize.undo", { batchId: added.batchId! });
    expect(await membership()).toEqual([other.id]);
    await t.client.call("categories.update", { id: projects.id, name: "Projects" });
    await t.client.call("categories.addThreads", { categoryId: projects.id, threadIds: [t.thread.id] });
    await t.client.call("categories.delete", { id: projects.id });
    expect(await membership()).toEqual([other.id]);
    await t.client.call("categories.delete", { id: other.id });
    expect(await membership()).toEqual([]);
    expect(await t.client.call("ops.list", {})).toEqual([]);
    await t.backend.runWorker();
    await t.backend.syncAccount(t.account.id);
    expect(await membership()).toEqual([]);
    expect(t.snapshot()).toEqual(before);
    expect(t.commands.slice(start).filter((c) => /^(CREATE|RENAME|DELETE|UID STORE|UID MOVE|UID COPY|EXPUNGE|UID EXPUNGE|APPEND)$/.test(c))).toEqual([]);
    expect(await t.backend.store.providerStore(t.account.id).locations!.of([t.message.id])).toEqual([
      expect.objectContaining({ mailbox: "INBOX", uidvalidity: t.original.uidvalidity, uid: t.original.uid }),
    ]);
  });

  it("preserves another client's keyword through Seen, Flagged and a real Trash move", async () => {
    const t = await setup();
    const start = t.commands.length;
    const steps = [
      ["markRead", ["OtherClient", "\\Seen"]],
      ["star", ["OtherClient", "\\Seen", "\\Flagged"]],
      ["markUnread", ["OtherClient", "\\Flagged"]],
      ["unstar", ["OtherClient"]],
      ["markRead", ["OtherClient", "\\Seen"]],
      ["star", ["OtherClient", "\\Seen", "\\Flagged"]],
    ] as const;
    for (const [action, flags] of steps) {
      await t.client.call("threads.act", { threadIds: [t.thread.id], action });
      await t.backend.runWorker();
      const ops = (await t.client.call("ops.list", {})).filter((op) => op.kind === action);
      expect(ops.length).toBeGreaterThan(0);
      expect(ops.every((op) => op.state === "succeeded")).toBe(true);
      expect(t.server.control.getMessage("INBOX", t.original.uid).flags.sort()).toEqual([...flags].sort());
    }
    await t.client.call("threads.act", { threadIds: [t.thread.id], action: "trash" });
    await t.backend.runWorker();
    expect((await t.client.call("ops.list", {})).find((op) => op.kind === "trash")?.state).toBe("succeeded");
    expect(t.commands.slice(start).filter((c) => /^(UID STORE|UID MOVE|UID COPY|EXPUNGE|UID EXPUNGE)$/.test(c))).toEqual(["UID STORE", "UID STORE", "UID STORE", "UID STORE", "UID STORE", "UID STORE", "UID MOVE"]);
    expect(t.server.control.listMessages("INBOX")).toEqual([]);
    const moved = t.server.control.listMessages("Trash", { raw: true });
    expect(moved).toHaveLength(1);
    expect(moved[0]!.raw).toEqual(Buffer.from(t.bytes));
    expect(moved[0]!.flags.sort()).toEqual(["OtherClient", "\\Flagged", "\\Seen"].sort());
    expect(await t.backend.store.providerStore(t.account.id).locations!.of([t.message.id])).toEqual([
      expect.objectContaining({ mailbox: "Trash", uidvalidity: t.server.control.getMailbox("Trash").uidvalidity, uid: moved[0]!.uid }),
    ]);
  });
});

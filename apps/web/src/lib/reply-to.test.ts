import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Backend, plaintextCipher } from "@terno/backend";
import { createMemoryTransportPair, RpcClient, type DraftMode } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { demoRegistry } from "@terno/mail";
import type { IncomingMessage, MailStore } from "@terno/store";
import { afterEach, expect, it, vi } from "vitest";
import { replyFields } from "./compose-fields";

vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.reject(new Error("not connected")) } }));
const { fromServer, recipients, validRecipients } = await import("./drafts");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const NOW = Date.UTC(2026, 9, 26, 12);

async function mailbox(engine: "sql" | "idb") {
  const dir = mkdtempSync(join(tmpdir(), "terno-reply-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const name = crypto.randomUUID();
  const open = async (): Promise<MailStore> => engine === "sql" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : IdbMailStore.open({ name, factory: indexedDB, platform: nodePlatform, instantSearch: false });
  const attach = (store: MailStore) => {
    const backend = new Backend({ store, version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, iconTransport: null });
    const [clientPort, serverPort] = createMemoryTransportPair();
    backend.connect(serverPort, { clientId: "reply-test", origin: "renderer" });
    cleanups.push(async () => { if (store.isOpen) await backend.stop(); });
    return { backend, client: new RpcClient(clientPort) };
  };
  return { ...attach(await open()), reopen: async () => attach(await open()) };
}

const original = (accountId: number): IncomingMessage => ({
  accountId, providerMsgId: "helpdesk", providerThreadId: null, rfcMessageId: "helpdesk@help.test", inReplyTo: null, references: [],
  from: { name: "Helpdesk", email: "noreply@help.test" }, replyTo: [{ name: "Support, Session", email: "session@help.test" }, { name: "List", email: "list@help.test" }],
  to: [{ name: "Me", email: "me@example.test" }, { name: "Other", email: "other@help.test" }], cc: [{ name: "Session", email: "SESSION@HELP.TEST" }], bcc: [{ name: "Original private", email: "original-secret@help.test" }],
  subject: "Helpdesk", date: NOW, snippet: "Hello", bodyText: "Hello", bodyHtml: null, bodyState: "full", listId: null,
  isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
});

for (const engine of ["sql", "idb"] as const) {
  it.each(["reply", "replyAll"] as const)(`${engine}: %s keeps selected Reply-To through draft reopen, backup restore and exact queued recipients`, async (mode: Exclude<DraftMode, "new" | "forward">) => {
    const source = await mailbox(engine);
    const { account } = await source.backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Me", color: "indigo", now: NOW });
    const { touched } = await source.backend.store.sync.ingest([original(account.id)], { applyFilters: false, classifier: null, now: NOW });
    const detail = (await source.backend.store.threads.get(touched[0]!))!;
    const fields = replyFields(mode, detail, account);
    expect(fields.bccText).toBe("");
    const to = recipients(`${fields.toText}, Manual <manual@help.test>`, fields.auto.to);
    const cc = recipients(fields.ccText, fields.auto.cc);
    const bcc = [{ name: "Explicit private", email: "explicit-private@help.test" }];
    await source.client.call("drafts.save", { accountId: account.id, threadId: detail.thread.id, mode, to, cc, bcc, subject: fields.subject, bodyText: "Thanks", inReplyToMessageId: fields.inReplyToMessageId! });
    await source.backend.stop();
    const reopened = await source.reopen();
    const [saved] = await reopened.client.call("drafts.list", {});
    expect(saved).toMatchObject({ to, cc, bcc });
    expect(fromServer(saved!).auto).toEqual({ to: ["session@help.test", "list@help.test"], cc: mode === "replyAll" ? ["other@help.test"] : [], bcc: [] });
    const dump = await reopened.client.call("app.export", {});
    expect(dump.version).toBe(2);
    expect(dump.drafts[0]).toMatchObject({ to, cc, bcc, inReplyTo: "helpdesk@help.test" });
    const target = await mailbox(engine);
    const { account: targetAccount } = await target.backend.store.accounts.create({ kind: "gmail", email: account.email, displayName: "Me", color: "indigo", now: NOW });
    await target.backend.store.sync.ingest([original(targetAccount.id)], { applyFilters: false, classifier: null, now: NOW });
    await target.client.call("app.import", { data: dump });
    const [restored] = await target.client.call("drafts.list", {});
    expect(restored).toMatchObject({ mode, to, cc, bcc });
    const local = fromServer(restored!);
    const { opId } = await target.client.call("compose.send", { accountId: targetAccount.id, to: validRecipients(local.toText), cc: validRecipients(local.ccText), bcc: validRecipients(local.bccText), subject: local.subject, bodyText: local.bodyText, inReplyToMessageId: local.inReplyToMessageId!, draftId: restored!.id });
    const payload = JSON.parse((await target.backend.store.ops.get(opId))!.payload_json);
    expect(payload.to).toEqual([{ name: "Support, Session", email: "session@help.test" }, { name: "List", email: "list@help.test" }, { name: "Manual", email: "manual@help.test" }]);
    expect(payload.cc).toEqual(mode === "replyAll" ? [{ name: "Other", email: "other@help.test" }] : []);
    expect(payload.bcc).toEqual(bcc);
    expect(JSON.stringify(payload)).not.toContain("original-secret");
  });
}

import "fake-indexeddb/auto";
import { ATTACHMENT_CHUNK, bytesBase64, encodeText } from "@terno/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { L } from "@terno/i18n";
import type { MailStore } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";

const stores: MailStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) if (s.isOpen) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

for (const adapter of ["SQL", "IDB"] as const) describe(`${adapter} durable Sent copies`, () => {
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "terno-sent-copy-")); dirs.push(dir);
    const name = `sent-copy-${crypto.randomUUID()}`;
    const open = async () => {
      const s = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "s.db"))) : await IdbMailStore.open({ name, factory: indexedDB, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) }, instantSearch: false });
      stores.push(s); return s;
    };
    const store = await open();
    const { account } = await store.accounts.create({ kind: "imap", email: "sender@example.test", displayName: "Sender", color: "indigo", providerConfig: { appendToSent: true }, now: 1 });
    const command = { accountId: account.id, to: [{ email: "recipient@example.test", name: "" }], cc: [], bcc: [], subject: "Once", bodyText: "Synthetic", recordReply: false, now: 2 };
    return { store, open, account, command };
  }

  it("reserves Sent-copy recovery before dispatch instead of silently losing APPEND evidence", async () => {
    const { store, command } = await setup();
    const { opId } = await store.compose.queueSend(command);
    expect(store.sendCopies, "durable Sent-copy store is missing").toBeDefined();
    expect(await store.sendCopies.get(opId)).toMatchObject({ submission: "pending", copy: "pending", ready: false });
  });
  async function wire(store: MailStore, id: string, chunks = 1) {
    await store.sendCopies.startWire(id, chunks * ATTACHMENT_CHUNK);
    for (let i = 0; i < chunks; i++) await store.sendCopies.appendWire(id, i, bytesBase64(new Uint8Array(ATTACHMENT_CHUNK).fill(i + 1)));
    await store.sendCopies.sealWire(id);
  }

  it("keeps accepted submission, exact bytes and uncertain copy after reopen; retry cannot resubmit", async () => {
    const { store, open, command } = await setup();
    const { opId } = await store.compose.queueSend(command);
    await store.ops.claimReady(2, 10);
    await wire(store, opId);
    const data = await store.sendCopies.readWire(opId, 0);
    await store.sendCopies.accepted(opId, null);
    await store.sendCopies.record(opId, "unknown", { mailbox: "Sent" });
    await store.ops.markUnknown(opId, "Synthetic local completion failure", 3);
    await store.close(); const next = await open();
    expect(await next.sendCopies.get(opId)).toMatchObject({ submission: "accepted", copy: "unknown", mailbox: "Sent" });
    expect(await next.sendCopies.readWire(opId, 0)).toBe(data);
    await expect(next.ops.resolveUnknown(opId, "retry", 4)).rejects.toThrow();
    expect(await next.ops.claimReady(1000000, 10)).toEqual([]);
    expect((await next.ops.get(opId))?.state).toBe("unknown");
  });

  it("keeps a sealed wire immutable and resumes interrupted staging without old chunks", async () => {
    const { store, command } = await setup(); const { opId } = await store.compose.queueSend(command);
    await store.sendCopies.startWire(opId, ATTACHMENT_CHUNK * 2);
    await store.sendCopies.appendWire(opId, 0, bytesBase64(new Uint8Array(ATTACHMENT_CHUNK).fill(7)));
    while (await store.sendCopies.resetWireSlice(opId)) { /* bounded explicit staging */ }
    await wire(store, opId);
    await expect(store.sendCopies.startWire(opId, 1)).rejects.toThrow();
    await expect(store.sendCopies.appendWire(opId, 0, "YQ==")).rejects.toThrow();
    expect(await store.sendCopies.readWire(opId, 0)).toBe(bytesBase64(new Uint8Array(ATTACHMENT_CHUNK).fill(1)));
  });

  it("refuses recovery quota before consuming a draft and charges later attachment uploads", async () => {
    const { store, command } = await setup();
    const draft = (await store.drafts.save({ accountId: command.accountId, to: command.to, cc: [], subject: "Keep", bodyText: "Original" }, 1))!;
    for (let i = 0; i < 10; i++) await store.compose.queueSend(command);
    await expect(store.compose.queueSend({ ...command, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision })).rejects.toThrow();
    expect(await store.drafts.list()).toHaveLength(1);
    expect((await store.drafts.list())[0]).toMatchObject({ id: draft.id, body_text: "Original" });
    expect(await store.ops.recent(100)).toHaveLength(10);
    await expect(store.attachments.create({ accountId: command.accountId, filename: "Synthetic", mime: "text/plain", size: 18 * 1024 * 1024, now: 3 })).rejects.toThrow();
  });

  it("bounds recipients before draft consumption", async () => {
    const { store, command } = await setup();
    const draft = (await store.drafts.save({ accountId: command.accountId, to: [], cc: [], subject: "Keep", bodyText: "Original" }, 1))!;
    await expect(store.compose.queueSend({ ...command, to: Array.from({ length: 3001 }, () => command.to[0]!), draftId: draft.id, draftGeneration: draft.generation })).rejects.toThrow();
    expect(await store.drafts.list()).toHaveLength(1);
    expect(await store.ops.recent(100)).toHaveLength(0);
  });

  it("retirement survives reopen, fences late writes and deletes in bounded units", async () => {
    const { store, open, command } = await setup(); const { opId } = await store.compose.queueSend(command);
    await wire(store, opId, 10); await store.sendCopies.accepted(opId, null);
    await store.sendCopies.record(opId, "unknown", { mailbox: "Sent" });
    const charge = (await store.sendCopies.get(opId))!.reserved;
    expect(await store.sendCopies.forgetSlice(opId)).toBe(true);
    expect((await store.sendCopies.get(opId))!.reserved).toBe(charge);
    await expect(store.sendCopies.record(opId, "saved")).rejects.toThrow();
    await store.close(); const next = await open();
    expect((await next.sendCopies.get(opId))?.retiring).toBe(true);
    expect((await next.sendCopies.list(command.accountId)).find((r) => r.opId === opId)).toMatchObject({ retiring: true });
    expect(await next.sendCopies.forgetSlice(opId)).toBe(false);
    expect(await next.sendCopies.get(opId)).toBeNull();
    expect(await next.sendCopies.readWire(opId, 9)).toBeNull();
  });

  it("account deletion removes cold recovery bytes after reopen", async () => {
    const { store, open, command } = await setup(); const { opId } = await store.compose.queueSend(command);
    await wire(store, opId, 10); await store.close(); const next = await open();
    await next.accounts.remove(command.accountId);
    expect(await next.sendCopies.get(opId)).toBeNull();
    expect(await next.sendCopies.readWire(opId, 9)).toBeNull();
  });

  it("terminal completion cannot overwrite a prior send warning or copy outcome", async () => {
    const { store, command } = await setup(); const { opId } = await store.compose.queueSend(command);
    await store.ops.claimReady(2, 10); await wire(store, opId); await store.sendCopies.accepted(opId, "Original rejection"); await store.sendCopies.record(opId, "rejected");
    await store.ops.complete(opId, { warning: "Original warning" }, 3);
    await store.ops.complete(opId, { warning: "Wrong late warning" }, 4);
    expect((await store.ops.get(opId))?.last_error).toBe("Original warning");
    expect((await store.sendCopies.get(opId))?.copy).toBe("rejected");
  });

  it("failure recording retains observed SMTP acceptance when earlier writes failed", async () => {
    const { store, open, command } = await setup(); const { opId } = await store.compose.queueSend(command);
    await store.ops.claimReady(2, 10); await wire(store, opId);
    await store.ops.markUnknown(opId, "Synthetic acceptance and completion writes failed", 3, { warning: null });
    await store.close(); const next = await open();
    expect(await next.sendCopies.get(opId)).toMatchObject({ submission: "accepted", copy: "pending" });
    await expect(next.ops.resolveUnknown(opId, "retry", 4)).rejects.toThrow();
    expect(await next.ops.claimReady(1000000, 10)).toEqual([]);
  });

  it("distinguishes unknown recipients from confirmed rejection across copy repair and reopen", async () => {
    const { store, open, command } = await setup(); const { opId } = await store.compose.queueSend(command);
    await store.ops.claimReady(2, 10); await wire(store, opId);
    await store.sendCopies.accepted(opId, encodeText(L("errors.smtp.recipientOutcomeUnknown")));
    await store.sendCopies.record(opId, "rejected");
    await store.ops.complete(opId, { warning: encodeText(L("errors.sentCopy.recipientUnknownMissing")) }, 3);
    await store.close(); const next = await open();
    expect(await next.ops.get(opId)).toMatchObject({ sent_copy: "rejected", send_partial: false, send_recipient_unknown: true });
    await next.sendCopies.record(opId, "saved", { mailbox: "Sent", uidValidity: "1", uid: 1 });
    expect(await next.ops.get(opId)).toMatchObject({ sent_copy: "saved", send_partial: false, send_recipient_unknown: true, last_error: encodeText(L("errors.smtp.recipientOutcomeUnknown")) });
  });

});

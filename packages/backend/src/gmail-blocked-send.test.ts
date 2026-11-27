/**
 * Plan 293 (CASA 5.2.1): the backend refuses to queue for a Gmail account a file Gmail won't send, however the message
 * gets there (a forward's files never pass the composer's picker): a send now, Undo Send's hold, a schedule.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesBase64 } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-gmail-blocked-"));
  const backend = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await backend.store.ready;
  const gmail = createAccount(sqlDb(backend.store), { kind: "gmail", email: "me@gmail.com", displayName: "Me", color: "brown" }).id;
  const imap = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "brown" }).id;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const stage = async (accountId: number, filename: string, data: Uint8Array) => {
    const ref = await client.call("attachments.create", { accountId, filename, mime: "application/octet-stream", size: data.length });
    await client.call("attachments.append", { accountId, assetId: ref.assetId, index: 0, dataBase64: bytesBase64(data) });
    await client.call("attachments.seal", { accountId, assetId: ref.assetId });
    return ref;
  };
  return { backend, client, gmail, imap, stage };
}

const message = (accountId: number, attachments: { assetId: string; filename: string; mime: string; size: number; contentId?: string | null }[]) => ({ accountId, to: [{ name: "Ana", email: "ana@example.com" }], subject: "Files", bodyText: "Here", attachments });

it("a Gmail send carrying a listed type, or a program under another name, is refused in plain words; the same message from IMAP queues", async () => {
  const { client, gmail, imap, stage } = await setup();
  const exe = await stage(gmail, "setup.exe", Uint8Array.of(0x4d, 0x5a, 0x90, 0));
  await expect(client.call("compose.send", message(gmail, [exe]))).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Gmail won’t send setup.exe: it doesn’t allow .exe files.", details: { reason: "gmailBlocked" } });
  const renamed = await stage(gmail, "invoice.pdf", Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1));
  await expect(client.call("compose.send", message(gmail, [renamed]))).rejects.toMatchObject({ message: "Gmail won’t send invoice.pdf: it doesn’t allow programs." });
  const pdf = await stage(gmail, "invoice.pdf", new TextEncoder().encode("%PDF-1.7"));
  await expect(client.call("compose.send", message(gmail, [pdf]))).resolves.toMatchObject({ opId: expect.any(String) });
  const imapExe = await stage(imap, "setup.exe", Uint8Array.of(0x4d, 0x5a, 0x90, 0));
  await expect(client.call("compose.send", message(imap, [imapExe]))).resolves.toMatchObject({ opId: expect.any(String) });
});

it("Undo Send's hold and a schedule are refused at once, not when their time comes", async () => {
  const { client, gmail, stage } = await setup();
  const exe = await stage(gmail, "tool.msi", Uint8Array.of(1, 2, 3));
  const draft = { draftId: 1, draftGeneration: "g", draftRevision: 1 };
  await expect(client.call("compose.hold", { ...message(gmail, [exe]), ...draft, holdSeconds: 10 })).rejects.toMatchObject({ message: "Gmail won’t send tool.msi: it doesn’t allow .msi files." });
  await expect(client.call("compose.schedule", { ...message(gmail, [exe]), ...draft, sendAt: Date.now() + 3_600_000 })).rejects.toMatchObject({ message: "Gmail won’t send tool.msi: it doesn’t allow .msi files." });
});

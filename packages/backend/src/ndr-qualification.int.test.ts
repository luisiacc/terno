import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { loadLocale, t } from "@terno/i18n";
import { createRegistry } from "@terno/mail";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "NDR fixture cleanup failed");
});

it("keeps a later failure notice independent of one accepted submission", async () => {
  const imap = imapkit({ plugins: ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"], storage: { INBOX: {}, "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" } } } } });
  const accepted: string[] = [];
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], logger: false,
    onAuth: (_auth, _session, cb) => cb(null, { user: "testuser" }),
    onData(stream, _session, cb) {
      let raw = "";
      stream.on("data", (chunk) => { raw += chunk; });
      stream.on("end", () => { accepted.push(raw); cb(); });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "terno-ndr-"));
  let now = Date.now();
  let backend: Backend | undefined;
  let client: RpcClient | undefined;
  cleanups.push(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [
      () => loadLocale("en"),
      () => client?.close(),
      () => backend?.stop(),
      () => new Promise<void>((resolve) => smtp.close(() => resolve())),
      () => imap.stop(),
      () => rmSync(dir, { recursive: true, force: true }),
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "NDR fixture cleanup failed");
  });
  const imapPort = await imap.start(0, "127.0.0.1");
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const smtpPort = (smtp.server.address() as { port: number }).port;
  const open = () => {
    backend = new Backend({ dbPath: join(dir, "mail.db"), version: "test", cipher: plaintextCipher, now: () => now, providers: createRegistry({ imap: { allowInsecure: true } }), autoSync: false });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "renderer", origin: "renderer" });
    client = new RpcClient(c);
    return { backend, client };
  };
  let active = open();
  const account = await active.client.call("accounts.addImap", { email: "me@test.local", displayName: "Me", imap: { host: "127.0.0.1", port: imapPort, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: smtpPort, secure: false, user: "testuser" }, password: "testpass" });
  const { opId } = await active.client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "missing@example.com" }], subject: "Original", bodyText: "Original submission" });
  await active.backend.runWorker();
  expect(accepted).toHaveLength(1);
  const sent = imap.control.listMessages("Sent", { raw: true }) as { uid: number; raw: Buffer }[];
  expect(sent).toHaveLength(1);
  expect(sent[0]!.raw.toString()).toBe(accepted[0]);
  const submission = (await active.client.call("ops.list", {})).find((op) => op.id === opId);
  expect(submission).toMatchObject({ state: "succeeded", attempts: 1, lastError: null });
  await active.backend.syncAccount(account.id);
  expect((await active.client.call("threads.list", { view: "inbox" })).items).toHaveLength(0);

  const notice = ["From: Mail Delivery Subsystem <mailer-daemon@test.local>", "To: me@test.local", "Subject: Delivery failure", "Message-ID: <failure@test.local>", "Date: Thu, 29 Oct 2026 12:00:00 +0000", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Delivery failed for missing@example.com.", "Diagnostic: 550 no such user", ""].join("\r\n");
  const remote = imap.control.addMessage("INBOX", { raw: notice });
  const verify = async () => {
    const inbox = (await active.client.call("threads.list", { view: "inbox" })).items;
    expect(inbox).toHaveLength(1);
    const messages = (await active.client.call("threads.get", { threadId: inbox[0]!.id })).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ rfcMessageId: "failure@test.local", subject: "Delivery failure", from: { name: "Mail Delivery Subsystem", email: "mailer-daemon@test.local" }, bodyText: "Delivery failed for missing@example.com.\nDiagnostic: 550 no such user\n" });
    const identity = sqlDb(active.backend.store).get<{ provider_msg_id: string }>("SELECT provider_msg_id FROM messages WHERE rfc_message_id = ?", "failure@test.local");
    expect(identity?.provider_msg_id).toBe("failure@test.local");
    expect(await active.backend.store.providerStore(account.id).locations!.of([messages[0]!.id])).toEqual([expect.objectContaining({ mailbox: "INBOX", uid: remote.uid, uidvalidity: remote.uidvalidity })]);
    const remoteMessages = imap.control.listMessages("INBOX", { raw: true }) as { uid: number; raw: Buffer }[];
    expect(remoteMessages.map((m) => [m.uid, m.raw.toString()])).toEqual([[remote.uid, notice]]);
    expect((imap.control.listMessages("Sent", { raw: true }) as { uid: number; raw: Buffer }[]).map((m) => [m.uid, m.raw.toString()])).toEqual([[sent[0]!.uid, accepted[0]]]);
    expect(accepted).toHaveLength(1);
    expect((await active.client.call("ops.list", {})).find((op) => op.id === opId)).toEqual(submission);
    return messages[0]!.id;
  };
  await active.backend.syncAccount(account.id);
  const identity = await verify();
  now += 86_400_000;
  await active.backend.runWorker();
  await active.backend.syncAccount(account.id);
  expect(await verify()).toBe(identity);
  active.client.close();
  await active.backend.stop();
  active = open();
  expect(await verify()).toBe(identity);
  await active.backend.runWorker();
  await active.backend.syncAccount(account.id);
  expect(await verify()).toBe(identity);
  await loadLocale("en");
  expect(t("actions.send.sent")).toBe("Message sent");
  await loadLocale("es");
  expect(t("actions.send.sent")).toBe("Correo enviado");
});

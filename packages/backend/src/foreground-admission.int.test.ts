import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createGmailProvider, type ProviderRegistry } from "@terno/mail";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

async function setup(refresh = false) {
  const backgroundAccounts = refresh ? 11 : 2;
  const sender = refresh ? 12 : 3;
  const capacity = refresh ? 64 : 6;
  const paths: string[] = [], unexpected: string[] = [];
  const bodies: { finish(): void }[] = [];
  let first!: () => void;
  const firstNativeBody = new Promise<void>((resolve) => { first = resolve; });
  let witness!: () => void;
  const sixNativeBodies = new Promise<void>((resolve) => { witness = resolve; });
  let sourceClosed = 0, holding = true;
  const raw = Buffer.from("From: Sender <sender@example.test>\r\nTo: reader@example.test\r\nSubject: Body\r\nMessage-ID: <body@example.test>\r\nContent-Type: text/plain\r\n\r\nExact downloaded body").toString("base64url");
  const envelope = (id: string) => JSON.stringify({ id, threadId: id, raw, labelIds: ["INBOX"], internalDate: "1000" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!(input instanceof Request)) throw new Error("Expected managed native Request");
    const url = new URL(input.url), path = url.pathname;
    paths.push(path);
    if (url.origin === "https://foreground.invalid" && /^\/\d+\/token$/.test(path)) return Response.json({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 });
    const mailbox = /^\/(\d+)\/gmail\//.exec(path)?.[1];
    if (url.origin === "https://foreground.invalid" && mailbox) {
      if (path.endsWith("/profile")) return Response.json({ emailAddress: `account${mailbox}@example.test`, historyId: "10" });
      if (path.endsWith("/labels")) return Response.json({ labels: [] });
      if (path.endsWith("/history")) return Response.json({ historyId: "10" });
      if (path.endsWith("/messages/send")) {
        expect(input.method).toBe("POST");
        return Response.json({ id: "sent", threadId: "sent" });
      }
      if (path.endsWith("/messages")) return Response.json(url.searchParams.has("pageToken") ? {} : {
        messages: Array.from({ length: refresh ? 0 : mailbox === "1" ? 1 : 500 }, (_, i) => ({ id: `m${i}` })), nextPageToken: "next",
      });
      const id = /\/messages\/(m\d+|header)$/.exec(path)?.[1];
      if (id && ["raw", "minimal"].includes(url.searchParams.get("format") ?? "")) {
        if (!holding || Number(mailbox) === sender) return new Response(envelope(id));
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let finished = false;
        const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }, { highWaterMark: 0 }));
        bodies.push({ finish() {
          if (finished) return;
          finished = true;
          controller.enqueue(new TextEncoder().encode(envelope(id)));
          controller.close(); sourceClosed++;
        } });
        if (bodies.length === 1) first();
        if (bodies.length === capacity) witness();
        return response;
      }
    }
    unexpected.push(input.url);
    throw new Error("Unexpected synthetic route");
  });
  const providers: ProviderRegistry = {
    create(ctx) { return createGmailProvider(ctx, { endpoints: { api: `https://foreground.invalid/${ctx.account.id}/gmail`, token: `https://foreground.invalid/${ctx.account.id}/token` } }); },
    async verifyImap() {}, async connectGmail() { throw new Error("Unexpected OAuth"); },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-foreground-"));
  const backend = new Backend({ dbPath: join(dir, "mail.db"), providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  const syncs: Promise<void>[] = [];
  const [local, remote] = createMemoryTransportPair();
  backend.connect(remote, { clientId: "foreground-test", origin: "renderer" });
  const rpc = new RpcClient(local);
  cleanups.push(async () => {
    holding = false;
    for (const body of bodies) body.finish();
    rpc.close(); await backend.stop(); await Promise.allSettled(syncs);
    rmSync(dir, { recursive: true, force: true });
    expect(unexpected).toEqual([]);
  });
  await backend.ready;
  for (let id = 1; id <= sender; id++) {
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: `account${id}@example.test`, displayName: "Synthetic", color: "indigo", providerConfig: {}, now: id });
    expect(account.id).toBe(id);
    await backend.setSecret(`account:${id}:refreshToken`, "synthetic-refresh");
  }
  // Real token exchange and profile proof retain the saved mailbox admission boundary.
  await backend.store.settings.set("app", { gmailClientId: "synthetic-client" });
  if (refresh) {
    for (let accountId = 1; accountId <= backgroundAccounts; accountId++) {
      await backend.ingestSliced(Array.from({ length: 6 }, (_, i) => ({
        accountId, providerMsgId: `m${i}`, providerThreadId: `m${i}`, rfcMessageId: `m${i}-${accountId}@example.test`,
        inReplyTo: null, references: [], from: { name: "Sender", email: "sender@example.test" }, to: [], cc: [], bcc: [],
        subject: "Cached", date: 1000, snippet: "Cached", bodyText: "Cached", bodyHtml: null, bodyState: "full" as const, listId: null,
        isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 6,
      })));
    }
  }
  for (let id = 1; id <= backgroundAccounts; id++) {
    syncs.push(backend.syncAccount(id));
    if (!refresh && id === 1) await firstNativeBody;
  }
  return { backend, rpc, paths, sixNativeBodies, bodies, sender, sourceClosed: () => sourceClosed, async finishBackfill() { holding = false; for (const body of bodies) body.finish(); await Promise.all(syncs); } };
}

it("public Send completes through the shared physical pool while six multi-account backfill bodies remain held", async () => {
  const t = await setup();
  await t.sixNativeBodies;
  expect(t.bodies).toHaveLength(6);
  expect(t.paths.some((p) => p === "/1/gmail/messages/m0")).toBe(true);
  expect(t.paths.some((p) => p.startsWith("/2/gmail/messages/m"))).toBe(true);
  expect(t.backend.net.googlePending()).toBe(6);
  const sent = await t.rpc.call("compose.send", { accountId: 3, to: [{ email: "recipient@example.test", name: "" }], subject: "Exact subject", bodyText: "Exact body" });
  await t.backend.runWorker();
  expect((await t.rpc.call("ops.list", {})).find((op) => op.id === sent.opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  expect(t.paths.filter((p) => p === "/3/gmail/messages/send")).toHaveLength(1);
  expect(t.backend.net.googlePending()).toBe(6);
  expect(t.sourceClosed()).toBe(0);
  await t.finishBackfill();
  expect(t.sourceClosed()).toBe(6);
  expect(t.backend.net.googlePending()).toBe(0);
});

it("public header-only open hydrates its body without waiting for held multi-account backfill", async () => {
  const t = await setup();
  await t.sixNativeBodies;
  await t.backend.ingestSliced([{
    accountId: 3, providerMsgId: "header", providerThreadId: "header", rfcMessageId: "header@example.test",
    inReplyTo: null, references: [], from: { name: "Sender", email: "sender@example.test" }, to: [], cc: [], bcc: [],
    subject: "Header", date: 1000, snippet: "", bodyText: null, bodyHtml: null, bodyState: "partial", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  }]);
  const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
  const opened = await t.rpc.call("threads.get", { threadId: thread.id });
  expect(t.backend.net.googlePending()).toBe(6);
  expect(t.sourceClosed()).toBe(0);
  expect(opened.messages[0]!.bodyText).toBe("Exact downloaded body");
});

it("public Send receives an admission opportunity during actual multi-account cached backfill refresh", async () => {
  const t = await setup(true);
  await t.sixNativeBodies;
  expect(t.bodies).toHaveLength(64);
  expect(t.backend.net.googlePending()).toBe(64);
  expect(new Set(t.paths.filter((p) => /\/messages\/m\d+$/.test(p)).map((p) => p.split("/")[1])).size).toBe(11);
  const sent = await t.rpc.call("compose.send", { accountId: t.sender, to: [{ email: "recipient@example.test", name: "" }], subject: "Exact subject", bodyText: "Exact body" });
  await t.backend.runWorker();
  const op = (await t.rpc.call("ops.list", {})).find((row) => row.id === sent.opId);
  expect(op!.attempts).toBeLessThanOrEqual(1);
  console.info("synthetic saturation outcome", { state: op!.state, attempts: op!.attempts, submissions: t.paths.filter((p) => p === `/${t.sender}/gmail/messages/send`).length });
  expect(t.sourceClosed()).toBe(0);
  // Desired opportunity fails while the real native pool is monopolized by refresh.
  expect(op?.state).toBe("succeeded");
});

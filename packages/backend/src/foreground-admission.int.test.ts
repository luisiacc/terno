import "fake-indexeddb/auto";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createGmailProvider, type ProviderRegistry, type ProviderContext } from "@terno/mail";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
const heldTerminals: (() => void)[] = [];
afterEach(async () => {
  try { for (const finish of heldTerminals.splice(0)) finish(); for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

async function setup(refresh = false, kind: "SQL" | "IDB" = "SQL", large = false, autoSync = false, exactCapacity = false) {
  let syncFailure: ((id: number, error: unknown) => Promise<void>) | undefined;
  let override: ((request: Request) => Response | undefined | Promise<Response | undefined>) | undefined;
  let firstPromoted!: () => void;
  const initialPromotion = new Promise<void>((resolve) => { firstPromoted = resolve; });
  const promoted: number[] = [], processed: number[] = [];
  let readerQueued!: () => void;
  const readerPromotion = new Promise<void>((resolve) => { readerQueued = resolve; });
  const backgroundAccounts = refresh ? 11 : 2;
  const sender = refresh ? 12 : 3;
  const capacity = refresh ? 62 : 6;
  const paths: string[] = [], unexpected: string[] = [];
  const requests: { url: string; method: string }[] = [];
  const admissions: { path: string; lane: string }[] = [];
  const google = new Map<number, NonNullable<ProviderContext["google"]>>();
  const syncRuns = new Map<number, number>();
  const bodies: { finish(): void }[] = [];
  let first!: () => void;
  const firstNativeBody = new Promise<void>((resolve) => { first = resolve; });
  let witness!: () => void;
  const sixNativeBodies = new Promise<void>((resolve) => { witness = resolve; });
  let sourceClosed = 0, holding = true;
  const raw = Buffer.from("From: Sender <sender@example.test>\r\nTo: reader@example.test\r\nSubject: Body\r\nMessage-ID: <body@example.test>\r\nContent-Type: text/plain\r\n\r\nExact downloaded body" + (large ? "x".repeat(300_000) : "")).toString("base64url");
  const envelope = (id: string) => JSON.stringify({ id, threadId: id, raw, labelIds: ["INBOX"], internalDate: "1000" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!(input instanceof Request)) throw new Error("Expected managed native Request");
    const url = new URL(input.url), path = url.pathname;
    paths.push(path); requests.push({ url: input.url, method: input.method });
    const replaced = await override?.(input);
    if (replaced) return replaced;
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
        const bytes = new TextEncoder().encode(envelope(id));
        const prefix = large ? 262_145 : 0;
        const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; if (prefix) { for (let i = 0; i < prefix; i += 65_536) c.enqueue(bytes.slice(i, Math.min(i + 65_536, prefix))); } } }, { highWaterMark: 0 }));
        bodies.push({ finish() {
          if (finished) return;
          finished = true;
          controller.enqueue(bytes.slice(prefix));
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
    create(ctx) {
      if (ctx.google) google.set(ctx.account.id, ctx.google);
      const incoming = ctx.incoming!;
      const processor = ctx.incomingProcessor!;
      // a synthetic server: Google's per-user quota pacing (plan 62) is lifted, as in gmail.int.test.ts
      const provider = createGmailProvider({ ...ctx,
        google: ctx.google && { ...ctx.google, request(descriptor, input, init) { admissions.push({ path: new URL(input instanceof Request ? input.url : String(input)).pathname, lane: descriptor.admission ?? "background" }); return ctx.google!.request(descriptor, input, init); } },
        incoming: { ...incoming, promote: async (id, signal, reset, admission) => {
          if (admission === "reader") readerQueued();
          const release = await incoming.promote!(id, signal, reset, admission);
          promoted.push(id); if (promoted.length === 1) firstPromoted(); return release;
        } },
        incomingProcessor: { run: async (input, signal) => { const result = await processor.run(input, signal); processed.push(ctx.account.id); return result; } },
      }, { endpoints: { api: `https://foreground.invalid/${ctx.account.id}/gmail`, token: `https://foreground.invalid/${ctx.account.id}/token` }, unitsPerSecond: Infinity });
      const sync = provider.sync.bind(provider);
      provider.sync = async (sink) => { syncRuns.set(ctx.account.id, (syncRuns.get(ctx.account.id) ?? 0) + 1); try { await sync(sink); } catch (error) { await syncFailure?.(ctx.account.id, error); throw error; } };
      return provider;
    },
    async verifyImap() {}, async connectGmail() { throw new Error("Unexpected OAuth"); },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-foreground-"));
  const factory = new IDBFactory();
  const store = kind === "IDB" ? await IdbMailStore.open({ name: crypto.randomUUID(), factory, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) }, instantSearch: false }) : undefined;
  const backend = new Backend({ store, dbPath: join(dir, "mail.db"), providers, cipher: plaintextCipher, version: "test", autoSync, instantSearch: false, iconTransport: null });
  const syncs: Promise<void>[] = [];
  const [local, remote] = createMemoryTransportPair();
  backend.connect(remote, { clientId: "foreground-test", origin: "renderer" });
  const rpc = new RpcClient(local);
  const pending: Promise<unknown>[] = [];
  const hydrate = (target: { threadId: number; messageId: number }) => { const call = rpc.call("reader.hydrate", target); void call.catch(() => {}); pending.push(call); return call; };
  cleanups.push(async () => {
    holding = false;
    for (const body of bodies) body.finish();
    await backend.stop(); await Promise.allSettled([...syncs, ...pending]); rpc.close();
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
      await backend.ingestSliced(Array.from({ length: exactCapacity && accountId === backgroundAccounts ? 2 : 6 }, (_, i) => ({
        accountId, providerMsgId: `m${i}`, providerThreadId: `m${i}`, rfcMessageId: `m${i}-${accountId}@example.test`,
        inReplyTo: null, references: [], from: { name: "Sender", email: "sender@example.test" }, to: [], cc: [], bcc: [],
        subject: "Cached", date: 1000, snippet: "Cached", bodyText: "Cached", bodyHtml: null, bodyState: "full" as const, listId: null,
        isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 6,
      })));
    }
  }
  for (let id = 1; id <= backgroundAccounts; id++) {
    syncs.push(backend.syncAccount(id));
    if (!refresh && id === 1) { await firstNativeBody; if (large) await initialPromotion; }
  }
  return { backend, rpc, hydrate, paths, requests, google, syncRuns, envelope, onSyncFailure(fn: typeof syncFailure) { syncFailure = fn; }, admissions, sync(id: number) { const work = backend.syncAccount(id); syncs.push(work); return work; }, sixNativeBodies, bodies, sender, promoted, processed, readerPromotion, override(fn: typeof override) { override = fn; }, sourceClosed: () => sourceClosed, async finishBackfill() { holding = false; for (const body of bodies) body.finish(); await Promise.all(syncs); } };
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
  const cached = await t.rpc.call("threads.get", { threadId: thread.id });
  expect(cached.messages[0]!.bodyText).toBeNull();
  await t.hydrate( { threadId: thread.id, messageId: cached.messages[0]!.id });
  const opened = await t.rpc.call("threads.get", { threadId: thread.id });
  expect(t.backend.net.googlePending()).toBe(6);
  expect(t.sourceClosed()).toBe(0);
  expect(opened.messages[0]!.bodyText).toBe("Exact downloaded body\n");
});

it("public Send receives an admission opportunity during actual multi-account cached backfill refresh", async () => {
  const t = await setup(true);
  await t.sixNativeBodies;
  expect(t.bodies).toHaveLength(62);
  expect(t.backend.net.googlePending()).toBe(62);
  expect(new Set(t.paths.filter((p) => /\/messages\/m\d+$/.test(p)).map((p) => p.split("/")[1])).size).toBe(11);
  const sent = await t.rpc.call("compose.send", { accountId: t.sender, to: [{ email: "recipient@example.test", name: "" }], subject: "Exact subject", bodyText: "Exact body" });
  await t.backend.runWorker();
  const op = (await t.rpc.call("ops.list", {})).find((row) => row.id === sent.opId);
  expect(op).toMatchObject({ state: "succeeded", attempts: 1 });
  expect(t.paths.filter((p) => p === `/${t.sender}/gmail/messages/send`)).toHaveLength(1);
  expect(t.backend.net.googlePending()).toBe(62);
  expect(t.sourceClosed()).toBe(0);
  expect(op?.state).toBe("succeeded");
});

for (const kind of ["SQL", "IDB"] as const) {
  it(`${kind} keyed large body waits for actual sole processor retirement, then precedes queued background promotion`, async () => {
    const t = await setup(false, kind, true);
    await t.sixNativeBodies;
    await t.backend.ingestSliced([header(3)]);
    const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
    const cached = await t.rpc.call("threads.get", { threadId: thread.id });
    const hydration = t.hydrate( { threadId: thread.id, messageId: cached.messages[0]!.id });
    await t.readerPromotion;
    expect(t.promoted).toEqual([1]);
    expect(t.processed).toEqual([]);
    const sent = await t.rpc.call("compose.send", { accountId: 3, to: [{ email: "recipient@example.test", name: "" }], subject: "Exact subject", bodyText: "Exact body" });
    await t.backend.runWorker();
    expect((await t.rpc.call("ops.list", {})).find((op) => op.id === sent.opId)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(t.sourceClosed()).toBe(0);
    for (const body of t.bodies) body.finish();
    await hydration;
    const opened = await t.rpc.call("threads.get", { threadId: thread.id });
    expect(opened.messages[0]!.bodyText).toBe("Exact downloaded body" + "x".repeat(300_000) + "\n");
    expect(t.promoted.slice(0, 3)).toEqual([1, 3, 2]);
    expect(t.processed.slice(0, 2)).toEqual([1, 3]);
  });

  it(`${kind} cache reads and non-renderer origins do not hydrate; duplicate keyed actions join one native body`, async () => {
    const t = await setup(false, kind);
    await t.sixNativeBodies;
    await t.backend.ingestSliced([header(3)]);
    const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
    const cached = await t.rpc.call("threads.get", { threadId: thread.id });
    const target = { threadId: thread.id, messageId: cached.messages[0]!.id };
    const before = t.paths.length;
    for (const origin of ["dev", "mcp"] as const) {
      const [local, remote] = createMemoryTransportPair();
      t.backend.connect(remote, { clientId: "observer", origin });
      const observer = new RpcClient(local);
      try { await expect(observer.call("reader.hydrate", target)).rejects.toMatchObject({ code: "FORBIDDEN" }); }
      finally { observer.close(); }
    }
    expect(t.paths).toHaveLength(before);
    expect(cached.messages[0]!.bodyText).toBeNull();
    await Promise.all([t.hydrate( target), t.hydrate( target)]);
    expect(t.paths.filter((path) => path === "/3/gmail/messages/header")).toHaveLength(1);
    expect((await t.rpc.call("threads.get", { threadId: thread.id })).messages[0]!.bodyText).toBe("Exact downloaded body\n");
  });
}

function header(accountId: number) {
  return {
    accountId, providerMsgId: "header", providerThreadId: "header", rfcMessageId: "header@example.test",
    inReplyTo: null, references: [], from: { name: "Sender", email: "sender@example.test" }, to: [], cc: [], bcc: [],
    subject: "Header", date: 1000, snippet: "", bodyText: null, bodyHtml: null, bodyState: "partial" as const, listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  };
}

for (const kind of ["SQL", "IDB"] as const) {
  for (const change of ["removed", "completed", "evicted", "credentials"] as const) it(`${kind} late selected body cannot publish after ${change}`, async () => {
    const t = await setup(false, kind);
    await t.sixNativeBodies;
    await t.backend.ingestSliced([header(3)]);
    const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
    const cached = await t.rpc.call("threads.get", { threadId: thread.id });
    const messageId = cached.messages[0]!.id;
    const held = heldBody();
    t.override((request) => new URL(request.url).pathname === "/3/gmail/messages/header" ? held.response : undefined);
    const hydration = t.hydrate({ threadId: thread.id, messageId });
    await held.started;
    if (change === "removed") await t.backend.store.sync.remove([messageId]);
    if (change === "completed") await t.backend.store.sync.setBody(messageId, "Newer authoritative body", null, { now: 100, classifier: null });
    if (change === "evicted") { t.backend.evictions.begin(); t.backend.evictions.end(); }
    if (change === "credentials") await t.backend.signedIn(3);
    held.finish();
    const outcome = await Promise.allSettled([hydration]);
    if (change === "evicted" || change === "credentials") expect(outcome[0]!.status).toBe("rejected");
    const detail = await t.backend.store.threads.get(thread.id);
    if (change === "removed") expect(detail).toBeNull();
    else expect(detail!.messages[0]!.bodyText).toBe(change === "completed" ? "Newer authoritative body" : null);
    expect(t.paths.filter((p) => p === "/3/gmail/messages/header")).toHaveLength(1);
    expect(t.backend.net.googlePending()).toBe(6);
  });

  it(`${kind} exact message404 retains the cached header and healthy sibling`, async () => {
    const t = await setup(false, kind);
    await t.sixNativeBodies;
    await t.backend.ingestSliced([header(3), { ...header(3), providerMsgId: "sibling", providerThreadId: "sibling", rfcMessageId: "sibling@example.test", bodyText: "Exact sibling", bodyState: "full" }]);
    const threads = await t.rpc.call("threads.list", { view: "inbox", accountId: 3 });
    const details = await Promise.all(threads.items.map((thread) => t.rpc.call("threads.get", { threadId: thread.id })));
    const target = details.find((detail) => detail.messages[0]!.bodyText === null)!;
    t.override((request) => new URL(request.url).pathname === "/3/gmail/messages/header" ? Response.json({}, { status: 404 }) : undefined);
    expect(await t.hydrate({ threadId: target.thread.id, messageId: target.messages[0]!.id })).toEqual({ changed: false, unavailable: true });
    expect(await Promise.all(threads.items.map((thread) => t.rpc.call("threads.get", { threadId: thread.id })))).toEqual(details);
  });

  it(`${kind} duplicate observer cap refuses before any extra native dispatch`, async () => {
    const t = await setup(false, kind);
    await t.sixNativeBodies;
    await t.backend.ingestSliced([header(3)]);
    const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
    const cached = await t.rpc.call("threads.get", { threadId: thread.id });
    const target = { threadId: thread.id, messageId: cached.messages[0]!.id };
    const held = heldBody();
    t.override((request) => new URL(request.url).pathname === "/3/gmail/messages/header" ? held.response : undefined);
    const joined = Array.from({ length: 8 }, () => t.hydrate(target));
    await held.started;
    await expect(t.hydrate(target)).rejects.toMatchObject({ code: "UNAVAILABLE", i18n: { key: "attachments.busy" } });
    expect(t.paths.filter((p) => p === "/3/gmail/messages/header")).toHaveLength(1);
    held.finish();
    expect(await Promise.all(joined)).toEqual(Array.from({ length: 8 }, () => ({ changed: true })));
    expect(t.backend.net.googlePending()).toBe(6);
  });
}

function heldBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let started!: () => void;
  const signal = new Promise<void>((resolve) => { started = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { started(); } }, { highWaterMark: 0 }));
  return { response, started: signal, finish() {
    const raw = Buffer.from("From: sender@example.test\r\nTo: account3@example.test\r\nSubject: Header\r\nContent-Type: text/plain\r\n\r\nExact downloaded body").toString("base64url");
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: "header", threadId: "header", raw, labelIds: ["INBOX"] })));
    controller.close();
  } };
}

it("62 background bodies plus reader and Send retain64; native EOF advances queued Send without another worker call", async () => {
  const t = await setup(true);
  await t.sixNativeBodies;
  await t.backend.ingestSliced([header(t.sender)]);
  const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: t.sender })).items[0]!;
  const detail = await t.rpc.call("threads.get", { threadId: thread.id });
  const reader = heldJson({ id: "header", threadId: "header", raw: Buffer.from("From: sender@example.test\r\nContent-Type: text/plain\r\n\r\nExact body").toString("base64url") });
  const sending = heldJson({ id: "sent", threadId: "sent" });
  let submitted!: () => void;
  const submission = new Promise<void>((resolve) => { submitted = resolve; });
  let posts = 0;
  t.override(async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/header")) return reader.response;
    if (path.endsWith("/messages/send")) {
      const wire = await request.json() as { raw: string };
      const text = Buffer.from(wire.raw, "base64url").toString();
      expect(text).toContain("Exact subject"); expect(text).toContain("Exact body"); expect(text).toContain("recipient@example.test");
      if (++posts === 1) return sending.response;
      submitted(); return Response.json({ id: "sent2", threadId: "sent2" });
    }
  });
  const hydration = t.hydrate({ threadId: thread.id, messageId: detail.messages[0]!.id });
  await reader.started;
  const payload = { to: [{ email: "recipient@example.test", name: "" }], subject: "Exact subject", bodyText: "Exact body" };
  const first = await t.rpc.call("compose.send", { accountId: t.sender, ...payload });
  const worker = t.backend.runWorker();
  void worker.catch(() => {});
  await sending.started;
  expect(t.backend.net.googlePending()).toBe(64);
  const sent = await t.rpc.call("compose.send", { accountId: t.sender - 1, ...payload });
  const original = await t.backend.store.ops.get(sent.opId);
  expect(original).toMatchObject({ state: "queued", attempts: 0 });
  expect(posts).toBe(1);
  sending.finish();
  await submission;
  await worker;
  expect(await t.backend.store.ops.get(first.opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  expect(await t.backend.store.ops.get(sent.opId)).toMatchObject({ state: "succeeded", attempts: 1, payload_json: original!.payload_json });
  expect(posts).toBe(2);
  expect(t.sourceClosed()).toBe(0);
  reader.finish(); await hydration;
  expect(t.backend.net.googlePending()).toBe(62);
});

function heldJson(value: unknown) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let start!: () => void, closed = false;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { start(); }, cancel() { closed = true; } }, { highWaterMark: 0 }));
  const finish = () => { if (closed) return; closed = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close(); };
  heldTerminals.push(finish);
  return { response, started, finish };
}

for (const status of [401, 403, 429] as const) it(`reader HTTP${status} does not publish a body or bypass actual policy`, async () => {
  const t = await setup();
  await t.sixNativeBodies;
  await t.backend.ingestSliced([header(3)]);
  const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
  const detail = await t.rpc.call("threads.get", { threadId: thread.id });
  const target = { threadId: thread.id, messageId: detail.messages[0]!.id };
  t.override((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/3/gmail/messages/header") return Response.json({ error: { errors: [{ reason: status === 403 ? "accessNotConfigured" : "rateLimitExceeded" }] } }, { status, headers: { "retry-after": "120" } });
  });
  await expect(t.hydrate(target)).rejects.toBeInstanceOf(Error);
  const before = t.paths.length;
  if (status === 401) {
    expect((await t.backend.store.accounts.get(3))!.syncState.authRequired).toBe(true);
    expect(await t.hydrate(target)).toEqual({ changed: false });
  } else await expect(t.hydrate(target)).rejects.toBeInstanceOf(Error);
  expect(t.paths).toHaveLength(before);
  expect((await t.rpc.call("threads.get", { threadId: thread.id })).messages[0]!.bodyText).toBeNull();
  expect(t.sourceClosed()).toBe(0);
  expect(t.backend.net.googlePending()).toBe(6);
});

for (const kind of ["SQL", "IDB"] as const) it(`${kind} keyed body writer rejects a foreign current provider identity`, async () => {
  const t = await setup(false, kind);
  await t.sixNativeBodies;
  await t.backend.ingestSliced([header(3)]);
  const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
  const detail = await t.rpc.call("threads.get", { threadId: thread.id });
  const result = await t.backend.store.sync.setBody(detail.messages[0]!.id, "Foreign bytes", null, {
    now: 1, classifier: null, expected: { accountId: 3, threadId: thread.id, providerMsgId: "foreign" },
  });
  expect(result.touched).toEqual([]);
  expect(await t.rpc.call("threads.get", { threadId: thread.id })).toEqual(detail);
});

it("foreground joins an already issued background refresh without duplicating or upgrading its native request", async () => {
  const t = await setup(false, "SQL", false, true);
  await t.sixNativeBodies;
  await t.backend.ingestSliced([header(3)]);
  const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
  const detail = await t.rpc.call("threads.get", { threadId: thread.id });
  const token = heldJson({ access_token: "synthetic-shared", token_type: "Bearer", expires_in: 3600 });
  let sentNative!: () => void;
  const sentRequest = new Promise<void>((resolve) => { sentNative = resolve; });
  t.override((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/3/token") return token.response;
    if (path === "/3/gmail/messages/send") { sentNative(); return Response.json({ id: "sent", threadId: "sent" }); }
  });
  const background = t.sync(3);
  await token.started;
  expect(t.backend.net.googlePending()).toBe(7);
  const hydration = t.hydrate({ threadId: thread.id, messageId: detail.messages[0]!.id });
  const sent = await t.rpc.call("compose.send", { accountId: 3, to: [{ email: "recipient@example.test", name: "" }], subject: "Shared refresh", bodyText: "Exact body" });
  expect(t.paths.filter((path) => path === "/3/token")).toHaveLength(1);
  expect(t.paths.filter((path) => path === "/3/gmail/messages/header")).toHaveLength(0);
  expect(t.admissions.filter((entry) => entry.path === "/3/token")).toEqual([{ path: "/3/token", lane: "background" }]);
  token.finish();
  await hydration; await sentRequest; await t.backend.sendsIdle();
  expect(t.paths.filter((path) => path === "/3/token")).toHaveLength(1);
  expect(t.paths.filter((path) => path === "/3/gmail/messages/header")).toHaveLength(1); // keyed raw read; sync remains behind incoming backfill admission
  expect((await t.rpc.call("ops.list", {})).find((op) => op.id === sent.opId)).toMatchObject({ state: "succeeded", attempts: 1 });
  expect((await t.rpc.call("threads.get", { threadId: thread.id })).messages[0]!.bodyText).toBe("Exact downloaded body\n");
  void background;
});

for (const kind of ["SQL", "IDB"] as const) it(`${kind} keyed capture stages exact attachment bytes and preserves independent queued flag intent`, async () => {
  const t = await setup(false, kind);
  await t.sixNativeBodies;
  await t.backend.ingestSliced([header(3)]);
  const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
  const detail = await t.rpc.call("threads.get", { threadId: thread.id });
  await t.rpc.call("threads.act", { threadIds: [thread.id], action: "star" });
  const ops = await t.rpc.call("ops.list", {});
  const raw = Buffer.from([
    "From: sender@example.test", "To: account3@example.test", "Subject: Header", 'Content-Type: multipart/mixed; boundary="exact"', "",
    "--exact", "Content-Type: text/plain", "", "Exact downloaded body", "--exact", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="exact.bin"', "Content-Transfer-Encoding: base64", "", "AP+ADQo=", "--exact--", "",
  ].join("\r\n")).toString("base64url");
  t.override((request) => new URL(request.url).pathname === "/3/gmail/messages/header" ? Response.json({ id: "header", threadId: "header", raw, labelIds: ["INBOX"] }) : undefined);
  await t.hydrate({ threadId: thread.id, messageId: detail.messages[0]!.id });
  const message = (await t.rpc.call("threads.get", { threadId: thread.id })).messages[0]!;
  expect(message).toMatchObject({ isStarred: true, isRead: false, bodyText: "Exact downloaded body" });
  expect(message.attachments).toHaveLength(1);
  expect(message.attachments[0]).toMatchObject({ filename: "exact.bin", size: 5 });
  expect(await t.rpc.call("attachments.read", { accountId: 3, assetId: message.attachments[0]!.assetId!, index: 0 })).toEqual({ dataBase64: "AP+ADQo=" });
  expect(await t.rpc.call("ops.list", {})).toEqual(ops);
});

for (const phase of ["before", "after"] as const) for (const automatic of [true, false]) it(`capacity EOF ${phase} catch registration resumes once (automatic=${automatic})`, async () => {
  const t = await setup(true, "SQL", false, automatic, true);
  await t.sixNativeBodies;
  expect(t.backend.net.googlePending()).toBe(62);
  t.override((request) => new URL(request.url).pathname === "/12/gmail/messages" ? Response.json({}) : undefined);
  let refused!: () => void, deliver!: () => void, released!: () => void;
  const refusal = new Promise<void>((resolve) => { refused = resolve; });
  const delivery = new Promise<void>((resolve) => { deliver = resolve; });
  const eof = new Promise<void>((resolve) => { released = resolve; });
  t.onSyncFailure(async (id, error) => {
    if (id !== 12) return;
    expect(error).toMatchObject({ cooldown: { kind: "capacity" } });
    refused(); if (phase === "before") await delivery;
  });
  const core = t.backend as unknown as { cooldownChanged(): void };
  const changed = core.cooldownChanged.bind(core);
  vi.spyOn(core, "cooldownChanged").mockImplementation(() => { changed(); if (t.backend.net.googlePending() === 61) released(); });
  const continuation = vi.spyOn(t.backend, "syncAccount");
  const first = t.sync(12);
  await refusal;
  if (phase === "after") await first;
  t.bodies[0]!.finish(); await eof;
  expect(t.backend.net.googlePending()).toBe(61);
  deliver(); await first;
  expect(continuation.mock.calls.filter(([id]) => id === 12)).toHaveLength(automatic ? 2 : 1);
  if (automatic) {
    const index = continuation.mock.calls.findLastIndex(([id]) => id === 12);
    await continuation.mock.results[index]!.value;
    await t.rpc.call("app.bootstrap", {});
    expect(continuation.mock.calls.filter(([id]) => id === 12)).toHaveLength(2);
    expect(t.paths.filter((path) => path === "/12/gmail/messages")).toHaveLength(1);
  } else expect(t.paths.filter((path) => path.startsWith("/12/"))).toHaveLength(0);
});

it("managed selected body obtains its native reader once through exact EOF", async () => {
  const t = await setup(); await t.sixNativeBodies;
  await t.backend.ingestSliced([header(3)]);
  const thread = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items[0]!;
  const detail = await t.rpc.call("threads.get", { threadId: thread.id });
  const raw = Buffer.from("From: sender@example.test\r\nContent-Type: text/plain\r\n\r\nExact reader").toString("base64url");
  const native = Response.json({ id: "header", threadId: "header", raw });
  const acquisition = vi.spyOn(native.body!, "getReader");
  t.override((request) => new URL(request.url).pathname === "/3/gmail/messages/header" ? native : undefined);
  await t.hydrate({ threadId: thread.id, messageId: detail.messages[0]!.id });
  expect(t.backend.net.googlePending()).toBe(6);
  expect(acquisition).toHaveBeenCalledTimes(1);
});

it("successive keyed bodies reuse the provider's stateless fatal UTF8 envelope decoder", async () => {
  const t = await setup(); await t.sixNativeBodies;
  await t.backend.ingestSliced([header(3), { ...header(3), providerMsgId: "header2", providerThreadId: "header2", rfcMessageId: "header2@example.test" }]);
  const list = await t.rpc.call("threads.list", { view: "inbox", accountId: 3 });
  const details = await Promise.all(list.items.map((row) => t.rpc.call("threads.get", { threadId: row.id })));
  const NativeDecoder = globalThis.TextDecoder;
  let fatalDecoders = 0;
  globalThis.TextDecoder = class extends NativeDecoder { constructor(label?: string, options?: TextDecoderOptions) { super(label, options); if (options?.fatal) fatalDecoders++; } };
  t.override((request) => {
    const id = new URL(request.url).pathname.split("/").at(-1)!;
    if (!["header", "header2"].includes(id)) return;
    return Response.json({ id, threadId: id, raw: Buffer.from("From: sender@example.test\r\nContent-Type: text/plain\r\n\r\nExact bytes").toString("base64url") });
  });
  try {
    await t.hydrate({ threadId: details[0]!.thread.id, messageId: details[0]!.messages[0]!.id });
    const afterFirst = fatalDecoders;
    await t.hydrate({ threadId: details[1]!.thread.id, messageId: details[1]!.messages[0]!.id });
    expect(fatalDecoders).toBe(afterFirst);
  } finally { globalThis.TextDecoder = NativeDecoder; }
});


it("a rejected fatal UTF8 envelope cannot poison the next keyed body's decoder or publish bytes", async () => {
  const t = await setup(); await t.sixNativeBodies;
  await t.backend.ingestSliced([header(3), { ...header(3), providerMsgId: "header2", providerThreadId: "header2", rfcMessageId: "header2@example.test" }]);
  const rows = (await t.rpc.call("threads.list", { view: "inbox", accountId: 3 })).items;
  const details = await Promise.all(rows.map((row) => t.rpc.call("threads.get", { threadId: row.id })));
  const first = details.find((detail) => detail.messages[0]!.rfcMessageId === "header@example.test")!;
  const next = details.find((detail) => detail.messages[0]!.rfcMessageId === "header2@example.test")!;
  t.override((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/3/gmail/messages/header") return new Response(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]));
    if (path === "/3/gmail/messages/header2") return Response.json({ id: "header2", threadId: "header2", raw: Buffer.from("From: sender@example.test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nExact café body").toString("base64url") });
  });
  await expect(t.hydrate({ threadId: first.thread.id, messageId: first.messages[0]!.id })).rejects.toBeInstanceOf(Error);
  expect(await t.rpc.call("threads.get", { threadId: first.thread.id })).toEqual(first);
  expect(await t.hydrate({ threadId: next.thread.id, messageId: next.messages[0]!.id })).toEqual({ changed: true });
  expect((await t.rpc.call("threads.get", { threadId: next.thread.id })).messages[0]!.bodyText).toBe("Exact café body\n");
  expect(t.backend.net.googlePending()).toBe(6);
  expect(t.sourceClosed()).toBe(0);
});

for (const guard of ["retired", "auth", "quota", "policy"] as const) it(`capacity EOF before registration cannot bypass ${guard}`, async () => {
  const t = await setup(true, "SQL", false, true, true);
  await t.sixNativeBodies;
  let refused!: () => void, deliver!: () => void, released!: () => void;
  const refusal = new Promise<void>((resolve) => { refused = resolve; });
  const delivery = new Promise<void>((resolve) => { deliver = resolve; });
  const eof = new Promise<void>((resolve) => { released = resolve; });
  t.onSyncFailure(async (id, error) => {
    if (id !== 12) return;
    expect(error).toMatchObject({ cooldown: { kind: "capacity" } });
    refused(); await delivery;
  });
  const core = t.backend as unknown as { cooldownChanged(): void };
  const changed = core.cooldownChanged.bind(core);
  vi.spyOn(core, "cooldownChanged").mockImplementation(() => { changed(); if (t.backend.net.googlePending() === 61) released(); });
  const calls = vi.spyOn(t.backend, "syncAccount");
  const first = t.sync(12); await refusal;
  let retirement: Promise<void> | undefined;
  if (guard === "retired") retirement = t.backend.dropAccount(12);
  else {
    await t.backend.ingestSliced([header(12)]);
    const row = (await t.rpc.call("threads.list", { view: "inbox", accountId: 12 })).items[0]!;
    const detail = await t.rpc.call("threads.get", { threadId: row.id });
    const status = guard === "auth" ? 401 : guard === "policy" ? 403 : 429;
    t.override((request) => new URL(request.url).pathname === "/12/gmail/messages/header" ? Response.json({ error: { errors: [{ reason: guard === "policy" ? "accessNotConfigured" : "rateLimitExceeded" }] } }, { status, headers: { "retry-after": "120" } }) : undefined);
    await expect(t.hydrate({ threadId: row.id, messageId: detail.messages[0]!.id })).rejects.toBeInstanceOf(Error);
    if (guard === "auth") expect((await t.backend.store.accounts.get(12))!.syncState.authRequired).toBe(true);
  }
  t.bodies[0]!.finish(); await eof;
  deliver(); await first; await retirement;
  await t.rpc.call("app.bootstrap", {});
  expect(calls.mock.calls.filter(([id]) => id === 12)).toHaveLength(1);
  expect(t.paths.filter((path) => path === "/12/gmail/messages")).toHaveLength(0);
  expect(t.backend.net.googlePending()).toBe(61);
});


for (const mode of ["available", "refilled", "retired", "removed", "credentials", "automatic-off"] as const) it(`capacity state-write handoff retains native progress (${mode})`, async () => {
  const t = await setup(true, "SQL", false, mode !== "automatic-off", true);
  await t.sixNativeBodies;
  const sibling = (await t.rpc.call("threads.list", { view: "inbox", accountId: 2 })).items[0]!;
  const siblingBefore = await t.rpc.call("threads.get", { threadId: sibling.id });
  const ops = await t.rpc.call("ops.list", {});
  expect(ops).toEqual([]);
  let entered!: () => void, unblock!: () => void, edge!: () => void, renewed!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const eof = new Promise<void>((resolve) => { edge = resolve; });
  const newCredentials = new Promise<void>((resolve) => { renewed = resolve; });
  heldTerminals.push(unblock);
  const setState = t.backend.store.accounts.setSyncState.bind(t.backend.store.accounts);
  let gated = false;
  vi.spyOn(t.backend.store.accounts, "setSyncState").mockImplementation(async (id, patch) => {
    if (id === 12 && patch.status === "error" && !gated) { gated = true; entered(); await gate; }
    return setState(id, patch);
  });
  t.override((request) => {
    const url = new URL(request.url);
    if (url.origin === "https://foreground.invalid" && url.pathname === "/12/gmail/messages") return Response.json(url.searchParams.has("pageToken") ? {} : { messages: [{ id: "header" }] });
  });
  const core = t.backend as unknown as { cooldownChanged(): void };
  const changed = core.cooldownChanged.bind(core);
  let epoch: number | undefined;
  vi.spyOn(core, "cooldownChanged").mockImplementation(() => {
    changed();
    if (t.backend.net.googlePending() === 61) edge();
    if (epoch !== undefined && t.google.get(12)!.generation() !== epoch) renewed();
  });
  const calls = vi.spyOn(t.backend, "syncAccount");
  const first = t.sync(12); await writing;
  epoch = t.google.get(12)!.generation();
  expect(t.syncRuns.get(12)).toBe(1);
  expect(t.paths.filter((path) => path.startsWith("/12/"))).toEqual([]);
  expect(t.backend.net.googlePending()).toBe(62);
  t.bodies[0]!.finish(); await eof;
  expect(t.sourceClosed()).toBe(1);
  expect(t.backend.net.googlePending()).toBe(61);
  let refill: Promise<ArrayBuffer> | undefined;
  if (mode !== "available") {
    const response = await t.google.get(1)!.request({ request: { endpoint: "gmail-api", purpose: "mail" }, admission: "background" }, new Request("https://foreground.invalid/1/gmail/messages/m0?format=minimal", { headers: { Authorization: "Bearer synthetic-access" } }));
    refill = response.arrayBuffer();
    expect(t.bodies).toHaveLength(63);
    expect(t.backend.net.googlePending()).toBe(62);
    expect(t.paths.filter((path) => path === "/1/gmail/messages/m0")).toHaveLength(2);
  }
  let cancelled: Promise<void> | undefined;
  if (mode === "retired") cancelled = t.backend.dropAccount(12);
  if (mode === "removed") cancelled = t.rpc.call("accounts.remove", { id: 12 }).then(() => {});
  if (mode === "credentials") { cancelled = t.backend.signedIn(12); await newCredentials; }
  unblock(); await first; await cancelled;
  if (mode !== "available") {
    expect(t.paths.filter((path) => path.startsWith("/12/"))).toEqual([]);
    expect(t.backend.net.googlePending()).toBe(62);
  }
  if (refill) t.bodies.at(-1)!.finish();
  if (refill) expect(new Uint8Array(await refill)).toEqual(new TextEncoder().encode(t.envelope("m0")));
  await Promise.all(calls.mock.results.filter((_, i) => calls.mock.calls[i]![0] === 12).map((result) => result.value));
  expect(t.backend.net.googlePending()).toBe(61);
  expect(t.sourceClosed()).toBe(mode === "available" ? 1 : 2);
  // Bootstrap is an RPC/serial-store barrier, never a manual sync or a polling retry.
  await t.rpc.call("app.bootstrap", {});
  const eligible = mode === "available" || mode === "refilled";
  const list = await t.rpc.call("threads.list", { view: "inbox", accountId: 12 });
  const detail = list.items[0] ? await t.rpc.call("threads.get", { threadId: list.items[0].id }) : null;
  expect.soft({ runs: t.syncRuns.get(12), reads: t.requests.filter((request) => new URL(request.url).pathname === "/12/gmail/messages/header").map((request) => ({ method: request.method, format: new URL(request.url).searchParams.get("format") })),
    cursor: (await t.backend.store.accounts.config<{ cursor?: unknown }>(12))?.config.cursor ?? null,
    bodies: detail?.messages.map((message) => ({ accountId: message.accountId, bodyState: message.bodyState, isRead: message.isRead, isStarred: message.isStarred, body: message.bodyText, assets: message.attachments })) ?? [] }).toEqual({
    runs: eligible ? 2 : 1, reads: eligible ? [{ method: "GET", format: "raw" }, { method: "GET", format: "minimal" }] : [], cursor: eligible ? { historyId: "10" } : null,
    bodies: eligible ? [{ accountId: 12, bodyState: "full", isRead: true, isStarred: false, body: "Exact downloaded body\n", assets: [] }] : [],
  });
  await t.finishBackfill();
  await Promise.all(calls.mock.results.filter((_, i) => calls.mock.calls[i]![0] === 12).map((result) => result.value));
  expect.soft(t.syncRuns.get(12)).toBe(eligible ? 2 : 1);
  expect(await t.rpc.call("threads.get", { threadId: sibling.id })).toEqual({ ...siblingBefore,
    thread: { ...siblingBefore.thread, unread: false },
    messages: siblingBefore.messages.map((message) => ({ ...message, isRead: true, bodyText: "Exact downloaded body\n", attachmentState: "complete" })),
  });
  expect(await t.rpc.call("ops.list", {})).toEqual(ops);
  expect(t.backend.net.googlePending()).toBe(0);
  expect(t.sourceClosed()).toBe(mode === "available" ? 62 : 63);
});

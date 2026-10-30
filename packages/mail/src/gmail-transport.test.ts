import { expect, it, vi } from "vitest";
import { createGmailApiProvider } from "./gmail-api";
import { buildRawPortable } from "./compose-portable";
import { ProviderError, type SendPayload, type ProviderContext, type SyncSink } from "./types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function provider(fetcher: typeof fetch, timeoutMs = 25) {
  const ctx = { account: { id: 1 }, store: {}, fetch: fetcher } as unknown as ProviderContext;
  return createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array([1]), readTimeoutMs: timeoutMs, sendTimeoutMs: timeoutMs });
}

it.each([undefined, "1"])("bounds actual profile bytes despite Content-Length %s", async (length) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ historyId: "10", ignored: "x".repeat(128 * 1024) }));
  let offset = 0, pulls = 0, canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (offset === bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + 8192);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
    cancel() { canceled = true; },
  });
  const p = provider(async () => new Response(body, { headers: length ? { "content-length": length } : undefined }), 1000);
  try {
    await expect(p.verify()).rejects.toMatchObject({ retryable: true, ambiguous: false });
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(10);
    expect(body.locked).toBe(false);
  } finally { await p.close(); }
});

it("preserves split UTF-8 and JSON escapes in an ordinary complete response", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ historyId: "9007199254740995", ignored: "é\\\"🙂" }));
  let offset = 0;
  const p = provider(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(offset, ++offset));
  } })), 1000);
  try { await expect(p.verify()).resolves.toBeUndefined(); } finally { await p.close(); }
});

it("the response-body deadline settles even when the stream ignores fetch abort", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const p = provider(async () => new Response(body));
  let settled = false;
  const result = p.verify().then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
  await sleep(70);
  const settledByDeadline = settled;
  try { source.close(); } catch { /* The bounded reader may already have canceled. */ }
  const error = await result;
  await p.close();
  expect(settledByDeadline).toBe(true);
  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({ retryable: true, ambiguous: false });
  expect(body.locked).toBe(false);
});

it("an ignored header abort settles at the deadline and cancels a late response", async () => {
  let respond!: (response: Response) => void;
  const fetcher: typeof fetch = () => new Promise<Response>((resolve) => { respond = resolve; });
  const p = provider(fetcher);
  let settled = false, canceled = false;
  const work = p.verify().catch((error: unknown) => error).finally(() => { settled = true; });
  await sleep(70);
  const settledByDeadline = settled;
  respond(new Response(new ReadableStream({ cancel() { canceled = true; } })));
  const error = await work;
  await sleep(0);
  await p.close();
  expect(settledByDeadline).toBe(true);
  expect(error).toMatchObject({ retryable: true, network: true });
  expect(canceled).toBe(true);
});

it("invalid UTF-8 is an unusable response rather than an offline account", async () => {
  const p = provider(async () => new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])));
  try { await expect(p.verify()).rejects.toMatchObject({ retryable: true, network: false, ambiguous: false }); }
  finally { await p.close(); }
});

it("a stuck 401 cancellation cannot prevent the single fresh-token attempt", async () => {
  let release!: () => void;
  const cancel = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const p = provider(async () => ++calls === 1 ? new Response(new ReadableStream({ cancel: () => cancel }), { status: 401 }) : Response.json({ historyId: "10" }), 1000);
  let settled = false;
  const work = p.verify().finally(() => { settled = true; });
  await sleep(50);
  const completedBeforeCancel = settled;
  release(); await work; await p.close();
  expect(completedBeforeCancel).toBe(true);
  expect(calls).toBe(2);
});

const sendPayload: SendPayload = {
  from: { name: "Sender", email: "sender@example.test" },
  to: [{ name: "Recipient", email: "recipient@example.test" }], cc: [],
  bcc: [{ name: "Hidden", email: "hidden@example.test" }],
  subject: "Synthetic send", text: "Exact body", messageId: "send@example.test",
  references: [], inReplyTo: null, providerThreadId: "thread-original",
};

function sendProvider(response: Response) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const ctx = { account: { id: 1 }, store: {}, fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return response;
  } } as ProviderContext;
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: buildRawPortable, sendTimeoutMs: 1000 });
  return { p, requests, send: (payload = sendPayload) => p.execute({ id: "send", kind: "send", target: {}, payload }) };
}

function expectSendRequest(requests: { url: string; init?: RequestInit }[]) {
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  expect(requests[0]!.init).toMatchObject({ method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" } });
  expect(typeof requests[0]!.init!.body).toBe("string");
  const envelope = JSON.parse(requests[0]!.init!.body as string);
  expect(Object.keys(envelope).sort()).toEqual(["raw", "threadId"]);
  expect(envelope.threadId).toBe(sendPayload.providerThreadId);
  expect(envelope.raw).toMatch(/^[A-Za-z0-9_-]+$/);
  const mime = Buffer.from(envelope.raw, "base64url").toString();
  expect(mime).toContain("From: Sender <sender@example.test>\r\n");
  expect(mime).toContain("To: Recipient <recipient@example.test>\r\n");
  expect(mime).toContain("Bcc: Hidden <hidden@example.test>\r\n");
  expect(mime).toContain("Subject: Synthetic send\r\n");
  expect(mime).toContain("Message-ID: <send@example.test>\r\n");
  expect(mime).toContain(Buffer.from(sendPayload.text).toString("base64"));
}

it.each([undefined, "1"])("an oversized successful send response stays uncertain after exactly one submission (Content-Length %s)", async (length) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ id: "sent", ignored: "x".repeat(128 * 1024) }));
  let offset = 0, pulls = 0;
  let cancellation: unknown;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (offset === bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + 8192);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
    cancel(reason) { cancellation = reason; },
  }, { highWaterMark: 0 });
  const reader = vi.spyOn(body, "getReader");
  const { p, send, requests } = sendProvider(new Response(body, { headers: length ? { "content-length": length } : undefined }));
  try {
    const error = await send().catch((error: unknown) => error);
    expectSendRequest(requests);
    expect(reader).toHaveBeenCalledOnce();
    expect(pulls).toBe(9);
    expect(offset).toBe(65_536 + 8192);
    expect(cancellation).toMatchObject({ name: "ResponseBodyLimitError", limit: 65_536 });
    expect(body.locked).toBe(false);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ retryable: false, ambiguous: true, network: false });
  } finally { await p.close(); }
});

it.each(["invalid JSON", "invalid UTF-8", "stream failure", "incomplete result"])("an accepted send with %s remains uncertain without resubmission", async (failure) => {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    reads++;
    if (failure === "stream failure") return controller.error(new TypeError("synthetic body failure"));
    controller.enqueue(failure === "invalid UTF-8" ? new Uint8Array([255]) : new TextEncoder().encode(failure === "invalid JSON" ? "{" : "{}"));
    controller.close();
  } }, { highWaterMark: 0 });
  const { p, send, requests } = sendProvider(new Response(body));
  try {
    const error = await send().catch((error: unknown) => error);
    expectSendRequest(requests);
    expect(reads).toBe(1);
    expect(body.locked).toBe(false);
    expect(error).toMatchObject({ retryable: false, ambiguous: true, network: false });
  } finally { await p.close(); }
});

it("a complete successful send preserves the provider IDs after one submission", async () => {
  const { p, send, requests } = sendProvider(Response.json({ id: "sent", threadId: "thread-sent" }));
  try {
    await expect(send()).resolves.toEqual({ providerMsgId: "sent", providerThreadId: "thread-sent" });
    expectSendRequest(requests);
  } finally { await p.close(); }
});

it("invalid prepared attachment input is refused before submission or response consumption", async () => {
  const response = Response.json({ id: "sent" });
  const reader = vi.spyOn(response.body!, "getReader");
  const { p, send, requests } = sendProvider(response);
  try {
    await expect(send({ ...sendPayload, attachments: [{ assetId: "missing", filename: "missing.txt", mime: "text/plain", size: 1 }] })).rejects.toMatchObject({ retryable: false, ambiguous: false });
    expect(requests).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
  } finally { await p.close(); }
});

it.each([400, 403, 429, 503])("send status %i preserves its classification even if its body exceeds the limit", async (status) => {
  const { p, send, requests } = sendProvider(new Response("x".repeat(128 * 1024), { status }));
  try {
    const error = await send().catch((error: unknown) => error);
    expectSendRequest(requests);
    expect(error).toMatchObject({ status, retryable: status === 429 || status >= 500, ambiguous: status >= 500 });
  } finally { await p.close(); }
});

it("an oversized message listing remains a definitive read refusal without completing enumeration", async () => {
  const paths: string[] = [];
  const saveCursor = vi.fn();
  const effect = vi.fn();
  const ctx = { account: { id: 1 }, store: {}, loadCursor: async () => null, saveCursor,
    fetch: async (url: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return path.endsWith("/profile") ? Response.json({ historyId: "10" }) : Response.json({ messages: [], ignored: "x".repeat(300 * 1024) });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = { signal: new AbortController().signal, windowStart: 0, ingest: effect, updateFlags: effect, removeMessages: effect, setBody: effect, setSyncState: async () => {}, pendingMessageIds: async () => new Set() };
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: buildRawPortable });
  try {
    await expect(p.sync(sink)).rejects.toMatchObject({ retryable: false, ambiguous: false, network: false });
    expect(paths.map((path) => path.split("/").at(-1))).toEqual(["profile", "messages"]);
    expect(saveCursor).toHaveBeenCalledExactlyOnceWith({ reconciliation: expect.objectContaining({ stage: "enumerate", baseline: "10", pages: 0 }) }, expect.any(Function));
    expect(effect).not.toHaveBeenCalled();
  } finally { await p.close(); }
});

it("provider error bodies and transport exceptions cannot expose private detail", async () => {
  const marker = "synthetic-token-address-subject-marker";
  for (const fetcher of [async () => new Response(JSON.stringify({ error: marker }), { status: 500 }), async () => { throw new TypeError(marker); }]) {
    const p = provider(fetcher);
    try {
      const error = await p.verify().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ProviderError);
      expect(String(error)).not.toContain(marker);
    } finally { await p.close(); }
  }
});

it.each([2, 3, 4])("reset after headers at microtask %i still cancels the unread control body", async (depth) => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const response = new Response(body);
  const later = (left: number) => { if (left) queueMicrotask(() => later(left - 1)); else p.reset!(); };
  const p = provider(() => { later(depth); return Promise.resolve(response); }, 1000);
  await expect(p.verify()).rejects.toBeInstanceOf(ProviderError);
  await p.close();
  const canceledByProvider = canceled;
  if (!canceled) await body.cancel();
  expect(canceledByProvider).toBe(true);
  expect(body.locked).toBe(false);
});

it.each([
  [{ details: [{ reason: "SERVICE_DISABLED" }] }, "disabled"],
  [{ errors: [{ reason: "accessNotConfigured" }] }, "disabled"],
  [{ details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] }, "denied"],
  [{ errors: [{ reason: "insufficientPermissions" }] }, "denied"],
  [{ message: "SERVICE_DISABLED synthetic-private-detail" }, "denied"],
] as const)("People API retains structured recovery independently of display text: %j", async (error, expected) => {
  const p = provider(async (input) => String(input).includes("userinfo") ? Response.json({}) : Response.json({ error }, { status: 403 }), 1000);
  try {
    const photos = await p.photos!({ connections: true, otherContacts: true });
    expect(photos).toMatchObject({ connections: expected, otherContacts: expected, contacts: [] });
    expect(JSON.stringify(photos)).not.toContain("synthetic-private-detail");
  } finally { await p.close(); }
});

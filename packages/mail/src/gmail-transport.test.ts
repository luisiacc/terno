import { expect, it } from "vitest";
import { createGmailApiProvider } from "./gmail-api";
import { ProviderError, type ProviderContext } from "./types";

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

it("an oversized successful send response stays uncertain after exactly one submission", async () => {
  let calls = 0;
  const p = provider(async () => { calls++; return Response.json({ id: "sent", ignored: "x".repeat(128 * 1024) }); }, 1000);
  try {
    await expect(p.execute({ id: "send", kind: "send", target: {}, payload: {} })).rejects.toMatchObject({ retryable: false, ambiguous: true });
    expect(calls).toBe(1);
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

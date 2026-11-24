import { afterEach, expect, it, vi } from "vitest";
import { ProviderCooldown, ProviderCooldownError } from "./provider-cooldown";
import { createNetworkPolicy } from "./net-policy";

const gates: ProviderCooldown[] = [];
afterEach(async () => { for (const gate of gates.splice(0)) await gate.close(); });
async function policy(live: () => boolean = () => true) {
  let raw: string | null = null;
  const gate = await ProviderCooldown.open({ read: async () => raw, update: async (fn) => { const result = fn(raw); raw = result.encoded; return result.result; } }, { wallNow: () => 1000, elapsedNow: () => 10, random: () => 0.5 });
  gates.push(gate);
  return gate.requestsFor("a".repeat(64), live);
}
const descriptor = { request: { endpoint: "gmail-api", purpose: "mail" } } as const;

it("freezes a managed Google Request before awaiting admission and refuses redirects", async () => {
  const sent: Request[] = [];
  const net = createNetworkPolicy({ fetch: async (input) => { sent.push(input as Request); return new Response("{}"); } });
  const headers = new Headers({ authorization: "Bearer synthetic-original" });
  const body = new URLSearchParams({ value: "original" });
  const init = { method: "POST", headers, body, redirect: "follow" as const };
  const result = net.fetchGoogle(await policy(), descriptor)("https://gmail.googleapis.com/test", init);
  headers.set("authorization", "Bearer synthetic-mutated"); body.set("value", "mutated");
  init.method = "DELETE";
  const response = await result;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.method).toBe("POST");
  expect(sent[0]!.headers.get("authorization")).toBe("Bearer synthetic-original");
  expect(await sent[0]!.text()).toBe("value=original");
  expect(sent[0]!.redirect).toBe("error");
  expect(await response.text()).toBe("{}");
  expect(net.googlePending()).toBe(0);
});

it("holds one shared bounded physical pool while bodies are open; a settled cancel frees its slot (plan 262)", async () => {
  const transport = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel() {} })));
  const net = createNetworkPolicy({ fetch: transport });
  const fetchA = net.fetchGoogle(await policy(), descriptor), fetchB = net.fetchGoogle(await policy(), descriptor);
  const responses: Response[] = [];
  for (let i = 0; i < 64; i++) responses.push(await (i % 2 ? fetchA : fetchB)("https://gmail.googleapis.com/test"));
  expect(net.googlePending()).toBe(64);
  await expect(fetchA("https://gmail.googleapis.com/denied")).rejects.toBeInstanceOf(ProviderCooldownError);
  expect(transport).toHaveBeenCalledTimes(64);
  await responses[0]!.body!.cancel();
  expect(net.googlePending()).toBe(63);
  responses.push(await fetchA("https://gmail.googleapis.com/admitted"));
  expect(transport).toHaveBeenCalledTimes(65);
  await Promise.all(responses.slice(1).map((r) => r.body!.cancel()));
  expect(net.googlePending()).toBe(0);
});

/** A fetch as the Fetch Standard has it: aborting the signal rejects a pending fetch and errors a streaming body. */
function standardFetch(answer?: (request: Request) => Response | undefined) {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const request = input as Request;
    const ready = answer?.(request);
    if (ready) return ready;
    return new Promise<Response>((_, reject) => {
      if (request.signal.aborted) reject(request.signal.reason);
      else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  });
}

it("an aborted request gives its slot back: deadlines and resets never wear the pool down (plan 262)", async () => {
  // the incident: a long run of timeouts and network resets left background sync refused for good
  const transport = standardFetch();
  const net = createNetworkPolicy({ fetch: transport });
  const request = net.fetchGoogle(await policy(), { ...descriptor, admission: "background" });
  for (let i = 0; i < 100; i++) {
    const abort = new AbortController();
    const pending = request("https://gmail.googleapis.com/history", { signal: abort.signal });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(i + 1));
    expect(net.googlePending()).toBe(1);
    abort.abort(new DOMException("no answer", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(net.googlePending()).toBe(0);
  }
  expect(net.googleAvailable("background")).toBe(true);
});

it("62 aborted background requests leave the 63rd admitted to the transport (plan 262)", async () => {
  const transport = standardFetch();
  const net = createNetworkPolicy({ fetch: transport });
  const request = net.fetchGoogle(await policy(), { ...descriptor, admission: "background" });
  const aborts = Array.from({ length: 62 }, () => new AbortController());
  const pending = aborts.map((abort) => request("https://gmail.googleapis.com/history", { signal: abort.signal }).catch((error: unknown) => error));
  await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(62));
  expect(net.googleAvailable("background")).toBe(false);
  for (const abort of aborts) abort.abort(new DOMException("no answer", "TimeoutError"));
  await Promise.all(pending);
  expect(net.googlePending()).toBe(0);
  const next = new AbortController();
  const admitted = request("https://gmail.googleapis.com/history", { signal: next.signal }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(63));
  next.abort(); await admitted;
  expect(net.googlePending()).toBe(0);
});

it("a fetch that throws synchronously gives its slot back", async () => {
  let calls = 0;
  const net = createNetworkPolicy({ fetch: ((() => { if (++calls === 1) throw new TypeError("synthetic synchronous failure"); return Promise.resolve(new Response("{}")); }) as unknown) as typeof fetch });
  const request = net.fetchGoogle(await policy(), { ...descriptor, admission: "background" });
  await expect(request("https://gmail.googleapis.com/first")).rejects.toThrow("synthetic synchronous failure");
  expect(net.googlePending()).toBe(0);
  expect(await (await request("https://gmail.googleapis.com/second")).text()).toBe("{}");
  expect(net.googlePending()).toBe(0);
});

it("an idle body's native error frees the slot with nobody reading", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const net = createNetworkPolicy({ fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) { body = c; } }, { highWaterMark: 0 })) });
  const response = await net.fetchGoogle(await policy(), descriptor)("https://gmail.googleapis.com/test");
  expect(net.googlePending()).toBe(1);
  body.error(new TypeError("synthetic connection reset"));
  await expect.poll(() => net.googlePending()).toBe(0);
  await expect(response.text()).rejects.toThrow("synthetic connection reset");
});

it("an abort while a pending read waits holds the slot until the transport's cancel settles", async () => {
  let settle!: () => void, pulled!: () => void;
  const pulling = new Promise<void>((resolve) => { pulled = resolve; });
  const net = createNetworkPolicy({ fetch: async () => new Response(new ReadableStream<Uint8Array>({
    pull() { pulled(); return new Promise<void>(() => {}); },
    cancel() { return new Promise<void>((resolve) => { settle = resolve; }); },
  }, { highWaterMark: 0 })) });
  const abort = new AbortController();
  const response = await net.fetchGoogle(await policy(), descriptor)("https://gmail.googleapis.com/test", { signal: abort.signal });
  const read = response.text().catch((error: unknown) => error);
  await pulling;
  abort.abort();
  expect(await read).toMatchObject({ name: "AbortError" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(net.googlePending()).toBe(1); // the stream closed; the transport hasn't said it's done
  settle();
  await expect.poll(() => net.googlePending()).toBe(0);
});

it("an abort while a 429's pause is still being saved frees the slot first", async () => {
  let save!: () => void;
  const saving = new Promise<void>((resolve) => { save = resolve; });
  let raw: string | null = null;
  const gate = await ProviderCooldown.open({ read: async () => raw, update: async (fn) => { await saving; const result = fn(raw); raw = result.encoded; return result.result; } }, { wallNow: () => 1000, elapsedNow: () => 10, random: () => 0.5 });
  gates.push(gate);
  const net = createNetworkPolicy({ fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull() {} }), { status: 429, headers: { "retry-after": "120" } }) });
  const abort = new AbortController();
  const result = net.fetchGoogle(gate.requestsFor("a".repeat(64)), descriptor)("https://gmail.googleapis.com/test", { signal: abort.signal }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(net.googlePending()).toBe(1));
  abort.abort();
  await expect.poll(() => net.googlePending()).toBe(0);
  save();
  await result;
});

it("an abort after headers frees the slot though nobody reads the body, and the body reads as the abort", async () => {
  let cancelled = 0;
  const net = createNetworkPolicy({ fetch: standardFetch(() => new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel() { cancelled++; } }))) });
  const abort = new AbortController();
  const response = await net.fetchGoogle(await policy(), descriptor)("https://gmail.googleapis.com/test", { signal: abort.signal });
  expect(net.googlePending()).toBe(1);
  abort.abort();
  await expect.poll(() => net.googlePending()).toBe(0);
  expect(cancelled).toBe(1);
  await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
  expect(net.googlePending()).toBe(0);
});

it("an abort racing EOF on an in-flight read releases once", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>, pulled!: () => void;
  const pulling = new Promise<void>((resolve) => { pulled = resolve; });
  const net = createNetworkPolicy({ fetch: standardFetch(() => new Response(new ReadableStream<Uint8Array>({ start(c) { body = c; }, pull() { pulled(); } }, { highWaterMark: 0 }))) });
  const abort = new AbortController();
  const request = net.fetchGoogle(await policy(), { ...descriptor, admission: "background" });
  const response = await request("https://gmail.googleapis.com/test", { signal: abort.signal });
  const read = response.text().catch(() => "aborted");
  await pulling;
  body.close();
  abort.abort();
  await read;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(net.googlePending()).toBe(0);
  expect(net.googleAvailable("background")).toBe(true);
  const next = await request("https://gmail.googleapis.com/next");
  expect(net.googlePending()).toBe(1);
  await next.body?.cancel();
  expect(net.googlePending()).toBe(0);
});

it.each([200, 429])("drains a retired %s response without publishing headers and retains capacity until native EOF", async (status) => {
  let live = true;
  let resolveResponse!: (response: Response) => void;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const headers = vi.fn();
  let signal: AbortSignal | undefined;
  const net = createNetworkPolicy({ fetch: async (input) => {
    signal = (input as Request).signal;
    return new Promise<Response>((resolve) => { resolveResponse = resolve; });
  } });
  const result = net.fetchGoogle(await policy(() => live), { ...descriptor, onHeaders: headers })("https://gmail.googleapis.com/test");
  await vi.waitFor(() => expect(resolveResponse).toBeDefined());
  expect(net.googlePending()).toBe(1);
  live = false;
  resolveResponse(new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel: cancelled }), { status, headers: { "retry-after": "120" } }));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(signal?.aborted).toBe(false);
  expect(headers).not.toHaveBeenCalled();
  expect(net.googlePending()).toBe(1);
  expect(cancelled).not.toHaveBeenCalled();
  controller.enqueue(new Uint8Array([1, 2, 3]));
  expect(net.googlePending()).toBe(1);
  controller.close();
  await expect.poll(() => net.googlePending()).toBe(0);
  expect(cancelled).not.toHaveBeenCalled();
});


it.each([false, true])("retired body failure releases capacity, request aborted or not (aborted=%s)", async (aborted) => {
  let live = true;
  let deliver!: (response: Response) => void;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const abort = new AbortController();
  const net = createNetworkPolicy({ fetch: async () => new Promise<Response>((resolve) => { deliver = resolve; }) });
  const result = net.fetchGoogle(await policy(() => live), descriptor)("https://gmail.googleapis.com/test", { signal: abort.signal });
  await vi.waitFor(() => expect(deliver).toBeDefined());
  live = false;
  deliver(new Response(new ReadableStream<Uint8Array>({ start(c) { body = c; } })));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(net.googlePending()).toBe(1);
  if (aborted) abort.abort();
  body.error(new Error("synthetic body failure"));
  await expect.poll(() => net.googlePending()).toBe(0);
});

it("a retired response whose request is aborted mid-drain is cancelled and frees its slot", async () => {
  let live = true;
  let deliver!: (response: Response) => void;
  let cancelled = 0;
  const abort = new AbortController();
  const net = createNetworkPolicy({ fetch: async () => new Promise<Response>((resolve) => { deliver = resolve; }) });
  const result = net.fetchGoogle(await policy(() => live), descriptor)("https://gmail.googleapis.com/test", { signal: abort.signal });
  await vi.waitFor(() => expect(deliver).toBeDefined());
  live = false;
  deliver(new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel() { cancelled++; } })));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(net.googlePending()).toBe(1);
  abort.abort();
  await expect.poll(() => net.googlePending()).toBe(0);
  expect(cancelled).toBe(1);
});

it("releases a retired response with no native body", async () => {
  let live = true;
  let deliver!: (response: Response) => void;
  const net = createNetworkPolicy({ fetch: async () => new Promise<Response>((resolve) => { deliver = resolve; }) });
  const result = net.fetchGoogle(await policy(() => live), descriptor)("https://gmail.googleapis.com/test");
  await vi.waitFor(() => expect(deliver).toBeDefined());
  live = false;
  deliver(new Response(null, { status: 204 }));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(net.googlePending()).toBe(0);
});

it("bounds overflow disposal and releases only a proven native terminal before repeated recovery", async () => {
  const { readResponseText } = await import("../../mail/src/http-body");
  const net = createNetworkPolicy({ fetch: async (input) => {
    expect(input).toBeInstanceOf(Request);
    let sent = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) {
      if (++sent > 20) c.close();
      else c.enqueue(new Uint8Array(16_384));
    } }));
  } });
  const request = net.fetchGoogle(await policy(), descriptor);
  for (let i = 0; i < 65; i++) {
    const response = await request("https://gmail.googleapis.com/history");
    await expect(readResponseText(response, 256 * 1024, new AbortController().signal)).rejects.toMatchObject({ name: "ResponseBodyLimitError" });
    await expect.poll(() => net.googlePending()).toBe(0);
  }
  const response = await request("https://gmail.googleapis.com/recovered");
  await response.arrayBuffer();
  expect(net.googlePending()).toBe(0);
});

it("cancels an over-limit body at once: no tail is read, and the slot comes back (plan 262)", async () => {
  const { readResponseText } = await import("../../mail/src/http-body");
  let reads = 0, canceled = false;
  const net = createNetworkPolicy({ fetch: async () => new Response(new ReadableStream<Uint8Array>({
    pull(c) { reads++; if (reads <= 33) c.enqueue(new Uint8Array(16_384)); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 })) });
  const response = await net.fetchGoogle(await policy(), descriptor)("https://gmail.googleapis.com/history");
  await expect(readResponseText(response, 256 * 1024, new AbortController().signal)).rejects.toMatchObject({ name: "ResponseBodyLimitError" });
  await expect.poll(() => net.googlePending()).toBe(0);
  expect(reads).toBe(17); // 16 chunks fill the limit, the 17th crosses it; a stalled tail could hold the slot for good
  expect(canceled).toBe(true);
});

it("Node's own fetch on loopback: an abort before headers and one mid-body both give the slot back (plan 262)", async () => {
  const { createServer } = await import("node:http");
  const responses = new Set<import("node:http").ServerResponse>();
  const server = createServer((req, res) => {
    responses.add(res);
    if (req.url === "/stream") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.write(new Uint8Array(1024)); }
    // "/hang": no answer at all
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  try {
    const net = createNetworkPolicy({ fetch: globalThis.fetch });
    const request = net.fetchGoogle(await policy(), { ...descriptor, admission: "background" });
    const before = new AbortController();
    const hanging = request(`http://127.0.0.1:${port}/hang`, { signal: before.signal });
    await vi.waitFor(() => expect(responses.size).toBe(1));
    expect(net.googlePending()).toBe(1);
    before.abort();
    await expect(hanging).rejects.toMatchObject({ name: "AbortError" });
    expect(net.googlePending()).toBe(0);
    const during = new AbortController();
    const response = await request(`http://127.0.0.1:${port}/stream`, { signal: during.signal });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(net.googlePending()).toBe(1);
    during.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => net.googlePending()).toBe(0);
  } finally {
    for (const res of responses) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

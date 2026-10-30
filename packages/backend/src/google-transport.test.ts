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
  const net = createNetworkPolicy({ localMode: () => true, fetch: async (input) => { sent.push(input as Request); return new Response("{}"); } });
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

it("holds one shared bounded physical pool through body EOF; cancel is not completion", async () => {
  const transport = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel() {} })));
  const net = createNetworkPolicy({ localMode: () => true, fetch: transport });
  const fetchA = net.fetchGoogle(await policy(), descriptor), fetchB = net.fetchGoogle(await policy(), descriptor);
  const responses: Response[] = [];
  for (let i = 0; i < 64; i++) responses.push(await (i % 2 ? fetchA : fetchB)("https://gmail.googleapis.com/test"));
  expect(net.googlePending()).toBe(64);
  await responses[0]!.body!.cancel();
  expect(net.googlePending()).toBe(64);
  await expect(fetchA("https://gmail.googleapis.com/denied")).rejects.toBeInstanceOf(ProviderCooldownError);
  expect(transport).toHaveBeenCalledTimes(64);
  await Promise.all(responses.slice(1).map((r) => r.body!.cancel()));
});


it.each([200, 429])("drains a retired %s response without publishing headers and retains capacity until native EOF", async (status) => {
  let live = true;
  let resolveResponse!: (response: Response) => void;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const headers = vi.fn();
  let signal: AbortSignal | undefined;
  const net = createNetworkPolicy({ localMode: () => true, fetch: async (input) => {
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


it.each([false, true])("retired body failure releases capacity only without request abort (aborted=%s)", async (aborted) => {
  let live = true;
  let deliver!: (response: Response) => void;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const abort = new AbortController();
  const net = createNetworkPolicy({ localMode: () => true, fetch: async () => new Promise<Response>((resolve) => { deliver = resolve; }) });
  const result = net.fetchGoogle(await policy(() => live), descriptor)("https://gmail.googleapis.com/test", { signal: abort.signal });
  await vi.waitFor(() => expect(deliver).toBeDefined());
  live = false;
  deliver(new Response(new ReadableStream<Uint8Array>({ start(c) { body = c; } })));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(net.googlePending()).toBe(1);
  if (aborted) abort.abort();
  body.error(new Error("synthetic body failure"));
  if (aborted) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(net.googlePending()).toBe(1);
  } else await expect.poll(() => net.googlePending()).toBe(0);
});

it("releases a retired response with no native body", async () => {
  let live = true;
  let deliver!: (response: Response) => void;
  const net = createNetworkPolicy({ localMode: () => true, fetch: async () => new Promise<Response>((resolve) => { deliver = resolve; }) });
  const result = net.fetchGoogle(await policy(() => live), descriptor)("https://gmail.googleapis.com/test");
  await vi.waitFor(() => expect(deliver).toBeDefined());
  live = false;
  deliver(new Response(null, { status: 204 }));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(net.googlePending()).toBe(0);
});

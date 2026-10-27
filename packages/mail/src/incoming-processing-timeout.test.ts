import { afterEach, expect, it, vi } from "vitest";
import { createIncomingProcessor, type IncomingProcessor, type IncomingWorkerEvents, type IncomingWorkerHost, type IncomingWorkerRequest } from "./incoming-processing";

const processors: IncomingProcessor[] = [];
const release: (() => void)[] = [];
afterEach(async () => {
  for (const done of release.splice(0)) done();
  for (const processor of processors.splice(0)) await processor.close();
  vi.useRealTimers();
});
const input = () => ({ kind: "mime" as const, chunks: [new Uint8Array([65])] });
const result = { kind: "mime", message: { attachments: [] } };
const turn = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

it("times out active work once and holds readiness until that captured worker retires", async () => {
  vi.useFakeTimers();
  let retired!: () => void;
  const retirement = new Promise<void>((resolve) => { retired = resolve; });
  release.push(() => retired());
  const hosts: { events: IncomingWorkerEvents; request?: IncomingWorkerRequest; terminate: ReturnType<typeof vi.fn> }[] = [];
  const factory = vi.fn((events: IncomingWorkerEvents): IncomingWorkerHost => {
    const state = { events, request: undefined as IncomingWorkerRequest | undefined, terminate: vi.fn(() => hosts.length === 1 ? retirement : undefined) };
    hosts.push(state);
    return { postMessage: (request, transfer) => { state.request = structuredClone(request, { transfer }); }, terminate: state.terminate };
  });
  const processor = createIncomingProcessor(factory, { jobTimeoutMs: 10 });
  processors.push(processor);
  expect(vi.getTimerCount()).toBe(0);
  const signal = new AbortController().signal;
  const remove = vi.spyOn(signal, "removeEventListener");
  const outcome = processor.run(input(), signal).catch((error: unknown) => error);
  expect(vi.getTimerCount()).toBe(1);
  expect(hosts[0]!.request?.limits).not.toHaveProperty("jobTimeoutMs");
  await vi.advanceTimersByTimeAsync(10);
  expect(await outcome).toMatchObject({ code: "worker-timeout", message: "Incoming processing failed (worker-timeout)" });
  expect(remove).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  const idle = processor.whenIdle();
  expect(processor.whenIdle()).toBe(idle);
  let available = false;
  void idle.then(() => { available = true; });
  const first = hosts[0]!.request!;
  hosts[0]!.events.message({ type: "result", incarnation: first.incarnation, job: first.job, result });
  await turn();
  expect(available).toBe(false);
  await expect(processor.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-busy" });
  expect(factory).toHaveBeenCalledOnce();
  retired();
  await idle;
  const next = processor.run(input(), new AbortController().signal);
  const second = hosts[1]!.request!;
  hosts[1]!.events.message({ type: "result", incarnation: second.incarnation, job: second.job, result });
  await next;
  expect(hosts[0]!.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("starts the active budget before async factory startup and fences a late-created host", async () => {
  vi.useFakeTimers();
  let ready!: (host: IncomingWorkerHost) => void;
  const factory = vi.fn(() => new Promise<IncomingWorkerHost>((resolve) => { ready = resolve; }));
  const processor = createIncomingProcessor(factory, { jobTimeoutMs: 20 });
  processors.push(processor);
  const postMessage = vi.fn();
  const terminate = vi.fn();
  release.push(() => ready({ postMessage, terminate }));
  const outcome = processor.run(input(), new AbortController().signal).catch((error: unknown) => error);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(20);
  expect(await outcome).toMatchObject({ code: "worker-timeout" });
  const idle = processor.whenIdle();
  let available = false;
  void idle.then(() => { available = true; });
  await turn();
  expect(available).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  ready({ postMessage, terminate });
  await idle;
  expect(terminate).toHaveBeenCalledOnce();
  expect(postMessage).not.toHaveBeenCalled();
});

it.each(["result", "error", "abort", "close"])("clears the active timer after %s and keeps idle timer-free", async (finish) => {
  vi.useFakeTimers();
  let events!: IncomingWorkerEvents;
  let request!: IncomingWorkerRequest;
  const processor = createIncomingProcessor((received) => {
    events = received;
    return { postMessage: (value) => { request = value; }, terminate: () => {} };
  });
  processors.push(processor);
  const abort = new AbortController();
  const pending = processor.run(input(), abort.signal).catch((error: unknown) => error);
  expect(vi.getTimerCount()).toBe(1);
  if (finish === "abort") abort.abort();
  else if (finish === "close") await processor.close();
  else events.message({ type: finish, incarnation: request.incarnation, job: request.job, ...(finish === "result" ? { result } : { code: "malformed-json" }) });
  await pending;
  await processor.whenIdle();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses a30second active default and never allocates a timer before demand", async () => {
  vi.useFakeTimers();
  const terminate = vi.fn();
  const processor = createIncomingProcessor(() => ({ postMessage: () => {}, terminate }));
  processors.push(processor);
  expect(vi.getTimerCount()).toBe(0);
  let settled = false;
  const outcome = processor.run(input(), new AbortController().signal).catch((error: unknown) => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await outcome).toMatchObject({ code: "worker-timeout" });
  await processor.whenIdle();
  expect(terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects an invalid active budget %s before allocating a host", (jobTimeoutMs) => {
  const factory = vi.fn();
  expect(() => createIncomingProcessor(factory, { jobTimeoutMs })).toThrowError(expect.objectContaining({ code: "input-limit" }));
  expect(factory).not.toHaveBeenCalled();
});

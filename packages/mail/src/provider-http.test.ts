import { fixtureCleanup, type ExpectedTerminal } from "../../backend/src/provider-cooldown.test-utils";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as nativeTimeout, clearTimeout as clearNativeTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderCooldown, ProviderCooldownError, type CooldownPersistence } from "../../backend/src/provider-cooldown";
import { requestHttp } from "./provider-http";
import type { RequestDescriptor } from "./types";
const A = "a".repeat(64), B = "b".repeat(64);
const gmail: RequestDescriptor = { request: { endpoint: "gmail-api", purpose: "mail" } };
const userinfo: RequestDescriptor = { request: { endpoint: "google-userinfo", purpose: "photos" } };

const cleanup = fixtureCleanup();
beforeEach(() => cleanup.assertAvailable());
afterEach(() => cleanup.finish());
function latch<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function memory(): CooldownPersistence {
  let value: string | null = null;
  return { read: async () => value, update: async (fn) => { const next = fn(value); value = next.encoded; return next.result; } };
}
async function wire(stalled: boolean, directive?: string) {
  const calls: string[] = [], sockets = new Set<Socket>(), held = new Set<ServerResponse>(), bodies: Response[] = [];
  const abort = new AbortController();
  let stopped = false, stopResult: Promise<void> | undefined;
  let setupTerminal!: () => void;
  const actualSetupTerminal = new Promise<void>((resolve) => { setupTerminal = resolve; });
  let watchdog: ReturnType<typeof nativeTimeout> | undefined;
  const server = createServer((request, response) => {
    if (calls.length >= 8) { abort.abort(new Error("Synthetic request bound")); response.destroy(); return; }
    calls.push(request.url!);
    response.sendDate = false;
    response.writeHead(request.url === "/first" ? 429 : 200, { "content-type": "application/json", ...(directive === undefined ? {} : { "retry-after": directive }) });
    if (stalled) { response.flushHeaders(); response.write("{"); held.add(response); }
    else response.end("{}");
  });
  server.on("connection", (socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    if (stopped) socket.destroy();
  });
  const closeServer = () => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
  const stop = () => stopResult ??= (async () => {
    stopped = true;
    if (watchdog) clearNativeTimeout(watchdog);
    const cancellationsPending = Promise.allSettled(bodies.filter((response) => !response.bodyUsed && !response.body?.locked).map((response) => response.body?.cancel()));
    abort.abort();
    for (const response of held) response.destroy();
    const socketCloses = [...sockets].map((socket) => new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.destroy(); }));
    // A logical setup timeout is not a terminal listen event. Retain this owner until the
    // real listening/error callback arrives; the fixture join can report uncertainty.
    await actualSetupTerminal;
    const closed = closeServer();
    const terminal = await Promise.allSettled([...socketCloses, closed]);
    const cancellations = await cancellationsPending;
    const cancelFailures = cancellations.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (cancelFailures.length) throw new AggregateError(cancelFailures.map((result) => result.reason), "Synthetic body cancellation failed");
    const failures = terminal.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Synthetic server cleanup failed");
    expect(sockets.size).toBe(0);
  })();
  // Registration precedes listen/setup, including every setup failure branch.
  cleanup.independent("HTTP/server", stop);
  server.once("listening", setupTerminal);
  server.once("error", setupTerminal);
  server.on("error", (error) => { cleanup.fault(error); });
  let rejectSetup!: (error: unknown) => void;
  const listening = new Promise<void>((resolve, reject) => {
    rejectSetup = reject;
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError); server.once("listening", onListening);
    try { server.listen(0, "127.0.0.1"); }
    catch (error) { server.off("error", onError); server.off("listening", onListening); setupTerminal(); reject(error); }
  });
  watchdog = nativeTimeout(() => {
    const error = new Error("Synthetic HTTP native watchdog");
    abort.abort(error); rejectSetup(error);
    cleanup.fault(error);
    void stop().catch((failure: unknown) => { cleanup.fault(failure); });
  }, 5000);
  await listening;
  const address = server.address();
  if (!address || typeof address === "string" || stopped) throw new Error("No synthetic HTTP port");
  return { calls, fetch: async (path: string) => { const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { signal: abort.signal }); bodies.push(response); return response; } };
}

async function open(port = memory(), changed?: () => void, expected?: ExpectedTerminal) {
  const gate = await cleanup.watch("mail/open", ProviderCooldown.open(port, { wallNow: () => 1000, elapsedNow: () => 10, random: () => 0.5 }, { changed }));
  cleanup.gate(expected?.label ?? "mail/healthy-close", gate, expected);
  return gate;
}
for (const mode of ["complete", "stalled"] as const) {
  describe(`request headers ${mode}`, () => {
    it("01 second HTTP never dispatches", async () => {
      const t = await wire(mode === "stalled", "120"), g = await open(), p = g.requestsFor(A);
      const first = await requestHttp(p, gmail, () => t.fetch("/first"), () => 1000);
      expect(first.status).toBe(429);
      await expect(requestHttp(p, gmail, () => t.fetch("/second"), () => 1000)).rejects.toBeInstanceOf(ProviderCooldownError);
      expect(t.calls).toEqual(["/first"]);
    });
    it("02 bad header uses finite fallback", async () => {
      const t = await wire(mode === "stalled", "bad date"), g = await open();
      const response = await requestHttp(g.requestsFor(A), gmail, () => t.fetch("/first"), () => 1000);
      expect(response.status).toBe(429);
      expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
      expect(t.calls).toEqual(["/first"]);
    });
    it("03 zero keeps finite sampled floor", async () => {
      const t = await wire(mode === "stalled", "0"), g = await open();
      await requestHttp(g.requestsFor(A), gmail, () => t.fetch("/first"), () => 1000);
      expect(g.state(A, "gmail-api")).toEqual({ kind: "at", atMs: 3000 });
    });
    it("04 other mailbox still dispatches", async () => {
      const t = await wire(mode === "stalled", "120"), g = await open();
      await requestHttp(g.requestsFor(A), gmail, () => t.fetch("/first"), () => 1000);
      const response = await requestHttp(g.requestsFor(B), gmail, () => t.fetch("/other"), () => 1000);
      expect(response.status).toBe(200);
      expect(t.calls).toEqual(["/first", "/other"]);
    });
    it("05 other service still dispatches", async () => {
      const t = await wire(mode === "stalled", "120"), g = await open();
      await requestHttp(g.requestsFor(A), gmail, () => t.fetch("/first"), () => 1000);
      const response = await requestHttp(g.requestsFor(A), userinfo, () => t.fetch("/userinfo"), () => 1000);
      expect(response.status).toBe(200);
      expect(t.calls).toEqual(["/first", "/userinfo"]);
    });
    it("06 pending commit already blocks", async () => {
      const port = memory(), held = latch<void>(), observed = latch<void>();
      cleanup.release(() => held.resolve());
      const t = await wire(mode === "stalled", "120");
      const g = await open({ read: port.read, update: async (fn) => { await held.promise; return port.update(fn); } }, () => observed.resolve());
      let knownStatus: number | null = null;
      const first = cleanup.watch("HTTP06/pending-response", requestHttp(g.requestsFor(A), { ...gmail, onHeaders: (status) => { knownStatus = status; } }, () => t.fetch("/first"), () => 1000));
      await observed.promise;
      expect(knownStatus).toBe(429);
      await expect(requestHttp(g.requestsFor(A), gmail, () => t.fetch("/second"), () => 1000)).rejects.toBeInstanceOf(ProviderCooldownError);
      expect(t.calls).toEqual(["/first"]);
      expect(g.resources().writer).toBe(true);
      held.resolve();
      expect((await first).status).toBe(429);
    });
    it("07 storage failure preserves 429", async () => {
      const t = await wire(mode === "stalled", "120"), port = memory();
      const expected = cleanup.expectTerminal(`HTTP07/${mode}/disk-unconfirmed`);
      const g = await open({ read: port.read, update: async () => { throw new Error("Synthetic disk failure"); } }, undefined, expected);
      const response = await requestHttp(g.requestsFor(A), gmail, () => t.fetch("/first"), () => 1000);
      expect(response.status).toBe(429);
      expect(g.state(A, "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
      expect(t.calls).toEqual(["/first"]);
    });
    it("08 final race retains run ownership", async () => {
      const t = await wire(mode === "stalled", "120"), g = await open(), p = g.requestsFor(A);
      let marked = 0;
      const ticket = p.reserve({ ...gmail, run: { markDispatched: () => { marked++; } } });
      await requestHttp(p, gmail, () => t.fetch("/first"), () => 1000);
      expect(() => ticket.dispatch(() => t.fetch("/second"))).toThrow(ProviderCooldownError);
      ticket.release();
      expect(marked).toBe(0);
      expect(t.calls).toEqual(["/first"]);
    });
  });
}

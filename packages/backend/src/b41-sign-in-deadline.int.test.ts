import { expect, it, vi } from "vitest";
import { inspectGmailToken } from "../../mail/src/gmail-web";
import { ProviderCooldown } from "./provider-cooldown";
import { createNetworkPolicy } from "./net-policy";
import { COOLDOWN_TICKETS, decodeCooldown } from "@terno/store";

const profile = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const descriptor = { request: { endpoint: "gmail-api", purpose: "identity-proof" } } as const;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it.each([
  ["cancel", "commit"], ["deadline", "commit"], ["cancel", "failure"], ["deadline", "failure"],
] as const)("stalled durable structured403 settlement releases logical sign-in on %s with late %s while retaining its ticket", async (stop, terminal) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const started = deferred(), persist = deferred(), headers = deferred();
  let raw: string | null = null, writes = 0, writing = false;
  const gate = await ProviderCooldown.open({
    read: async () => raw,
    update: async (fn) => {
      writes++; writing = true; started.resolve();
      await persist.promise;
      writing = false;
      if (terminal === "failure") throw new Error("Synthetic durable write failed");
      const next = fn(raw); raw = next.encoded;
      return next.result;
    },
  }, { wallNow: () => 1_800_000_000_000, elapsedNow: () => 1000, random: () => 0.5 });
  const policy = gate.requestsFor("installation");
  const transport = vi.fn<typeof fetch>(async (input) => {
    expect(input).toBeInstanceOf(Request);
    expect((input as Request).url).toBe(profile);
    await headers.promise;
    return new Response(JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }), { status: 403, headers: { "retry-after": "120" } });
  });
  const net = createNetworkPolicy({ localMode: () => true, fetch: transport });
  const abort = new AbortController();
  let finished = false;
  const result = inspectGmailToken("synthetic-stalled-settlement", async () => { throw new Error("Unexpected unmanaged request"); }, {
    signal: abort.signal,
    google: { request: (d, input, init) => net.fetchGoogle(policy, d)(input, init) },
  }).then(() => { throw new Error("Unexpected sign-in success"); }, (error: unknown) => { finished = true; return error; });
  const other = gate.requestsFor("a".repeat(64));
  const held: ReturnType<typeof other.reserve>[] = [];
  try {
    if (stop === "deadline") await vi.advanceTimersByTimeAsync(29_000);
    headers.resolve();
    await started.promise;
    expect(writes).toBe(1);
    expect(writing).toBe(true);
    expect(raw).toBe(null);
    expect(net.googlePending()).toBe(0); // This response already proved native body EOF.
    expect(gate.state("installation", "gmail-api").kind).toBe("at");
    // The quota ticket remains owned across logical cancellation and an unfinished write.
    for (let n = 0; n < COOLDOWN_TICKETS - 1; n++) held.push(other.reserve(descriptor));
    expect(() => other.reserve(descriptor)).toThrow();
    if (stop === "cancel") abort.abort();
    else await vi.advanceTimersByTimeAsync(1000); // Exactly the unchanged 30-second default, before the write's five-second notice.
    await turn();
    expect(writing).toBe(true);
    expect(writes).toBe(1);
    expect(() => other.reserve(descriptor)).toThrow();
    expect(finished).toBe(true);
    expect(await result).toMatchObject({ i18n: { key: stop === "cancel" ? "errors.google.cancelled" : "errors.google.timedOut" } });
  } finally {
    headers.resolve(); persist.resolve();
    await result;
    expect(await gate.drain()).toBe(terminal === "commit" ? "drained" : "pending-terminal");
    expect(writing).toBe(false);
    expect(writes).toBe(1);
    if (terminal === "commit") {
      expect(decodeCooldown(raw).rows).toHaveLength(1);
      expect(gate.state("installation", "gmail-api").kind).toBe("at");
      const released = other.reserve(descriptor);
      released.release();
    } else {
      expect(raw).toBe(null);
      expect(gate.state("installation", "gmail-api")).toEqual({ kind: "hold", reason: "storage" });
      expect(() => other.reserve(descriptor)).toThrow();
    }
    for (const ticket of held) ticket.release();
    policy.close(); other.close();
    if (terminal === "commit") await gate.close();
    else await expect(gate.close()).rejects.toThrow("Private cooldown persistence remains unconfirmed");
    vi.useRealTimers();
  }
  expect(transport).toHaveBeenCalledOnce();
});

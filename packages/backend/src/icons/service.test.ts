/**
 * Plan 22, the service end to end on a real backend: zero requests when the defaults say so,
 * fetching only what visible avatars ask for, the network and invalidation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type IconAnswer, type IconRef } from "@terno/core/rpc";
import { sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pngBytes } from "../test/icons-fixtures";
import { Backend, plaintextCipher } from "../backend";
import { seedDemo } from "../demo";
import { exportMailbox, importMailbox } from "../import";
import { NetworkPolicyError } from "../net-policy";
import { readSettings } from "../settings";
import type { IconRequest, IconResponse, IconTransport } from "./transport";
import { IconNetworkError } from "./transport";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A transport that records every request: favicons for the domains it knows, 404 for the rest; `hold` delays answers. */
function stubTransport(o: { known?: (host: string) => boolean; hold?: Promise<void> | null; fail?: () => Error | null } = {}) {
  const calls: string[] = [];
  const t: IconTransport & { calls: string[]; hold: Promise<void> | null; fail: (() => Error | null) | undefined } = {
    calls,
    hold: o.hold ?? null,
    fail: o.fail,
    async get(r: IconRequest): Promise<IconResponse> {
      calls.push(r.url.href);
      if (t.hold) await Promise.race([t.hold, new Promise((_, rej) => r.signal.addEventListener("abort", () => rej(new IconNetworkError("network", "aborted")), { once: true }))]);
      const err = t.fail?.();
      if (err) throw err;
      if (r.url.pathname === "/favicon.ico" && (o.known ?? (() => true))(r.url.hostname)) return { status: 200, location: null, bytes: pngBytes(32), tooLarge: false };
      return { status: 404, location: null, bytes: null, tooLarge: false };
    },
  };
  return t;
}

async function setup(o: { transport?: IconTransport; seed?: boolean; online?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-icons-"));
  const transport = o.transport ?? stubTransport();
  const backend = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, iconTransport: transport, online: o.online });
  if (o.seed !== false) await seedDemo(backend.store, { threads: 300, accounts: 4 });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  const events: { icons: Record<string, IconAnswer>; reset?: boolean }[] = [];
  client.on("icons", (e) => events.push(e));
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const senders = sqlDb(backend.store).all<{ e: string }>("SELECT DISTINCT from_email AS e FROM messages").map((r) => r.e);
  return { backend, client, transport: transport as ReturnType<typeof stubTransport>, events, senders, dir };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
async function until(f: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !f(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await settle();
  }
}

describe("sender icons, privacy defaults (plan 22)", () => {
  it("local mode with website icons turned off sends nothing anywhere: every sender asked about, zero requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client, transport, senders } = await setup();
    await client.call("settings.update", { senderIcons: false });
    expect(senders.length).toBeGreaterThan(30);
    for (let i = 0; i < senders.length; i += 200) {
      const answers = await client.call("icons.lookup", { emails: senders.slice(i, i + 200) });
      expect(Object.values(answers).every((a) => a === null)).toBe(true);
    }
    await settle();
    expect(transport.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await client.call("app.bootstrap", {})).settings.senderIcons).toBe(false);
  });

  it("connected mode with website icons turned off sends nothing either", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client, transport, senders } = await setup();
    await client.call("settings.update", { localMode: false, senderIcons: false });
    await client.call("icons.lookup", { emails: senders.slice(0, 200) });
    await settle();
    expect(transport.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("on by default in either mode; turning it off sticks across modes; an import never turns it on", async () => {
    const { backend, client } = await setup({ seed: false });
    expect((await readSettings(backend.store)).localMode).toBe(true);
    expect((await readSettings(backend.store)).senderIcons).toBe(true);
    expect((await client.call("settings.update", { localMode: false })).senderIcons).toBe(true);
    expect((await client.call("settings.update", { localMode: true })).senderIcons).toBe(true);
    // the one tap off
    expect((await client.call("settings.update", { senderIcons: false })).senderIcons).toBe(false);
    expect((await client.call("settings.update", { localMode: false })).senderIcons).toBe(false);
    expect((await client.call("settings.update", { localMode: true })).senderIcons).toBe(false);
    const file = await exportMailbox(backend);
    await importMailbox(backend, { ...file, settings: { ...file.settings, senderIcons: true } });
    expect((await readSettings(backend.store)).senderIcons).toBe(false);
    await client.call("settings.update", { senderIcons: true });
    await importMailbox(backend, { ...file, settings: { ...file.settings, senderIcons: false } });
    expect((await readSettings(backend.store)).senderIcons).toBe(false);
  });

  it("the policy allows purpose icons only when the setting does: by default in local mode too, never once turned off", async () => {
    const { backend, client } = await setup({ seed: false });
    await expect(backend.net.assert("icons", "https://netflix.com/")).resolves.toEqual({});
    await client.call("settings.update", { senderIcons: false });
    await expect(backend.net.assert("icons", "https://netflix.com/")).rejects.toBeInstanceOf(NetworkPolicyError);
    await client.call("settings.update", { senderIcons: true });
    await expect(backend.net.assert("icons", "https://netflix.com/")).resolves.toEqual({});
    await client.call("settings.update", { localMode: false, senderIcons: false });
    await expect(backend.net.assert("icons", "https://netflix.com/")).rejects.toBeInstanceOf(NetworkPolicyError);
  });
});

describe("sender icons, fetching (plan 22)", () => {
  it("one request chain per registrable domain, none for freemail; refs arrive by event and their bytes as data: URLs", async () => {
    const { client, transport, events } = await setup({ seed: false });
    await client.call("settings.update", { senderIcons: true });
    const emails = ["info@mail.netflix.com", "no-reply@netflix.com", "Account@NETFLIX.com", "ana@gmail.com", "bob@outlook.com"];
    const first = await client.call("icons.lookup", { emails });
    expect(first).toEqual({ "ana@gmail.com": null, "bob@outlook.com": null });
    await until(() => Object.keys(Object.assign({}, ...events.map((e) => e.icons))).length === 3);
    const got = Object.assign({}, ...events.map((e) => e.icons)) as Record<string, IconRef>;
    expect(new Set(Object.values(got).map((r) => r.id))).toEqual(new Set(["d:netflix.com"]));
    expect(got["info@mail.netflix.com"]).toMatchObject({ kind: "site", px: 32, full: false });
    expect(transport.calls).toEqual(["https://netflix.com/", "https://netflix.com/favicon.ico"]);
    // answered from memory now, nothing fetched again
    expect(await client.call("icons.lookup", { emails: ["x@netflix.com"] })).toEqual({ "x@netflix.com": got["info@mail.netflix.com"] });
    expect(transport.calls).toHaveLength(2);
    const data = await client.call("icons.data", { ids: ["d:netflix.com", "d:nope.com"] });
    expect(data["d:netflix.com"]).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(data["d:nope.com"]).toBeNull();
  });

  it("a site without an icon is remembered as such (no refetch); answers in microseconds from memory for 200 addresses", async () => {
    const { client, transport, events } = await setup({ seed: false, transport: stubTransport({ known: () => false }) });
    await client.call("settings.update", { senderIcons: true });
    await client.call("icons.lookup", { emails: ["a@plain.com"] });
    await until(() => events.some((e) => "a@plain.com" in e.icons));
    expect(events.find((e) => "a@plain.com" in e.icons)!.icons["a@plain.com"]).toBeNull();
    expect(await client.call("icons.lookup", { emails: ["b@plain.com"] })).toEqual({ "b@plain.com": null });
    expect(transport.calls).toHaveLength(2);
  });

  it("offline nothing starts; an unreachable site is retried when the network comes back", async () => {
    let down = true;
    const transport = stubTransport({ fail: () => (down ? new IconNetworkError("network", "ECONNREFUSED") : null) });
    const { backend, client, events } = await setup({ seed: false, transport });
    await client.call("settings.update", { senderIcons: true });
    backend.icons.network(false);
    await client.call("icons.lookup", { emails: ["a@site.com"] });
    await settle();
    expect(transport.calls).toEqual([]);
    backend.icons.network(true);
    await until(() => transport.calls.length > 0);
    await settle();
    // unreachable: nothing cached, nothing answered (the initials stay)
    expect(events.some((e) => "a@site.com" in e.icons)).toBe(false);
    down = false;
    backend.icons.network(true);
    await until(() => events.some((e) => (e.icons["a@site.com"] as IconRef | undefined)?.id === "d:site.com"));
  });

  it("turning website icons off mid-fetch: the late result is dropped and the windows are told to forget", async () => {
    let release!: () => void;
    const transport = stubTransport({ hold: new Promise<void>((r) => (release = r)) });
    const { backend, client, events } = await setup({ seed: false, transport });
    await client.call("settings.update", { senderIcons: true });
    await client.call("icons.lookup", { emails: ["a@held.com"] });
    await until(() => transport.calls.length === 1);
    await client.call("settings.update", { senderIcons: false });
    await until(() => events.some((e) => e.reset));
    release();
    await settle();
    expect(backend.icons.cache.peek("d:held.com")).toBeUndefined();
    expect(events.some((e) => "a@held.com" in e.icons)).toBe(false);
  });

  it("a full queue tells the dropped addresses to ask again (never left pending)", async () => {
    const transport = stubTransport({ hold: new Promise<void>(() => {}) });
    const { client, events } = await setup({ seed: false, transport });
    await client.call("settings.update", { senderIcons: true });
    const emails = Array.from({ length: 210 }, (_, i) => `x@site${i}.com`);
    // 4 in flight, 200 queued: the 6 oldest of the queue are dropped
    for (let i = 0; i < emails.length; i += 70) await client.call("icons.lookup", { emails: emails.slice(i, i + 70) });
    await until(() => events.flatMap((e) => Object.values(e.icons)).filter((a) => a === "again").length === 6);
  });

  it("forgetting clears every saved icon", async () => {
    const { client, events, backend } = await setup({ seed: false });
    await client.call("settings.update", { senderIcons: true });
    await client.call("icons.lookup", { emails: ["a@one.com"] });
    await until(() => events.some((e) => "a@one.com" in e.icons));
    await client.call("icons.forget", {});
    expect(backend.icons.cache.size.entries).toBe(0);
    expect(events.at(-1)?.reset).toBe(true);
  });

  it("a lookup of 200 addresses is answered from memory: median ≤ 10 ms with 4,000 cached entries (nothing fetched)", async () => {
    const { backend, client, transport } = await setup({ seed: false });
    await client.call("settings.update", { senderIcons: true });
    await backend.icons.lookup([]);
    for (let i = 0; i < 4000; i++) backend.icons.cache.negative(`d:site${i}.com`, Date.now() + 86_400_000);
    const emails = Array.from({ length: 200 }, (_, i) => `someone${i}@mail.site${i * 7}.com`);
    const times: number[] = [];
    for (let run = 0; run < 21; run++) {
      const t = performance.now();
      await backend.icons.lookup(emails);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[10]!).toBeLessThanOrEqual(10);
    expect(transport.calls).toEqual([]);
  });
});

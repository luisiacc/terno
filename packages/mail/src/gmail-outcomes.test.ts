import { afterEach, expect, it, vi } from "vitest";
import { createNetworkPolicy } from "../../backend/src/net-policy";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import type { IncomingMessage } from "@terno/store";
import type { FlagUpdate, GoogleRequests, ProviderContext, ProviderRequests, SyncSink } from "./types";
import { completedGmailCursors } from "./test/gmail-cursor.fixture";

const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\n\r\nExact body"));
const full = (id: string) => ({ id, threadId: `t-${id}`, raw, labelIds: ["INBOX"] });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

function mailbox(respond: (url: URL) => Response | Promise<Response>, initial: unknown = null) {
  const external = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("external fetch forbidden"); });
  const fallback = vi.fn(async () => { throw new Error("unmanaged fetch forbidden"); });
  const requests: URL[] = [], checkpoints: unknown[] = [], removals: number[] = [], updates: FlagUpdate[] = [];
  const rows = new Map<string, { id: number; providerMsgId: string; bytes: string; labels: string[] }>();
  let cursor = initial, refuseIngest = false, reservations = 0, needsProof = false;
  const pending = new Set<string>();
  const net = createNetworkPolicy({ localMode: () => true, fetch: async (input, init) => {
    expect(input).toBeInstanceOf(Request);
    expect(init).toBeUndefined();
    const request = input as Request;
    const url = new URL(request.url);
    expect(url.origin).toBe("https://gmail.googleapis.com");
    expect(url.pathname.startsWith("/gmail/v1/users/me/")).toBe(true);
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic");
    requests.push(url);
    return respond(url);
  } });
  const policy: ProviderRequests = {
    check() {}, reserve(descriptor) {
      reservations++;
      return { request: descriptor.request, dispatch: (transport) => transport(), headers() {},
        headers429: async () => "committed", release() { reservations--; } };
    }, accessAvailable() {}, tokenUnavailable() {}, close() {},
  };
  const ctx = {
    account: { id: 1, email: "me@example.test" }, config: {}, fetch: fallback,
    google: { check() {}, generation: () => 1, prove: async (read) => { if (needsProof) { await read(); needsProof = false; } },
      request: (descriptor, input, init) => net.fetchGoogle(policy, descriptor)(input, init),
      accessAvailable() {}, tokenUnavailable() {} } satisfies GoogleRequests,
    store: {
      messageByProviderId: async (id: string) => rows.get(id),
      syncedMessagePage: async (after = "") => {
        const items = [...rows.values()].filter((row) => row.providerMsgId > after).sort((a, b) => a.providerMsgId.localeCompare(b.providerMsgId)).slice(0, 50);
        return { items, next: items.at(-1)?.providerMsgId };
      }, pendingAttachmentBodies: async () => [...pending].flatMap((id) => rows.has(id) ? [rows.get(id)!] : []),
    },
    loadCursor: async () => cursor,
    saveCursor: async (value: unknown) => { cursor = structuredClone(value); checkpoints.push(structuredClone(value)); },
  };
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest(batch: IncomingMessage[]) {
      if (refuseIngest) throw new Error("synthetic sink refusal");
      for (const m of batch) rows.set(m.providerMsgId!, { id: rows.get(m.providerMsgId!)?.id ?? rows.size + 1, providerMsgId: m.providerMsgId!, bytes: m.bodyText!, labels: m.gmailLabels ?? [] });
      for (const m of batch) pending.delete(m.providerMsgId!);
    },
    async updateFlags(batch) { updates.push(...batch); for (const update of batch) {
      const row = [...rows.values()].find((r) => r.id === update.messageId)!;
      row.labels = update.gmailLabels!;
    } },
    async removeMessages(ids) { removals.push(...ids); for (const [key, row] of rows) if (ids.includes(row.id)) rows.delete(key); },
    async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const provider = createGmailApiProvider(ctx as unknown as ProviderContext, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  cleanup.push(async () => {
    await provider.close();
    expect(reservations).toBe(0); expect(net.googlePending()).toBe(0);
    expect(external).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });
  return { sync: () => provider.sync(sink), rows, requests, checkpoints, removals, updates,
    pending, set needsProof(value: boolean) { needsProof = value; },
    get cursor() { return cursor; }, set refuseIngest(value: boolean) { refuseIngest = value; } };
}

it.each(["missing", "foreign", 403, 429, 503] as const)("retains cached bytes and history on incomplete minimal outcome %s, then replays", async (failure) => {
  let broken = true;
  const box = mailbox((url) => {
    if (url.pathname.endsWith("/history")) return Response.json({ historyId: "12", history: [{ labelsAdded: [{ message: { id: "kept" } }, { message: { id: "kept" } }] }] });
    expect(url.pathname.endsWith("/messages/kept")).toBe(true);
    expect(url.searchParams.get("format")).toBe("minimal");
    if (broken) return typeof failure === "number" ? new Response(null, { status: failure }) : Response.json(failure === "missing" ? {} : { id: "foreign" });
    return Response.json({ id: "kept", labelIds: ["STARRED"] });
  }, { historyId: "10" });
  const cached = { id: 7, providerMsgId: "kept", bytes: "cached exact bytes", labels: ["INBOX"] };
  box.rows.set("kept", structuredClone(cached));
  await expect(box.sync()).rejects.toMatchObject({ retryable: failure !== 403 });
  expect(box.rows.get("kept")).toEqual(cached);
  expect(box.removals).toEqual([]); expect(box.updates).toEqual([]); expect(box.checkpoints).toEqual([]);
  broken = false;
  await box.sync();
  expect(box.rows.get("kept")).toEqual({ ...cached, labels: ["STARRED"] });
  expect(box.checkpoints).toEqual([{ historyId: "12" }]);
  expect(box.requests.filter((u) => u.pathname.endsWith("/history")).map((u) => u.searchParams.get("startHistoryId"))).toEqual(["10", "10"]);
  expect(box.requests.filter((u) => u.pathname.endsWith("/messages/kept"))).toHaveLength(2);
});

it.each([200, 404])("list omission plus terminal empty page requires a separate cached GET (%i)", async (status) => {
  const box = mailbox((url) => {
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
    if (url.pathname.endsWith("/messages")) return Response.json(url.searchParams.has("pageToken") ? {} : { nextPageToken: "last" });
    if (url.pathname.endsWith("/history")) return Response.json({ historyId: "11" });
    expect(url.pathname.endsWith("/messages/kept")).toBe(true);
    return status === 404 ? new Response(null, { status }) : Response.json({ id: "kept", labelIds: ["STARRED"] });
  });
  box.rows.set("kept", { id: 7, providerMsgId: "kept", bytes: "cached exact bytes", labels: ["INBOX"] });
  await box.sync();
  expect(box.requests.map((u) => u.pathname.split("/").at(-1))).toEqual(["profile", "messages", "messages", "kept", "history"]);
  expect(box.requests[2]!.searchParams.get("pageToken")).toBe("last");
  expect(box.removals).toEqual(status === 404 ? [7] : []);
  expect(box.rows.get("kept")).toEqual(status === 404 ? undefined : { id: 7, providerMsgId: "kept", bytes: "cached exact bytes", labels: ["STARRED"] });
  expect(completedGmailCursors(box.checkpoints)).toEqual([{ historyId: "11" }]);
});

it.each(["missing", "foreign", 404, 503, "sink"] as const)("resumes the same enumerated page after raw outcome %s", async (failure) => {
  let broken = true;
  const box = mailbox((url) => {
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
    if (url.pathname.endsWith("/messages")) return Response.json(url.searchParams.has("pageToken") ? { messages: [{ id: "later" }] } : { messages: [{ id: "first" }], nextPageToken: "second" });
    if (url.pathname.endsWith("/history")) return Response.json({ historyId: "11" });
    const id = url.pathname.split("/").at(-1)!;
    expect(["first", "later"]).toContain(id);
    if (id === "later" && broken && url.searchParams.get("format") === "raw") {
      if (typeof failure === "number") return new Response(null, { status: failure });
      if (failure !== "sink") return Response.json(failure === "missing" ? {} : full("foreign"));
    }
    return Response.json(full(id));
  });
  // Refuse only the second page's durable effect.
  if (failure === "sink") {
    const original = box.rows.set.bind(box.rows);
    vi.spyOn(box.rows, "set").mockImplementation((key, value) => {
      if (key === "first") box.refuseIngest = true;
      return original(key, value);
    });
  }
  if (failure === 404) {
    await box.sync();
    expect([...box.rows.keys()]).toEqual(["first"]);
    expect(completedGmailCursors(box.checkpoints)).toEqual([{ historyId: "11" }]);
    expect(box.removals).toEqual([]);
    return;
  }
  await expect(box.sync()).rejects.toThrow();
  expect([...box.rows.keys()]).toEqual(["first"]);
  expect(box.rows.get("first")?.bytes).toBe("Exact body\n");
  expect(box.cursor).toMatchObject({ reconciliation: { stage: "enumerate", next: "second", pages: 1 } });
  expect(completedGmailCursors(box.checkpoints)).toEqual([]); expect(box.removals).toEqual([]);
  const boundary = box.requests.length;
  broken = false; box.refuseIngest = false;
  await box.sync();
  expect(box.requests[boundary]!.searchParams.get("pageToken")).toBe("second");
  expect(box.requests.filter((u) => u.pathname.endsWith("/messages/first") && u.searchParams.get("format") === "raw")).toHaveLength(1);
  expect([...box.rows.keys()]).toEqual(["first", "later"]);
  expect(completedGmailCursors(box.checkpoints)).toEqual([{ historyId: "11" }]);
});


it("deduplicates reordered history across pages and applies explicit absence only to its own ID", async () => {
  const box = mailbox((url) => {
    if (url.pathname.endsWith("/history")) {
      expect(url.searchParams.get("startHistoryId")).toBe("10");
      return Response.json(url.searchParams.has("pageToken")
        ? { historyId: "12", history: [{ labelsAdded: [{ message: { id: "kept" } }, { message: { id: "gone" } }] }] }
        : { historyId: "11", nextPageToken: "next", history: [{ labelsRemoved: [{ message: { id: "gone" } }, { message: { id: "kept" } }] }] });
    }
    if (url.pathname.endsWith("/messages/gone")) return new Response(null, { status: 404 });
    expect(url.pathname.endsWith("/messages/kept")).toBe(true);
    return Response.json({ id: "kept", labelIds: ["STARRED"] });
  }, { historyId: "10" });
  box.rows.set("gone", { id: 8, providerMsgId: "gone", bytes: "gone bytes", labels: ["INBOX"] });
  box.rows.set("kept", { id: 7, providerMsgId: "kept", bytes: "kept bytes", labels: ["INBOX"] });
  await box.sync();
  expect(box.requests.map((u) => u.pathname.split("/").at(-1))).toEqual(["history", "history", "gone", "kept"]);
  expect(box.requests[1]!.searchParams.get("pageToken")).toBe("next");
  expect(box.removals).toEqual([8]);
  expect([...box.rows.values()]).toEqual([{ id: 7, providerMsgId: "kept", bytes: "kept bytes", labels: ["STARRED"] }]);
  expect(box.checkpoints).toEqual([{ historyId: "12" }]);
});


it.each(["missing", "foreign", 503, 404] as const)("retains pending attachment recovery except for confirmed raw404: %s", async (failure) => {
  let broken = true;
  const box = mailbox((url) => {
    if (url.pathname.endsWith("/history")) return Response.json({ historyId: "11" });
    expect(url.pathname.endsWith("/messages/kept")).toBe(true);
    expect(url.searchParams.get("format")).toBe("raw");
    if (broken) return typeof failure === "number" ? new Response(null, { status: failure }) : Response.json(failure === "missing" ? {} : full("foreign"));
    return Response.json(full("kept"));
  }, { historyId: "10" });
  const cached = { id: 7, providerMsgId: "kept", bytes: "cached bytes", labels: ["INBOX"] };
  box.rows.set("kept", structuredClone(cached)); box.pending.add("kept");
  if (failure === 404) {
    await box.sync(); expect(box.removals).toEqual([7]); expect(box.rows.size).toBe(0); return;
  }
  await expect(box.sync()).rejects.toMatchObject({ retryable: true });
  // History completed independently; the unresolved body remains discoverable for replay.
  expect(box.cursor).toEqual({ historyId: "11" });
  expect(box.rows.get("kept")).toEqual(cached); expect(box.pending.has("kept")).toBe(true); expect(box.removals).toEqual([]);
  broken = false;
  await box.sync();
  expect(box.rows.get("kept")).toEqual({ ...cached, bytes: "Exact body\n" }); expect(box.pending.size).toBe(0);
});

it("identity-proof profile404 during capture is not message absence", async () => {
  const box = mailbox((url) => {
    if (url.pathname.endsWith("/history")) { box.needsProof = true; return Response.json({ historyId: "11" }); }
    expect(url.pathname.endsWith("/profile")).toBe(true);
    return new Response(null, { status: 404 });
  }, { historyId: "10" });
  const cached = { id: 7, providerMsgId: "kept", bytes: "cached bytes", labels: ["INBOX"] };
  box.rows.set("kept", structuredClone(cached)); box.pending.add("kept");
  await expect(box.sync()).rejects.toMatchObject({ status: 404 });
  expect(box.rows.get("kept")).toEqual(cached); expect(box.pending.has("kept")).toBe(true); expect(box.removals).toEqual([]);
  expect(box.requests.map((u) => u.pathname.split("/").at(-1))).toEqual(["history", "profile"]);
});

it.each(["raw", "minimal", "history", "list", "refresh"] as const)("profile404 cannot impersonate the %s resource", async (phase) => {
  let histories = 0;
  const box = mailbox((url) => {
    if (url.pathname.endsWith("/profile")) {
      if (box.requests.length === 1) return Response.json({ historyId: "10" });
      return new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/history")) {
      histories++;
      if (phase === "minimal") { box.needsProof = true; return Response.json({ historyId: "11", history: [{ labelsAdded: [{ message: { id: "kept" } }] }] }); }
      box.needsProof = true;
      return Response.json({ historyId: "11", nextPageToken: "next" });
    }
    if (url.pathname.endsWith("/messages")) {
      box.needsProof = true;
      return Response.json(phase === "raw" ? { messages: [{ id: "new" }] } : phase === "list" ? { nextPageToken: "next" } : {});
    }
    throw new Error("target GET must not dispatch after proof failure");
  }, ["minimal", "history"].includes(phase) ? { historyId: "10" } : null);
  const cached = { id: 7, providerMsgId: "kept", bytes: "cached bytes", labels: ["INBOX"] };
  box.rows.set("kept", structuredClone(cached));
  await expect(box.sync()).rejects.toMatchObject({ status: 404 });
  expect(box.rows.get("kept")).toEqual(cached); expect(box.removals).toEqual([]);
  expect(completedGmailCursors(box.checkpoints)).toEqual([]);
  expect(box.requests.filter((u) => u.pathname.endsWith("/messages"))).toHaveLength(["raw", "list", "refresh"].includes(phase) ? 1 : 0);
  expect(histories).toBe(["minimal", "history"].includes(phase) ? 1 : 0);
});

it("retains acknowledged neighbors when a later local batch mixes success, absence and failure", async () => {
  let broken = true;
  const box = mailbox((url) => {
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
    if (url.pathname.endsWith("/history")) return Response.json({ historyId: "11" });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: Array.from({ length: 53 }, (_, i) => ({ id: `m${i}` })) });
    const id = url.pathname.split("/").at(-1)!;
    if (id === "m51") return new Response(null, { status: 404 });
    if (id === "m52" && broken) return Response.json({});
    return Response.json(full(id));
  });
  await expect(box.sync()).rejects.toThrow();
  expect(box.rows.size).toBe(50);
  expect([...box.rows.values()].every((r) => r.bytes === "Exact body\n")).toBe(true);
  expect(box.cursor).toMatchObject({ reconciliation: { stage: "enumerate", pages: 0 } });
  expect(box.removals).toEqual([]); expect(completedGmailCursors(box.checkpoints)).toEqual([]);
  broken = false;
  await box.sync();
  expect(box.rows.size).toBe(52); expect(box.rows.has("m51")).toBe(false);
  expect(box.requests.filter((u) => u.pathname.endsWith("/messages/m0") && u.searchParams.get("format") === "raw")).toHaveLength(1);
  expect(completedGmailCursors(box.checkpoints)).toEqual([{ historyId: "11" }]);
});

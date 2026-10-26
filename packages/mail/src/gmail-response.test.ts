import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "@terno/store";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import { ProviderError, type FlagUpdate, type ProviderContext, type SyncSink } from "./types";

const raw = toBase64url(new TextEncoder().encode("From: Sender <sender@example.com>\r\nTo: me@example.com\r\nSubject: Original\r\n\r\nOriginal body"));
const message = { id: "m1", threadId: "t1", raw, labelIds: ["INBOX", "UNREAD"] };

function mailbox(options: { cursor?: unknown; cached?: boolean | number; respond?: (url: URL) => unknown | Promise<unknown>; onIngest?: () => void } = {}) {
  let cursor: unknown = options.cursor ?? null;
  const checkpoints: unknown[] = [];
  const ingested: IncomingMessage[] = [];
  const flags: FlagUpdate[] = [];
  const removed: number[] = [];
  const requests: URL[] = [];
  const methods: string[] = [];
  const cached = Array.from({ length: options.cached === true ? 1 : options.cached || 0 }, (_, i) => ({ id: i + 1, providerMsgId: `m${i + 1}` }));
  const ctx = {
    account: { id: 1, email: "me@example.com" }, config: {},
    store: {
      messageByProviderId: async (id: string) => cached.find((m) => m.providerMsgId === id),
      syncedMessages: async () => cached,
      pendingAttachmentBodies: async () => [],
    },
    loadCursor: async () => cursor,
    saveCursor: async (value: unknown) => { cursor = value; checkpoints.push(value); },
    fetch: async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url);
      methods.push(init?.method ?? "GET");
      // The guard is an oracle for accidental unbounded continuation loops.
      if (requests.length > 20) throw new Error("unexpected continuation loop");
      const value = await options.respond?.(url);
      if (value instanceof Response) return value;
      if (value !== undefined) return Response.json(value);
      if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: "me@example.com", historyId: "10" });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "11", history: [{ labelsAdded: [{ message: { id: "m1" } }] }] });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
      if (url.pathname.endsWith("/messages/m1")) return Response.json(message);
      throw new Error(`unexpected request ${url.pathname}`);
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    ingest: async (messages) => {
      options.onIngest?.();
      ingested.push(...messages);
      for (const m of messages) if (m.providerMsgId && !cached.some((c) => c.providerMsgId === m.providerMsgId)) cached.push({ id: cached.length + 1, providerMsgId: m.providerMsgId });
    },
    updateFlags: async (updates) => { flags.push(...updates); },
    removeMessages: async (ids) => { removed.push(...ids); },
    setBody: async () => {}, setSyncState: async () => {}, pendingMessageIds: async () => new Set(),
    signal: new AbortController().signal, windowStart: 0,
  };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "token", invalidate() {} }, buildRaw: async () => new Uint8Array([1]) });
  return { provider, sync: () => provider.sync(sink), checkpoints, ingested, flags, removed, requests, methods };
}

async function rejectedRead(box: ReturnType<typeof mailbox>) {
  const error = await box.sync().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({ retryable: true, ambiguous: false });
  expect(box.checkpoints).toEqual([]);
  expect(box.removed).toEqual([]);
  return box;
}

describe("Gmail successful response validation", () => {
  it.each([null, true, [], {}, { id: "" }, { id: 7 }, { id: "sent", threadId: 7 }, { id: "sent", threadId: "" }])("never retries an unusable accepted send response: %j", async (result) => {
    const box = mailbox({ respond: (url) => url.pathname.endsWith("/send") ? result : undefined });
    const error = await box.provider.execute({ id: "send", kind: "send", target: {}, payload: { providerThreadId: null } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ retryable: false, ambiguous: true, network: false });
    expect(box.requests).toHaveLength(1);
    expect(box.methods).toEqual(["POST"]);
  });

  it.each([{ id: "sent" }, { id: "sent", threadId: "thread" }])("keeps a valid send acknowledgement: %j", async (result) => {
    const box = mailbox({ respond: (url) => url.pathname.endsWith("/send") ? result : undefined });
    await expect(box.provider.execute({ id: "send", kind: "send", target: {}, payload: {} })).resolves.toMatchObject({ providerMsgId: "sent" });
    expect(box.requests).toHaveLength(1);
  });

  it.each([null, {}, { ...message, raw: undefined }, { ...message, raw: "" }, { ...message, raw: "!invalid" }, { ...message, raw: "a" }, { ...message, id: "other" }, { ...message, threadId: "" }, { ...message, labelIds: "INBOX" }, { ...message, labelIds: [null] }])("cannot ingest unusable raw data or advance its checkpoint: %j", async (result) => {
    const box = await rejectedRead(mailbox({ respond: (url) => url.searchParams.get("format") === "raw" ? result : undefined }));
    expect(box.ingested).toEqual([]);
  });

  it.each([null, {}, { ...message, id: "other" }, { id: "m1", labelIds: "INBOX" }, { id: "m1", labelIds: [null] }])("cannot replace cached flags with malformed minimal state: %j", async (result) => {
    for (const cursor of [null, { historyId: "10" }]) {
      const box = await rejectedRead(mailbox({ cursor, cached: true, respond: (url) => url.searchParams.get("format") === "minimal" ? result : undefined }));
      expect(box.flags).toEqual([]);
    }
  });

  it.each([null, {}, { historyId: "" }, { historyId: 9007199254740992 }, { historyId: "not-a-checkpoint" }])("refuses invalid full-sync baselines: %j", async (profile) => {
    const box = await rejectedRead(mailbox({ respond: (url) => url.pathname.endsWith("/profile") ? profile : undefined }));
    expect(box.ingested).toEqual([]);
    expect(box.requests).toHaveLength(1);
  });

  it("verification refuses a malformed successful profile", async () => {
    const box = mailbox({ respond: () => ({}) });
    await expect(box.provider.verify()).rejects.toMatchObject({ retryable: true, ambiguous: false });
    expect(box.requests).toHaveLength(1);
  });

  it.each([null, [], { messages: null }, { messages: {} }, { messages: [{}] }, { messages: [{ id: 7 }] }, { nextPageToken: 12 }, { nextPageToken: "" }])("refuses malformed message-list pages: %j", async (page) => {
    const box = await rejectedRead(mailbox({ respond: (url) => url.pathname.endsWith("/messages") ? page : undefined }));
    expect(box.ingested).toEqual([]);
  });

  it.each([null, {}, { historyId: 11 }, { historyId: "" }, { historyId: "11", history: {} }, { historyId: "11", history: [null] }, { historyId: "11", history: [{ messagesAdded: [{ message: {} }] }] }, { historyId: "11", history: [{ labelsRemoved: "m1" }] }, { historyId: "11", nextPageToken: 12 }])("refuses malformed history pages: %j", async (page) => {
    const box = await rejectedRead(mailbox({ cursor: { historyId: "10" }, cached: true, respond: (url) => url.pathname.endsWith("/history") ? page : undefined }));
    expect(box.flags).toEqual([]);
    expect(box.ingested).toEqual([]);
  });

  it("allows absent optional arrays and labels, retaining an exact checkpoint beyond Number precision", async () => {
    const box = mailbox({ cached: true, respond: (url) => {
      if (url.pathname.endsWith("/profile")) return { historyId: "90071992547409931234" };
      if (url.pathname.endsWith("/messages")) return {};
      if (url.searchParams.get("format") === "minimal") return { id: "m1" };
    } });
    await box.sync();
    expect(box.checkpoints).toEqual([{ historyId: "90071992547409931234" }]);
    expect(box.flags[0]).toMatchObject({ gmailLabels: [], flags: { inInbox: false, isRead: true } });
    const delta = mailbox({ cursor: box.checkpoints[0], respond: (url) => url.pathname.endsWith("/history") ? { historyId: "90071992547409931235" } : undefined });
    await delta.sync();
    expect(delta.requests[0]?.searchParams.get("startHistoryId")).toBe("90071992547409931234");
    expect(delta.checkpoints).toEqual([{ historyId: "90071992547409931235" }]);
  });

  it.each(["messages", "history"])("stops a repeated opaque %s continuation without promoting a checkpoint", async (kind) => {
    const token = "opaque/+?=token";
    const box = await rejectedRead(mailbox({ cursor: kind === "history" ? { historyId: "10" } : null, respond: (url) => {
      if (url.pathname.endsWith(`/${kind}`)) return kind === "history" ? { historyId: "11", nextPageToken: token } : { nextPageToken: token };
    } }));
    expect(box.requests.filter((url) => url.pathname.endsWith(`/${kind}`))).toHaveLength(2);
    expect(box.requests.at(-1)?.searchParams.get("pageToken")).toBe(token);
  });

  it.each([{ internalDate: "invalid" }, { internalDate: 123 }, { internalDate: "8640000000000001" }, { sizeEstimate: "100" }, { sizeEstimate: -1 }, { sizeEstimate: 0.5 }])("does not ingest malformed consumed metadata: %j", async (metadata) => {
    const box = await rejectedRead(mailbox({ respond: (url) => url.searchParams.get("format") === "raw" ? { ...message, ...metadata } : undefined }));
    expect(box.ingested).toEqual([]);
  });

  it.each(["YQ", "YQ=="])("accepts valid headerless base64url source %s", async (source) => {
    const box = mailbox({ respond: (url) => url.searchParams.get("format") === "raw" ? { ...message, raw: source, internalDate: "0", sizeEstimate: 1 } : undefined });
    await box.sync();
    expect(box.ingested[0]).toMatchObject({ providerMsgId: "m1", date: 0, size: 1 });
    expect(box.checkpoints).toEqual([{ historyId: "10" }]);
  });

  it("rejects a decreasing history checkpoint without Number precision loss", async () => {
    await rejectedRead(mailbox({ cursor: { historyId: "9007199254740995" }, respond: (url) => url.pathname.endsWith("/history") ? { historyId: "9007199254740993" } : undefined }));
  });

  it.each([false, true])("expired history cannot replace its prior baseline with a lower checkpoint (cached=%s)", async (cached) => {
    const box = mailbox({ cached, cursor: { historyId: "9007199254740995" }, respond: (url) => {
      if (url.pathname.endsWith("/history")) return new Response(null, { status: 404 });
      if (url.pathname.endsWith("/profile")) return { historyId: "9007199254740993" };
    } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await rejectedRead(box);
      expect(box.ingested).toEqual([]);
      expect(box.flags).toEqual([]);
    }
    expect(box.requests.filter((u) => u.pathname.endsWith("/history")).map((u) => u.searchParams.get("startHistoryId"))).toEqual(["9007199254740995", "9007199254740995"]);
  });

  it.each(["9007199254740995", "9007199254740999"])("accepts unchanged or noncontiguous increasing history checkpoint %s", async (checkpoint) => {
    const box = mailbox({ cursor: { historyId: "9007199254740995" }, respond: (url) => url.pathname.endsWith("/history") ? { historyId: checkpoint } : undefined });
    await box.sync();
    expect(box.checkpoints).toEqual([{ historyId: checkpoint }]);
  });

  it.each([{}, { historyId: 10 }, { historyId: "invalid" }])("reconciles a malformed persisted cursor instead of using it: %j", async (cursor) => {
    const box = mailbox({ cursor });
    await box.sync();
    expect(box.requests[0]?.pathname.endsWith("/profile")).toBe(true);
    expect(box.checkpoints).toEqual([{ historyId: "10" }]);
  });

  it.each(["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"])("accepts sparse %s references and extra provider fields", async (kind) => {
    const box = mailbox({ cached: true, cursor: { historyId: "10" }, respond: (url) => url.pathname.endsWith("/history") ? { historyId: "11", history: [{ [kind]: [{ message: { id: "m1", futureField: true } }] }], futureField: [] } : undefined });
    await box.sync();
    expect(box.checkpoints).toEqual([{ historyId: "11" }]);
    if (kind === "messagesDeleted") expect(box.removed).toEqual([1]);
    if (kind.startsWith("labels")) expect(box.flags[0]).toMatchObject({ flags: { inInbox: true, isRead: false } });
  });

  it("retains an earlier valid page and converges when a malformed later page is repaired", async () => {
    let broken = true;
    const box = mailbox({ respond: (url) => {
      if (url.pathname.endsWith("/messages")) return url.searchParams.has("pageToken") ? (broken ? { messages: [{}] } : { messages: [{ id: "m2" }] }) : { messages: [{ id: "m1" }], nextPageToken: "next" };
      if (url.pathname.endsWith("/messages/m2")) return { ...message, id: "m2", threadId: "t2" };
    } });
    await rejectedRead(box);
    expect(box.ingested.map((m) => m.providerMsgId)).toEqual(["m1"]);
    expect(box.flags).toEqual([]);
    broken = false;
    await box.sync();
    expect(box.ingested.map((m) => m.providerMsgId)).toEqual(["m1", "m2"]);
    expect(box.checkpoints).toEqual([{ historyId: "10" }]);
  });

  it.each(["raw", "minimal"] as const)("stops queued %s downloads and settles existing workers before rejecting a malformed batch", async (format) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const box = mailbox({ cached: format === "minimal" ? 12 : false, respond: async (url) => {
      if (url.pathname.endsWith("/messages")) return format === "minimal" ? {} : { messages: Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}` })) };
      if (url.searchParams.get("format") === format) {
        const id = url.pathname.split("/").at(-1)!;
        if (id === "m1") return null;
        await gate;
        return { ...message, id };
      }
    } });
    let settled = false;
    const running = box.sync().then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
    await vi.waitFor(() => expect(box.requests.filter((u) => u.searchParams.get("format") === format)).toHaveLength(6));
    await new Promise((resolve) => setImmediate(resolve));
    const settledBeforeRelease = settled;
    release();
    const error = await running;
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toBeInstanceOf(ProviderError);
    expect(settledBeforeRelease).toBe(false);
    expect(box.requests.filter((u) => u.searchParams.get("format") === format)).toHaveLength(6);
    expect(box.ingested).toEqual([]);
    expect(box.flags).toEqual([]);
    expect(box.checkpoints).toEqual([]);
  });

  it("ingests a large raw body in its single download", async () => {
    const body = "a".repeat(1024 * 1024);
    const source = toBase64url(new TextEncoder().encode(`Subject: Large\r\n\r\n${body}`));
    const box = mailbox({ respond: (url) => url.searchParams.get("format") === "raw" ? { ...message, raw: source } : undefined });
    await box.sync();
    expect(box.ingested[0]?.bodyText?.trimEnd() === body).toBe(true);
    expect(box.requests.filter((u) => u.searchParams.get("format") === "raw")).toHaveLength(1);
  });

  it("lets a pending foreground event run during large raw validation", async () => {
    const source = toBase64url(new TextEncoder().encode(`Subject: Large\r\n\r\n${"a".repeat(8 * 1024 * 1024)}`));
    let responsive = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const box = mailbox({ respond: (url) => {
      if (url.searchParams.get("format") !== "raw") return;
      const response = new Response();
      Object.defineProperty(response, "json", { value: async () => {
        timer = setTimeout(() => { responsive = true; }, 0);
        return { ...message, raw: source };
      } });
      return response;
    }, onIngest: () => expect(responsive).toBe(true) });
    try {
      await box.sync();
    } finally {
      clearTimeout(timer);
    }
    expect(box.checkpoints).toEqual([{ historyId: "10" }]);
  });
});

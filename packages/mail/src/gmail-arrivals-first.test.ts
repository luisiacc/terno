/** Plan 265: in a Gmail pass, new mail comes first, and no one message or backlog holds it back. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { FlagSnapshotRequest } from "@terno/store";
import { ARRIVALS_EVERY_MS, FLAG_SNAPSHOTS_MS, createGmailApiProvider, toBase64url } from "./gmail-api";
import { IncomingPipeline } from "./incoming";
import { IncomingProcessingError, type IncomingProcessingFailureCode } from "./incoming-processing";
import type { MailProvider, ProviderContext, SyncSink } from "./types";

const NOW = Date.UTC(2026, 10, 1);
const plain = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\n\r\nExact body\r\n"));
// a transfer encoding takes a message to the processor (never parsed inline), where the rig refuses it
const encoded = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nContent-Transfer-Encoding: base64\r\n\r\nRXhhY3Q=\r\n"));

const open: { provider: MailProvider; pipeline: IncomingPipeline }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { provider, pipeline } of open.splice(0)) { await provider.close(); pipeline.close(); }
});

type HistoryAnswer = { history?: unknown[]; historyId: string } | number;

function rig(o: {
  history: (start: string) => HistoryAnswer;
  /** a message's processing failure (its raw goes to the processor) */
  refuse?: (id: string) => IncomingProcessingFailureCode | undefined;
  /** a raw read's own HTTP failure */
  status?: (id: string) => number | undefined;
  /** ms a raw read waits before it answers */
  delay?: (id: string) => number;
  minimal?: (id: string) => unknown;
  blockCapture?: SyncSink["blockCapture"];
  pendingRepairs?: string[];
  flags?: number;
  stored?: string[];
}) {
  const stored = new Set(o.stored ?? []);
  const raws: string[] = [], minimals: string[] = [], histories: string[] = [], saved: unknown[] = [], ingested: string[][] = [], flagPages: FlagSnapshotRequest[] = [];
  const updates: string[] = [];
  let again = 0;
  const pipeline = new IncomingPipeline();
  const ctx = {
    account: { id: 1, email: "me@example.test" }, config: {}, ...(o.flags !== undefined && { flagObservation: true }),
    yield: async () => {},
    incoming: { acquire: pipeline.acquire.bind(pipeline), promote: pipeline.promote.bind(pipeline) },
    incomingProcessor: { run: async (input: { expectedId?: string }) => { throw new IncomingProcessingError(o.refuse?.(input.expectedId!) ?? "worker-fault"); } },
    store: {
      messageByProviderId: async (id: string) => stored.has(id) ? { id: Number(id.replace(/\D/g, "")) || 1, subject: "", fromEmail: "sender@example.test" } : null,
      pendingAttachmentBodies: async () => [], syncedMessagePage: async () => ({ items: [] }),
      pendingFlagSnapshots: async (p: FlagSnapshotRequest) => {
        flagPages.push({ ...p });
        const through = p.throughMessageId ?? o.flags ?? 0, after = p.afterMessageId ?? 0, end = Math.min(through, after + p.limit);
        return { items: Array.from({ length: Math.max(0, end - after) }, (_, i) => ({ id: after + i + 1, providerMsgId: `f${after + i + 1}` })), throughMessageId: through, hasMore: end < through };
      },
      repairs: {
        get: async () => null,
        list: async () => ({ items: (o.pendingRepairs ?? []).map((id) => ({ key: id, locator: { kind: "gmail", providerId: id }, reason: "mime-parts", state: "pending", revision: 1 })) }),
      },
    },
    loadCursor: async () => ({ historyId: "10" }),
    saveCursor: async (value: unknown) => void saved.push(value),
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/history")) {
        const start = url.searchParams.get("startHistoryId")!;
        histories.push(start);
        const answer = o.history(start);
        return typeof answer === "number" ? Response.json({ error: { message: "synthetic" } }, { status: answer }) : Response.json(answer);
      }
      if (url.pathname.endsWith("/labels")) return Response.json({ labels: [] });
      const id = url.pathname.split("/").at(-1)!;
      if (url.searchParams.get("format") === "minimal") {
        minimals.push(id);
        return Response.json(o.minimal?.(id) ?? { id, labelIds: ["INBOX"] });
      }
      raws.push(id);
      const delay = o.delay?.(id);
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      const status = o.status?.(id);
      if (status) return Response.json({ error: { message: "synthetic" } }, { status });
      return Response.json({ id, threadId: `t-${id}`, labelIds: ["INBOX"], internalDate: String(NOW), raw: o.refuse?.(id) ? encoded : plain });
    },
  } as unknown as ProviderContext;
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  open.push({ provider, pipeline });
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest(messages) { ingested.push(messages.map((m) => m.providerMsgId!)); for (const m of messages) stored.add(m.providerMsgId!); },
    async updateFlags(list) { updates.push(...list.map((u) => u.expectedProviderMsgId!)); }, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
    again: () => void again++,
    ...(o.blockCapture && { blockCapture: o.blockCapture }),
  };
  return { provider, sink, raws, minimals, histories, saved, ingested, flagPages, updates, stored, again: () => again, sync: () => provider.sync(sink) };
}

/** history since "10" adding `ids` in that order (pages of 500), at `historyId` */
function additions(ids: string[], historyId = "20"): HistoryAnswer {
  return { historyId, history: ids.map((id) => ({ messagesAdded: [{ message: { id } }] })) };
}
const named = (n: number, prefix = "a") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

describe("one message never holds the rest back", () => {
  it("a message nested too deeply becomes a mime-depth repair; its siblings are stored and the cursor moves", async () => {
    const blockCapture = vi.fn(async () => {});
    const t = rig({ history: () => additions(["a1", "deep", "a2"]), refuse: (id) => id === "deep" ? "mime-limit-depth" : undefined, blockCapture });
    await t.sync();
    expect(blockCapture).toHaveBeenCalledExactlyOnceWith({ kind: "gmail", providerId: "deep" }, "mime-depth", 0);
    expect(t.ingested.flat().sort()).toEqual(["a1", "a2"]);
    expect(t.saved).toEqual([{ historyId: "20" }]);
  });

  it("a message only its own content fails is held: the other 119 are stored newest first, the cursor stays, and a later pass takes it", async () => {
    let bad = true;
    const ids = named(120);
    const t = rig({ history: () => additions(ids), refuse: (id) => id === "a60" && bad ? "mime-limit-headers" : undefined });
    await expect(t.sync()).rejects.toMatchObject({ code: "mime-limit-headers", expected: true, retryable: false });
    // the newest first: the first batch downloaded is a71..a120
    expect(t.raws.slice(0, 50).sort()).toEqual(ids.slice(70).sort());
    expect(t.ingested.flat().sort()).toEqual(ids.filter((id) => id !== "a60").sort());
    expect(t.saved).toEqual([]);
    bad = false;
    t.raws.length = 0;
    await t.sync();
    expect(t.raws).toEqual(["a60"]);
    expect(t.saved).toEqual([{ historyId: "20" }]);
  });

  it("a repair journal with no room holds its message, not the pass's other mail", async () => {
    const full = new RpcError("UNAVAILABLE", L("capture.capacity"));
    const t = rig({ history: () => additions(["a1", "parts", ...named(60, "b")]), refuse: (id) => id === "parts" ? "mime-limit-parts" : undefined, blockCapture: async () => { throw full; } });
    await expect(t.sync()).rejects.toBe(full);
    expect(t.ingested.flat()).toHaveLength(61);
    expect(t.saved).toEqual([]);
  });

  it("a repair refused for any other reason still fails the pass", async () => {
    const stale = new RpcError("STALE", L("capture.changed"));
    const t = rig({ history: () => additions(["parts", ...named(60, "b")]), refuse: (id) => id === "parts" ? "mime-limit-parts" : undefined, blockCapture: async () => { throw stale; } });
    await expect(t.sync()).rejects.toBe(stale);
    expect(t.saved).toEqual([]);
  });

  it("a failure every message would meet (the worker) still stops the pass", async () => {
    const t = rig({ history: () => additions(named(120)), refuse: (id) => id === "a120" ? "worker-unavailable" : undefined });
    await expect(t.sync()).rejects.toMatchObject({ code: "worker-unavailable" });
    expect(t.raws.length).toBeLessThanOrEqual(50);
    expect(t.saved).toEqual([]);
  });

  it("what was downloaded before a sibling failed is stored, so the next pass doesn't read it again", async () => {
    const t = rig({ history: () => additions(["a1", "a2", "late"]), status: (id) => id === "late" ? 503 : undefined, delay: (id) => id === "late" ? 30 : 0 });
    await expect(t.sync()).rejects.toMatchObject({ status: 503 });
    expect(t.ingested.flat().sort()).toEqual(["a1", "a2"]);
    expect(t.saved).toEqual([]);
  });

  it("a pending repair its own content fails again is retried after new mail, which is stored and its cursor saved", async () => {
    const t = rig({ history: () => additions(["a1"]), pendingRepairs: ["r"], refuse: (id) => id === "r" ? "mime-limit-headers" : undefined });
    await expect(t.sync()).rejects.toMatchObject({ code: "mime-limit-headers" });
    expect(t.raws).toEqual(["a1", "r"]);
    expect(t.ingested.flat()).toEqual(["a1"]);
    expect(t.saved).toEqual([{ historyId: "20" }]);
  });
});

describe("the flag backlog gets a share", () => {
  it("reads a share of the pending snapshots, then history, asks for another pass and goes on from where it stopped", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = rig({ flags: 200, history: () => ({ historyId: "10" }), minimal: (id) => { if (id === "f50") now += FLAG_SNAPSHOTS_MS + 1; return { id, labelIds: ["INBOX"] }; } });
    await t.sync();
    expect(t.minimals).toHaveLength(50);
    expect(t.histories).toEqual(["10"]);
    expect(t.again()).toBe(1);
    await t.sync();
    expect(t.flagPages[1]).toEqual({ limit: 50, afterMessageId: 50, throughMessageId: 200 });
    expect(t.minimals).toHaveLength(200);
    expect(t.again()).toBe(1);
    // a finished traversal starts over next time
    const pages = t.flagPages.length;
    await t.sync();
    expect(t.flagPages[pages]).toEqual({ limit: 50 });
  });
});

describe("a long catch-up looks at history between its steps", () => {
  it("downloads what arrived during the pass before the older additions still waiting, and saves the look's position", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ids = named(120);
    const t = rig({ history: (start) => start === "10" ? additions(ids) : start === "20" ? additions(["fresh"], "30") : { historyId: "30" } });
    const ingest = t.sink.ingest.bind(t.sink);
    t.sink.ingest = async (messages, o) => { await ingest(messages, o); now += ARRIVALS_EVERY_MS; };
    await t.sync();
    expect(t.histories).toEqual(["10", "20", "30", "30"]);
    // a71..a120 first, then the look's arrival, then the rest
    expect(t.raws.indexOf("fresh")).toBe(50);
    expect(t.ingested.flat().sort()).toEqual([...ids, "fresh"].sort());
    expect(t.saved).toEqual([{ historyId: "30" }]);
  });

  it("a look that finds history gone stops looking; the cursor is the position merged last", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = rig({ history: (start) => start === "10" ? additions(named(120)) : 404 });
    const ingest = t.sink.ingest.bind(t.sink);
    t.sink.ingest = async (messages, o) => { await ingest(messages, o); now += ARRIVALS_EVERY_MS; };
    await t.sync();
    expect(t.histories).toEqual(["10", "20"]);
    expect(t.saved).toEqual([{ historyId: "20" }]);
  });

  it("a message relabelled again after its reread is read again", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = rig({
      stored: ["s1"],
      history: (start) => start === "10" ? { historyId: "20", history: [{ labelsAdded: [{ message: { id: "s1" } }] }] } : start === "20" ? { historyId: "30", history: [{ labelsRemoved: [{ message: { id: "s1" } }] }] } : { historyId: "30" },
      minimal: (id) => { now += ARRIVALS_EVERY_MS; return { id, labelIds: ["INBOX"] }; },
    });
    await t.sync();
    expect(t.minimals).toEqual(["s1", "s1"]);
    expect(t.saved).toEqual([{ historyId: "30" }]);
  });
});

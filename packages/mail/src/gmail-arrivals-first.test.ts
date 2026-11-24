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
  /** a minimal read's answer (a number: that HTTP status) */
  minimal?: (id: string) => unknown;
  /** ids with a capture repair row */
  repairRows?: string[];
  /** called on each stored-message lookup */
  lookup?: (id: string) => void;
  blockCapture?: SyncSink["blockCapture"];
  pendingRepairs?: string[];
  /** the repair the person just asked to retry (it goes before history) */
  explicitRetry?: string;
  flags?: number;
  stored?: string[];
  /** plan 267: a metadata read's answer (a number: that HTTP status; a string: the raw body) */
  metadata?: (id: string) => unknown;
}) {
  const stored = new Set(o.stored ?? []);
  const raws: string[] = [], minimals: string[] = [], histories: string[] = [], saved: unknown[] = [], ingested: string[][] = [], flagPages: FlagSnapshotRequest[] = [];
  const updates: string[] = [], events: string[] = [], updatesAtSave: string[][] = [];
  let again = 0;
  const pipeline = new IncomingPipeline();
  const ctx = {
    account: { id: 1, email: "me@example.test" }, config: {}, ...(o.flags !== undefined && { flagObservation: true }),
    yield: async () => {},
    incoming: { acquire: pipeline.acquire.bind(pipeline), promote: pipeline.promote.bind(pipeline) },
    incomingProcessor: { run: async (input: { expectedId?: string }) => { throw new IncomingProcessingError(o.refuse?.(input.expectedId!) ?? "worker-fault"); } },
    store: {
      messageByProviderId: async (id: string) => (o.lookup?.(id), stored.has(id)) ? { id: Number(id.replace(/\D/g, "")) || 1, subject: "", fromEmail: "sender@example.test" } : null,
      pendingAttachmentBodies: async () => [], syncedMessagePage: async () => ({ items: [] }),
      pendingFlagSnapshots: async (p: FlagSnapshotRequest) => {
        flagPages.push({ ...p });
        const through = p.throughMessageId ?? o.flags ?? 0, after = p.afterMessageId ?? 0, end = Math.min(through, after + p.limit);
        return { items: Array.from({ length: Math.max(0, end - after) }, (_, i) => ({ id: after + i + 1, providerMsgId: `f${after + i + 1}` })), throughMessageId: through, hasMore: end < through };
      },
      repairs: {
        get: async (_account: number, locator: { providerId: string }) => locator.providerId === o.explicitRetry ? { key: locator.providerId, locator, reason: "mime-parts", state: "pending", revision: 1 }
          : o.repairRows?.includes(locator.providerId) ? { key: locator.providerId, locator, reason: "mime-parts", state: "blocked", revision: 1 } : null,
        list: async () => ({ items: (o.pendingRepairs ?? []).map((id) => ({ key: id, locator: { kind: "gmail", providerId: id }, reason: "mime-parts", state: "pending", revision: 1 })) }),
      },
    },
    loadCursor: async () => ({ historyId: "10" }),
    saveCursor: async (value: unknown) => { saved.push(value); updatesAtSave.push([...updates]); },
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
      if (url.searchParams.get("format") === "metadata") {
        const answer = o.metadata?.(id) ?? 404;
        if (typeof answer === "number") return Response.json({ error: { message: "synthetic" } }, { status: answer });
        return typeof answer === "string" ? new Response(answer) : Response.json(answer);
      }
      if (url.searchParams.get("format") === "minimal") {
        minimals.push(id);
        const answer = o.minimal?.(id) ?? { id, labelIds: ["INBOX"] };
        return typeof answer === "number" ? Response.json({ error: { message: "synthetic" } }, { status: answer }) : Response.json(answer);
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
    async updateFlags(list) { updates.push(...list.map((u) => `${u.expectedProviderMsgId}:${u.gmailLabels!.join(",")}`)); },
    async retireCapture(locator) { events.push(`retire ${locator.kind === "gmail" ? locator.providerId : ""}`); }, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
    again: () => void again++,
    ...(o.explicitRetry && { captureRetry: { locator: { kind: "gmail" as const, providerId: o.explicitRetry }, revision: 1 } }),
    ...(o.blockCapture && { blockCapture: async (...args: Parameters<NonNullable<SyncSink["blockCapture"]>>) => { const [locator] = args; events.push(`block ${locator.kind === "gmail" ? locator.providerId : ""}`); return o.blockCapture!(...args); } }),
  };
  return { provider, sink, raws, minimals, histories, saved, ingested, flagPages, updates, updatesAtSave, events, stored, again: () => again, sync: () => provider.sync(sink) };
}

/** history since "10" adding `ids` in that order (records of 100), at `historyId` */
function additions(ids: string[], historyId = "20"): HistoryAnswer {
  const history = [];
  for (let i = 0; i < ids.length; i += 100) history.push({ messagesAdded: ids.slice(i, i + 100).map((id) => ({ message: { id } })) });
  return { historyId, history };
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

  it.each([["mime-limit-headers", "mime-headers"], ["mime-limit-addresses", "mime-addresses"]] as const)("plan 267: %s is a %s repair: siblings stored, the cursor moves, and the next pass leaves it be", async (code, reason) => {
    const blockCapture = vi.fn(async () => {});
    let blocked = false;
    const t = rig({ history: () => additions(["a1", "bad", "a2"]), refuse: (id) => id === "bad" ? code : undefined, blockCapture, repairRows: [] });
    await t.sync();
    expect(blockCapture).toHaveBeenCalledExactlyOnceWith({ kind: "gmail", providerId: "bad" }, reason, 0);
    expect(t.ingested.flat().sort()).toEqual(["a1", "a2"]);
    expect(t.saved).toEqual([{ historyId: "20" }]);
    blocked = true;
    const next = rig({ history: () => additions(["bad"]), refuse: (id) => id === "bad" && blocked ? code : undefined, blockCapture, repairRows: ["bad"] });
    await next.sync();
    expect(next.raws).toEqual([]);
    expect(next.saved).toEqual([{ historyId: "20" }]);
  });

  it("a message only its own content fails is held: the other 119 are stored newest first, the cursor stays, and a later pass takes it", async () => {
    let bad = true;
    const ids = named(120);
    // (plan 267: a parser verdict is a repair now; an input over the processor's limit is still held)
    const t = rig({ history: () => additions(ids), refuse: (id) => id === "a60" && bad ? "input-limit" : undefined });
    await expect(t.sync()).rejects.toMatchObject({ code: "input-limit", expected: true, retryable: false });
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

  it("a retry asked for now that fails again is held without keeping history's cursor back", async () => {
    const t = rig({ history: () => additions(["a1"]), explicitRetry: "r", refuse: (id) => id === "r" ? "input-limit" : undefined });
    await expect(t.sync()).rejects.toMatchObject({ code: "input-limit" });
    expect(t.raws).toEqual(["r", "a1"]);
    expect(t.ingested.flat()).toEqual(["a1"]);
    expect(t.saved).toEqual([{ historyId: "20" }]);
  });

  it("a pending repair its own content fails again is retried after new mail, which is stored and its cursor saved", async () => {
    const t = rig({ history: () => additions(["a1"]), pendingRepairs: ["r"], refuse: (id) => id === "r" ? "input-limit" : undefined });
    await expect(t.sync()).rejects.toMatchObject({ code: "input-limit" });
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
      minimal: (id) => { now += ARRIVALS_EVERY_MS; return { id, labelIds: t.minimals.length === 1 ? ["INBOX", "STARRED"] : ["INBOX"] }; },
    });
    await t.sync();
    expect(t.minimals).toEqual(["s1", "s1"]);
    expect(t.updatesAtSave).toEqual([["s1:INBOX,STARRED", "s1:INBOX"]]);
    expect(t.saved).toEqual([{ historyId: "30" }]);
  });

  it("a look still frees the repair row of a message a reread found gone, before that look's new mail needs a repair", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = rig({
      stored: ["s1"], repairRows: ["s1"],
      history: (start) => start === "10" ? { historyId: "20", history: [{ labelsAdded: [{ message: { id: "s1" } }] }] }
        : start === "20" ? { historyId: "30", history: [{ messagesDeleted: [{ message: { id: "s1" } }] }, { messagesAdded: [{ message: { id: "parts" } }] }] } : { historyId: "30" },
      minimal: () => { now += ARRIVALS_EVERY_MS; return 404; },
      refuse: (id) => id === "parts" ? "mime-limit-parts" : undefined, blockCapture: async () => {},
    });
    await t.sync();
    expect(t.events.slice(0, 2)).toEqual(["retire s1", "block parts"]);
    expect(t.saved).toEqual([{ historyId: "30" }]);
  });

  it("a replay of mail already stored still looks at history between its steps", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ids = named(600);
    const t = rig({
      stored: ids, lookup: (id) => { if (id === "a550") now += ARRIVALS_EVERY_MS; },
      history: (start) => start === "10" ? additions(ids) : start === "20" ? additions(["fresh"], "30") : { historyId: "30" },
    });
    await t.sync();
    expect(t.raws).toEqual(["fresh"]);
    expect(t.saved).toEqual([{ historyId: "30" }]);
  });

  it("a held message's error comes before a malformed flag snapshot's", async () => {
    const full = new RpcError("UNAVAILABLE", L("capture.capacity"));
    const t = rig({ flags: 1, minimal: (id) => id === "f1" ? { id: "wrong", labelIds: [] } : undefined, history: () => additions(["parts"]), refuse: (id) => id === "parts" ? "mime-limit-parts" : undefined, blockCapture: async () => { throw full; } });
    await expect(t.sync()).rejects.toBe(full);
  });
});

describe("which message a repair is (plan 267)", () => {
  it("reads the subject, sender and date from Gmail's own parse of the headers, decoded", async () => {
    const t = rig({ history: () => additions([]), metadata: (id) => ({ id, internalDate: "1700000000000", payload: { headers: [{ name: "Subject", value: "=?UTF-8?B?UmVwb3J0ZSBhbnVhbA==?=" }, { name: "From", value: "Ana Torres <ana@example.test>" }] } }) });
    expect(await t.provider.describe!("m1", new AbortController().signal)).toEqual({ subject: "Reporte anual", from: "Ana Torres", date: 1700000000000 });
  });

  it("parses the sender as written before decoding its name: an encoded \"Doe, Jane\" stays one name", async () => {
    const t = rig({ history: () => additions([]), metadata: (id) => ({ id, payload: { headers: [{ name: "From", value: "=?UTF-8?Q?Doe=2C_Jane?= <jane@example.test>" }] } }) });
    expect(await t.provider.describe!("m1", new AbortController().signal)).toEqual({ from: "Doe, Jane" });
  });

  it("gives nothing for another message's answer, a missing one, or one past its bound; a cancelled read throws", async () => {
    const huge = JSON.stringify({ id: "huge", payload: { headers: [{ name: "Subject", value: "x".repeat(70_000) }] } });
    const answers: Record<string, unknown> = { other: { id: "else", payload: { headers: [] } }, gone: 404, huge };
    const t = rig({ history: () => additions([]), metadata: (id) => answers[id] });
    for (const id of ["other", "gone", "huge"]) expect(await t.provider.describe!(id, new AbortController().signal)).toBeUndefined();
    const stop = new AbortController(); stop.abort();
    await expect(t.provider.describe!("other", stop.signal)).rejects.toBeDefined();
  });
});

/**
 * Plan 107 on the backend: an .mbox export as a session. The order is fixed at the start (date, then id), each
 * `next` is bounded by size and time and resumes a message where it stopped, a message deleted meanwhile is
 * skipped, and a session ends by cancel, a newer start from the same client, or a minute idle.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { MBOX_PIECE } from "@terno/mail/portable";
import { createDemoProvider, type ProviderRegistry } from "@terno/mail";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { EXPORT_IDLE_MS, EXPORT_TEXT_MAX, FolderExports, sortByDate } from "./folder-export";

const NOW = Date.UTC(2026, 10, 1, 12);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const registry: ProviderRegistry = {
  kind: "demo",
  create: (ctx) => createDemoProvider(ctx, 0),
  async verifyImap() {},
  async connectGmail() {
    throw new Error("not here");
  },
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-export-"));
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: registry, now: () => NOW, autoSync: false });
  const connect = () => {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: `renderer-${Math.random()}`, origin: "renderer" });
    return new RpcClient(c);
  };
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const [gmail] = await withAccounts(backend.store, 1);
  return { backend, client: connect(), connect, gmail: gmail! };
}

/** every `next` until finished, timing each */
async function drain(client: RpcClient, exportId: string, between?: (i: number) => Promise<void>) {
  const texts: string[] = [];
  const calls: { ms: number; size: number; done: number }[] = [];
  for (let i = 0; ; i++) {
    const started = performance.now();
    const r = await client.call("folders.exportNext", { exportId });
    calls.push({ ms: performance.now() - started, size: r.text.length, done: r.done });
    texts.push(r.text);
    if (r.finished) return { text: texts.join(""), calls, last: r };
    await between?.(i);
  }
}

const subjects = (mbox: string) => [...mbox.matchAll(/^Subject: (.*)$/gm)].map((m) => m[1]);

describe("folders.export (plan 107)", () => {
  it("writes the folder's messages by date then id, quoted, and counts what isn't here", async () => {
    const { client, backend, gmail } = await setup();
    await backend.store.folders.replace(gmail, [{ key: "Label_1", path: ["Work", "Clients"], selectable: true }]);
    const day = Date.UTC(2026, 0, 2);
    await ingest(backend.store, [
      msg({ accountId: gmail, providerMsgId: "late", subject: "Late", date: day + 1000, gmailLabels: ["Label_1"] }),
      msg({ accountId: gmail, providerMsgId: "tie-a", subject: "Tie A", date: day, gmailLabels: ["Label_1"], bodyText: "From the start\nhello" }),
      msg({ accountId: gmail, providerMsgId: "tie-b", subject: "Tie B", date: day, gmailLabels: ["Label_1"], bodyState: "partial" }),
      msg({ accountId: gmail, providerMsgId: "early", subject: "Early", date: day - 1000, gmailLabels: ["Label_1"], hasAttachments: true, attachments: [{ filename: "far.pdf", mime: "application/pdf", size: 10, providerRef: "r" }] }),
      msg({ accountId: gmail, providerMsgId: "elsewhere", subject: "Elsewhere", date: day }),
    ]);
    const start = await client.call("folders.exportStart", { accountId: gmail, folder: "Label_1", view: null });
    expect(start).toMatchObject({ total: 4, name: "Clients" });
    const { text, last } = await drain(client, start.exportId);
    expect(subjects(text)).toEqual(["Early", "Tie A", "Tie B", "Late"]);
    expect(text).toContain("\n=46rom the start");
    expect(text).toContain("X-Terno-Missing-Attachment: far.pdf");
    expect(last).toMatchObject({ done: 4, total: 4, finished: true, missingAttachments: 1, partialBodies: 1 });
    // a finished session is gone
    await expect(client.call("folders.exportNext", { exportId: start.exportId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const inbox = await client.call("folders.exportStart", { accountId: gmail, folder: null, view: "inbox" });
    expect(inbox).toMatchObject({ total: 5, name: "Inbox" });
    await expect(client.call("folders.exportStart", { accountId: gmail, folder: "Label_9", view: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("each next is bounded by size and time, a large attachment spans several, and a deletion meanwhile is skipped", async () => {
    const { client, backend, gmail } = await setup();
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 256);
    await ingest(backend.store, [
      ...Array.from({ length: 120 }, (_, i) => msg({ accountId: gmail, providerMsgId: `m${i}`, providerThreadId: `t${i}`, subject: `M${i}`, date: NOW - (200 - i) * 1000, bodyText: "word ".repeat(4000) })),
      msg({ accountId: gmail, providerMsgId: "big", subject: "Big", date: NOW, hasAttachments: true, attachments: [{ filename: "big.bin", mime: "application/octet-stream", size: big.length, bytes: big }] }),
    ]);
    const gone = (await backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "m60")!.id;
    // a slow store: each batch read takes a while, so only time ends some calls
    const read = backend.store.folderExport.messages.bind(backend.store.folderExport);
    backend.store.folderExport.messages = async (ids) => {
      const until = performance.now() + 4;
      while (performance.now() < until);
      return read(ids);
    };
    const { exportId, total } = await client.call("folders.exportStart", { accountId: gmail, folder: null, view: "inbox" });
    expect(total).toBe(121);
    const { text, calls, last } = await drain(client, exportId, async (i) => {
      if (i === 0) await backend.store.sync.remove([gone]);
    });
    for (const c of calls) {
      expect(c.size).toBeLessThanOrEqual(EXPORT_TEXT_MAX + MBOX_PIECE);
      // the budget, plus at most one unit of work begun inside it (a batch read, a piece)
      expect(c.ms).toBeLessThan(60);
    }
    expect(calls.length).toBeGreaterThan(6);
    // the attachment alone took several calls
    expect(calls.filter((c) => c.done === 119).length).toBeGreaterThan(1);
    expect(last).toMatchObject({ done: 120, total: 121, finished: true, missingAttachments: 0 });
    expect(subjects(text)).not.toContain("M60");
    expect(subjects(text).at(-1)).toBe("Big");
  });

  it("a message deleted while the one before it is still being written isn't in it (Codex code review round 2 #7)", async () => {
    const { client, backend, gmail } = await setup();
    await ingest(backend.store, [
      msg({ accountId: gmail, providerMsgId: "long", providerThreadId: "a", subject: "Long", date: NOW - 2000, bodyText: "word ".repeat(800_000) }),
      msg({ accountId: gmail, providerMsgId: "next", providerThreadId: "b", subject: "Next", date: NOW - 1000 }),
    ]);
    const gone = (await backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "next")!.id;
    const { exportId } = await client.call("folders.exportStart", { accountId: gmail, folder: null, view: "inbox" });
    const { text, calls, last } = await drain(client, exportId, async (i) => {
      if (i === 0) await backend.store.sync.remove([gone]);
    });
    // the first message alone took more than one call, and the deletion came between them
    expect(calls[0]!.done).toBe(0);
    expect(subjects(text)).toEqual(["Long"]);
    expect(last).toMatchObject({ done: 1, total: 2, finished: true });
  });

  it("cancel ends it; a new start from the same client ends the last; another client can't touch it", async () => {
    const { client, connect, backend, gmail } = await setup();
    await ingest(backend.store, Array.from({ length: 30 }, (_, i) => msg({ accountId: gmail, providerMsgId: `c${i}`, providerThreadId: `c${i}`, bodyText: "x".repeat(60_000) })));
    const first = await client.call("folders.exportStart", { accountId: gmail, folder: null, view: "inbox" });
    await client.call("folders.exportNext", { exportId: first.exportId });
    const other = connect();
    await expect(other.call("folders.exportNext", { exportId: first.exportId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await other.call("folders.exportCancel", { exportId: first.exportId })).toEqual({ ok: true });
    await client.call("folders.exportNext", { exportId: first.exportId });
    const second = await client.call("folders.exportStart", { accountId: gmail, folder: null, view: "inbox" });
    await expect(client.call("folders.exportNext", { exportId: first.exportId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await client.call("folders.exportCancel", { exportId: second.exportId });
    await expect(client.call("folders.exportNext", { exportId: second.exportId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a start superseded while it sorts never opens its session (Codex code review round 4 #5)", async () => {
    const { backend, gmail } = await setup();
    await ingest(backend.store, [msg({ accountId: gmail, providerMsgId: "one" })]);
    // every slice of the sort takes its turn; the first turn is where a newer start from the same client lands
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 20));
    let second: Promise<{ exportId: string }> | null = null;
    const exports: FolderExports = new FolderExports(Object.assign(Object.create(backend) as typeof backend, {
      yieldTurn: async () => { if (!second) await (second = exports.start({ accountId: gmail, view: "inbox" }, "c")); },
    }));
    const first = exports.start({ accountId: gmail, view: "inbox" }, "c");
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    vi.mocked(performance.now).mockRestore();
    expect(exports.size).toBe(1);
    expect(await exports.next((await second!).exportId, "c")).toMatchObject({ finished: true, total: 1 });
  });

  it("a start cancelled by its request id stops reading ids, and stops sorting at the next slice (Codex code review round 14 #3)", async () => {
    const { backend, client, gmail } = await setup();
    await ingest(backend.store, Array.from({ length: 300 }, (_, i) => msg({ accountId: gmail, providerMsgId: `m${i}`, providerThreadId: `m${i}` })));
    const reads = vi.spyOn(backend.store.folderExport, "ids");
    // cancelled at its first turn while it reads ids (the renderer has no exportId yet)
    let turns = 0;
    let exports: FolderExports = new FolderExports(Object.assign(Object.create(backend) as typeof backend, {
      yieldTurn: async () => { if (++turns === 1) exports.cancel("r1", "c"); },
    }));
    await expect(exports.start({ accountId: gmail, view: "inbox" }, "c", "r1")).rejects.toMatchObject({ code: "CANCELLED" });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(turns).toBe(1);
    expect(exports.size).toBe(0);
    // cancelled at the sort's first turn: no slice after it
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 20));
    reads.mockClear();
    let sorting = false;
    turns = 0;
    const store = backend.store;
    exports = new FolderExports(Object.assign(Object.create(backend) as typeof backend, {
      store: Object.assign(Object.create(store) as typeof store, { folderExport: Object.assign(Object.create(store.folderExport) as typeof store.folderExport, {
        ids: async (...a: Parameters<typeof store.folderExport.ids>) => { const r = await store.folderExport.ids(...a); if (r.next === null) sorting = true; return r; },
      }) }),
      yieldTurn: async () => { if (!sorting) return; if (++turns === 1) exports.cancel("r2", "c"); },
    }));
    await expect(exports.start({ accountId: gmail, view: "inbox" }, "c", "r2")).rejects.toMatchObject({ code: "CANCELLED" });
    vi.mocked(performance.now).mockRestore();
    expect(turns).toBe(1);
    expect(exports.size).toBe(0);
    // a cancel that arrives before its start: the start reads nothing
    reads.mockClear();
    expect(await client.call("folders.exportCancel", { exportId: "r3" })).toEqual({ ok: true });
    await expect(client.call("folders.exportStart", { accountId: gmail, folder: null, view: "inbox", requestId: "r3" })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(reads).not.toHaveBeenCalled();
    // and another start goes on as ever
    expect((await client.call("folders.exportStart", { accountId: gmail, folder: null, view: "inbox", requestId: "r4" })).total).toBe(300);
  });

  it("a thread merged behind the id walk is read again, and what comes twice is written once (Codex code review round 17 #1)", async () => {
    const { client, backend, gmail } = await setup();
    await backend.store.folders.replace(gmail, [{ key: "Label_w", path: ["Work"], selectable: true }]);
    const day = Date.UTC(2026, 0, 2);
    const labels = ["Label_w"];
    await ingest(backend.store, [
      msg({ accountId: gmail, providerMsgId: "a1", rfcMessageId: "a1@test", subject: "A1", date: day, gmailLabels: labels }),
      msg({ accountId: gmail, providerMsgId: "b1", rfcMessageId: "b1@test", subject: "B1", date: day + 1000, gmailLabels: labels }),
      msg({ accountId: gmail, providerMsgId: "b2", rfcMessageId: "b2@test", inReplyTo: "b1@test", references: ["b1@test"], subject: "B2", date: day + 2000, gmailLabels: labels }),
      msg({ accountId: gmail, providerMsgId: "c1", rfcMessageId: "c1@test", subject: "C1", date: day + 3000, gmailLabels: labels }),
    ]);
    // a thread a stretch; after the first (a1's), a reply to a1 and b2 merges b's thread into a's
    const ids = backend.store.folderExport.ids.bind(backend.store.folderExport);
    let calls = 0;
    vi.spyOn(backend.store.folderExport, "ids").mockImplementation(async (target, after) => {
      const r = await ids(target, after, 1);
      if (++calls === 1) await ingest(backend.store, [msg({ accountId: gmail, providerMsgId: "bridge", rfcMessageId: "bridge@test", inReplyTo: "b2@test", references: ["a1@test", "b2@test"], subject: "Bridge", date: day + 4000, gmailLabels: labels })]);
      return r;
    });
    const start = await client.call("folders.exportStart", { accountId: gmail, folder: "Label_w", view: null });
    const { text } = await drain(client, start.exportId);
    // the bridge arrived after the start: read with a's thread again, or not
    expect(subjects(text).filter((s) => s !== "Bridge")).toEqual(["A1", "B1", "B2", "C1"]);
    expect(start.total).toBe(subjects(text).length);
  });

  it("a session idle for a minute ends by itself", async () => {
    const { backend, gmail } = await setup();
    await ingest(backend.store, [msg({ accountId: gmail, providerMsgId: "one" })]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const exports = new FolderExports(backend);
    const { exportId } = await exports.start({ accountId: gmail, view: "inbox" }, "c");
    vi.advanceTimersByTime(EXPORT_IDLE_MS - 1);
    expect(exports.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(exports.size).toBe(0);
    await expect(exports.next(exportId, "c")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sorts by date then id in slices, as a plain sort would", async () => {
    const n = 20_000;
    const ids = Array.from({ length: n }, (_, i) => n - i);
    const dates = ids.map((id) => Math.floor((id * 7919) % 500));
    let turns = 0;
    const sorted = await sortByDate(ids, dates, async () => { turns++; }, 0);
    const expected = ids.map((id, i) => ({ id, date: dates[i]! })).sort((a, b) => a.date - b.date || a.id - b.id).map((x) => x.id);
    expect(Array.from(sorted)).toEqual(expected);
    expect(turns).toBeGreaterThan(5);
  });
});

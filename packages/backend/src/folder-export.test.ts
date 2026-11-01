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

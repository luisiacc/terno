/**
 * Plan 65: Gmail's user labels as the account's own folders. /labels is read bounded and validated, never on
 * every pass: when it was never read, after 15 quiet minutes, or when a pass met a label it didn't have.
 */
import { FOLDER_NAME_MAX } from "@terno/core";
import type { ProviderFolder } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncomingPipeline } from "./incoming";
import { createNodeIncomingProcessor } from "../../backend/src/incoming-worker";
import { createGmailApiProvider, labelFolders, LABELS_EVERY_MS, toBase64url } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

const MARKER = "PrivateClientName-7f3a";

function setup(o: { labels: () => unknown; messageLabels?: string[]; labelsBody?: () => string }) {
  const processor = createNodeIncomingProcessor();
  const incoming = new IncomingPipeline(processor);
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\nContent-Type: text/plain\r\n\r\nhola"));
  let cursor: unknown = null;
  const requests: string[] = [];
  const ctx = {
    incoming, incomingProcessor: processor,
    account: { id: 1 }, config: {},
    store: { messageByProviderId: async () => null, syncedMessages: async () => [], pendingAttachmentBodies: async () => [] },
    loadCursor: async () => cursor, saveCursor: async (next: unknown) => { cursor = next; },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      requests.push(url.pathname.split("/").at(-1)!);
      if (url.pathname.endsWith("/labels")) return o.labelsBody ? new Response(o.labelsBody(), { headers: { "content-type": "application/json" } }) : Response.json(o.labels());
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
      return Response.json({ id: "m1", threadId: "m1", raw, labelIds: o.messageLabels ?? ["INBOX"] });
    },
  } as unknown as ProviderContext;
  const folders: ProviderFolder[][] = [];
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest() {}, async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
    async setFolders(f) { folders.push([...f]); },
  };
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  return {
    p, sink, folders, requests, get cursor() { return cursor; },
    labelReads: () => requests.filter((r) => r === "labels").length,
    async close() { await p.close(); await processor.close(); incoming.close(); },
  };
}

afterEach(() => vi.useRealTimers());

describe("labelFolders", () => {
  it("lists user labels shown in the label list, nested by '/', in name order; system and hidden ones never", () => {
    expect(
      labelFolders([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" },
        { id: "Label_3", name: "Work / Clients", type: "user" },
        { id: "Label_1", name: "Work", type: "user" },
        { id: "Label_2", name: "Hidden", type: "user", labelListVisibility: "labelHide" },
        { id: "Label_4", name: "Facturas", type: "user", labelListVisibility: "labelShowIfUnread" },
      ]),
    ).toEqual([
      { key: "Label_4", path: ["Facturas"], selectable: true },
      { key: "Label_1", path: ["Work"], selectable: true },
      { key: "Label_3", path: ["Work", "Clients"], selectable: true },
    ]);
  });

  it("caps each name at Gmail's own limit", () => {
    expect(labelFolders([{ id: "Label_1", name: "x".repeat(FOLDER_NAME_MAX + 10), type: "user" }])[0]!.path[0]).toHaveLength(FOLDER_NAME_MAX);
  });
});

describe("when /labels is read", () => {
  it("first after a pass, then not again for 15 quiet minutes, then again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setup({ labels: () => ({ labels: [{ id: "Label_1", name: "Work", type: "user" }] }) });
    try {
      await t.p.sync(t.sink);
      expect(t.labelReads()).toBe(0);
      await t.p.folders!(t.sink);
      expect(t.labelReads()).toBe(1);
      expect(t.folders).toEqual([[{ key: "Label_1", path: ["Work"], selectable: true }]]);
      // the history checkpoint is the sync's alone
      expect(t.cursor).toEqual({ historyId: "10" });
      await t.p.sync(t.sink);
      await t.p.folders!(t.sink);
      expect(t.labelReads()).toBe(1);
      vi.setSystemTime(Date.now() + LABELS_EVERY_MS);
      await t.p.folders!(t.sink);
      expect(t.labelReads()).toBe(2);
    } finally { await t.close(); }
  });

  it("a pass that meets a label /labels didn't have asks for it after the pass; hidden labels are known, never asked for again", async () => {
    const t = setup({ labels: () => ({ labels: [{ id: "Label_1", name: "Hidden", type: "user", labelListVisibility: "labelHide" }] }), messageLabels: ["INBOX", "Label_1"] });
    try {
      await t.p.folders!(t.sink);
      expect(t.folders).toEqual([[]]);
      await t.p.sync(t.sink);
      await t.p.folders!(t.sink);
      expect(t.labelReads()).toBe(1);
    } finally { await t.close(); }
    const u = setup({ labels: () => ({ labels: [] }), messageLabels: ["INBOX", "Label_9"] });
    try {
      await u.p.folders!(u.sink);
      await u.p.sync(u.sink);
      await u.p.folders!(u.sink);
      expect(u.labelReads()).toBe(2);
    } finally { await u.close(); }
  });
});

describe("bounds and privacy", () => {
  it("a malformed catalog fails with a fixed message that never carries a label's name", async () => {
    for (const bad of [{ labels: "nope" }, { labels: [{ id: 3, name: MARKER }] }, { labels: [{ id: "Label_1", name: MARKER.repeat(200) }] }]) {
      const t = setup({ labels: () => bad });
      try {
        const error = await t.p.folders!(t.sink).then(() => null, (e: unknown) => e as Error);
        expect(error).toBeInstanceOf(Error);
        expect(String(error!.message)).not.toContain(MARKER);
        expect(JSON.stringify(error)).not.toContain(MARKER);
        expect(t.folders).toEqual([]);
      } finally { await t.close(); }
    }
  });

  it("an oversized answer is refused without reading it whole", async () => {
    const t = setup({ labels: () => null, labelsBody: () => `{"labels":[${Array.from({ length: 30_000 }, (_, i) => JSON.stringify({ id: `Label_${i}`, name: `${MARKER}${"y".repeat(150)}`, type: "user" })).join(",")}]}` });
    try {
      const error = await t.p.folders!(t.sink).then(() => null, (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error!.message)).not.toContain(MARKER);
      expect(t.folders).toEqual([]);
    } finally { await t.close(); }
  });
});

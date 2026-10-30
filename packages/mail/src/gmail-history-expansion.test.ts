import { expect, it } from "vitest";
import { createGmailApiProvider } from "./gmail-api";
import type { FlagUpdate, ProviderContext, SyncSink } from "./types";

it("characterizes expanded overlapping history and retains the checkpoint on a later GET failure", async () => {
  const ids = Array.from({ length: 501 }, (_, i) => `m${i + 1}`);
  const refs = ids.map((id) => ({ message: { id } }));
  const history = [
    { historyId: "11", nextPageToken: "next", history: [{ labelsAdded: refs }] },
    { historyId: "12", history: [{ labelsRemoved: [refs[0], refs[500]] }] },
  ];
  const payloadBytes = history.map((page) => new TextEncoder().encode(JSON.stringify(page)).length);
  let cursor: unknown = { historyId: "10" }, fail = true;
  const checkpoints: unknown[] = [], requests: string[] = [], batches: FlagUpdate[][] = [];
  const ctx = {
    account: { id: 1, email: "me@example.com" }, config: {},
    store: {
      messageByProviderId: async (id: string) => ({ id: ids.indexOf(id) + 1, providerMsgId: id }),
      pendingAttachmentBodies: async () => [],
    },
    loadCursor: async () => cursor,
    saveCursor: async (value: unknown) => { cursor = value; checkpoints.push(value); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/history")) {
        expect(url.searchParams.get("maxResults")).toBe("500");
        expect(url.searchParams.getAll("historyTypes")).toEqual(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
        requests.push(`history:${url.searchParams.get("startHistoryId")}:${url.searchParams.get("pageToken") ?? "first"}`);
        return Response.json(history[url.searchParams.has("pageToken") ? 1 : 0]);
      }
      expect(url.pathname).toMatch(/\/messages\/m\d+$/);
      expect(url.searchParams.get("format")).toBe("minimal");
      const id = url.pathname.split("/").at(-1)!;
      requests.push(id);
      if (id === "m501" && fail) return new Response(null, { status: 503 });
      return Response.json({ id, labelIds: id === "m1" ? ["STARRED"] : ["INBOX", "UNREAD"] });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    ingest: async () => { throw new Error("unexpected ingest"); },
    updateFlags: async (updates) => { batches.push(updates); },
    removeMessages: async () => { throw new Error("unexpected removal"); },
    setBody: async () => {}, setSyncState: async () => {}, pendingMessageIds: async () => new Set(),
  };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  try {
    await expect(provider.sync(sink)).rejects.toThrow();
    expect(checkpoints).toEqual([]);
    expect(batches).toEqual([]);
    expect(requests).toEqual(["history:10:first", "history:10:next", ...ids]);
    fail = false;
    requests.length = 0;
    await provider.sync(sink);
    expect(requests).toEqual(["history:10:first", "history:10:next", ...ids]);
    expect(payloadBytes).toEqual([12989, 100]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(ids.map((id, i) => ({
      messageId: i + 1, expectedProviderMsgId: id,
      flags: { inInbox: i !== 0, isRead: i === 0, isStarred: i === 0, isSent: false, isDraft: false, isTrash: false, isSpam: false },
      gmailLabels: i === 0 ? ["STARRED"] : ["INBOX", "UNREAD"],
    })));
    expect(checkpoints).toEqual([{ historyId: "12" }]);
  } finally { await provider.close(); }
});

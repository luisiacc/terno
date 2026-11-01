import { afterEach, expect, it } from "vitest";
import { createGmailApiProvider } from "./gmail-api";
import type { MailProvider, ProviderContext, SyncSink } from "./types";

// Plan 62 fix: a sync pass that gives up doesn't let its paced reads leave afterwards (Codex review).
const providers: MailProvider[] = [];
afterEach(async () => { for (const provider of providers.splice(0)) await provider.close(); });

it("when one flag read fails, the reads still waiting on the quota never leave", async () => {
  let failed = false;
  const late: string[] = [];
  const ctx = {
    flagObservation: true, account: { id: 1 }, config: {},
    store: { pendingFlagSnapshots: async () => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, providerMsgId: `m${i}` })), throughMessageId: 50, hasMore: false }), messageByProviderId: async () => null, syncedMessages: async () => [], syncedMessagePage: async () => ({ items: [] }), pendingAttachmentBodies: async () => [] },
    loadCursor: async () => ({ historyId: "10" }), saveCursor: async () => {},
    fetch: async (input: string | URL) => {
      const id = new URL(String(input)).pathname.split("/").at(-1)!;
      if (failed) late.push(id);
      if (id === "m44") { await new Promise((resolve) => setTimeout(resolve, 10)); failed = true; return new Response("synthetic failure", { status: 500 }); }
      return Response.json({ id, labelIds: [] });
    },
  } as unknown as ProviderContext;
  // minimal reads cost 20: the 900-unit burst lets 45 go at once, the rest wait about 33 ms each
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array(), unitsPerSecond: 600 });
  providers.push(provider);
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest() {}, async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  await expect(provider.sync(sink)).rejects.toMatchObject({ name: "ProviderError" });
  expect(late).toEqual([]);
});

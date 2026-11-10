/** Plan 176: Gmail's quick pass is history since the cursor and nothing else. */
import { describe, expect, it } from "vitest";
import { createGmailApiProvider } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

function rig(o: { cursor: unknown; history?: () => Response }) {
  const paths: string[] = [], saved: unknown[] = [], maintenance: string[] = [];
  let again = 0;
  const upkeep = (name: string) => async () => { maintenance.push(name); return { items: [], hasMore: false }; };
  const ctx = {
    account: { id: 1, email: "me@example.test" }, config: {}, flagObservation: true,
    store: {
      messageByProviderId: async () => undefined,
      pendingAttachmentBodies: upkeep("attachments"),
      pendingFlagSnapshots: upkeep("flags"),
      repairs: { list: upkeep("repairs"), get: upkeep("repair") },
    },
    loadCursor: async () => o.cursor,
    saveCursor: async (value: unknown) => void saved.push(value),
    google: {
      generation: () => 0, check() {}, prove: async () => {},
      request: async (_descriptor: unknown, input: string, init: RequestInit) => {
        const path = new URL(new Request(input, init).url).pathname;
        paths.push(path.replace("/gmail/v1/users/me", ""));
        if (path.endsWith("/history")) return o.history?.() ?? Response.json({ historyId: "10" });
        return Response.json({ emailAddress: "me@example.test", historyId: "30" });
      },
    },
  } as unknown as ProviderContext;
  const unexpected = async () => { throw new Error("Unexpected effect"); };
  const sink: SyncSink = { quick: true, signal: new AbortController().signal, windowStart: 0, ingest: unexpected, updateFlags: unexpected,
    removeMessages: unexpected, setBody: unexpected, setSyncState: async () => {}, pendingMessageIds: async () => new Set(),
    again: () => void again++, backfill: { since: 1_000, until: 2_000 } };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  return { provider, sink, paths, saved, maintenance, again: () => again };
}

describe("Gmail's quick pass (plan 176)", () => {
  it("takes quick checks, and with nothing new is one /history read: no repairs, flags, captures, backfill or labels", async () => {
    const backfill = { since: 1_000, until: 2_000, pages: 3, next: "page-4" };
    const t = rig({ cursor: { historyId: "10", backfill } });
    try {
      expect(t.provider.quickChecks).toBe(true);
      await t.provider.sync(t.sink);
      expect(t.paths).toEqual(["/history"]);
      expect(t.maintenance).toEqual([]);
      expect(t.again()).toBe(0);
      // the backfill's place rides along on the save, as in every pass
      expect(t.saved).toEqual([{ historyId: "10", backfill }]);
    } finally { await t.provider.close(); }
  });

  it("a first sync or catch-up under way, or history that expired, asks for an ordinary pass and reads nothing more", async () => {
    for (const t of [
      rig({ cursor: null }),
      rig({ cursor: { historyId: "10", reconciliation: { version: 1 } } }),
      rig({ cursor: { historyId: "10" }, history: () => Response.json({ error: { code: 404 } }, { status: 404 }) }),
    ]) {
      try {
        await t.provider.sync(t.sink);
        expect(t.again()).toBe(1);
        expect(t.paths.filter((p) => p !== "/history")).toEqual([]);
        expect(t.maintenance).toEqual([]);
        expect(t.saved).toEqual([]);
      } finally { await t.provider.close(); }
    }
  });
});

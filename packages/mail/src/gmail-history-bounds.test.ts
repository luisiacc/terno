import { expect, it } from "vitest";
import { createGmailApiProvider } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

it("cancels an oversized decoded history stream before parsing or admitting effects", async () => {
  let canceled = false, pulls = 0, proofs = 0;
  const checkpoints: unknown[] = [], paths: string[] = [];
  const controller = new AbortController();
  const ctx = {
    account: { id: 1, email: "me@example.test" }, config: {}, store: { pendingAttachmentBodies: async () => [] },
    loadCursor: async () => ({ historyId: "10" }),
    saveCursor: async (value: unknown) => { checkpoints.push(value); controller.abort(new Error("Pause reconciliation")); },
    google: {
      generation: () => 0, check() {},
      prove: async (proof: () => Promise<string>) => { if (!proofs++) expect(await proof()).toBe("me@example.test"); },
      request: async (_descriptor: unknown, input: string, init: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path.endsWith("/profile")) return Response.json({ emailAddress: "me@example.test", historyId: "20" });
        expect(path).toMatch(/\/history$/);
        // No Content-Length. Actual decoded bytes, including ignored fields, must be counted.
        return new Response(new ReadableStream<Uint8Array>({
          pull(c) { pulls++; if (pulls === 22) { c.enqueue(new TextEncoder().encode('","historyId":"20"}')); c.close(); return; } c.enqueue(new TextEncoder().encode(pulls === 1 ? '{"ignored":"' : "x".repeat(16_384))); },
          cancel() { canceled = true; },
        }), { headers: { "content-length": "1" } });
      },
    },
  } as unknown as ProviderContext;
  const unexpected = async () => { throw new Error("Unexpected effect"); };
  const sink: SyncSink = { signal: controller.signal, windowStart: 0, ingest: unexpected, updateFlags: unexpected,
    removeMessages: unexpected, setBody: unexpected, setSyncState: async () => {}, pendingMessageIds: async () => new Set() };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  try {
    await expect(provider.sync(sink)).rejects.toThrow("Pause reconciliation");
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(19);
    expect(paths.filter((p) => p.endsWith("/history"))).toHaveLength(1);
    expect(checkpoints).toEqual([{ historyId: "10", reconciliation: expect.objectContaining({ stage: "enumerate", baseline: "20" }) }]);
  } finally { await provider.close(); }
});

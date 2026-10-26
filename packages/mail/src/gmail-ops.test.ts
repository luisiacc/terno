import { describe, expect, it } from "vitest";
import { createGmailApiProvider } from "./gmail-api";
import { ProviderError, type ProviderContext } from "./types";

function mailbox(count = 3, successStatus = 204) {
  const labels = new Map(Array.from({ length: count }, (_, i) => [`g${i + 1}`, new Set(["TRASH", "STARRED", "custom"])]));
  const batches: string[][] = [];
  const requests: string[] = [];
  let failBatch: { index: number; status: number } | null = null;
  let loseResponse: number | null = null;
  let onBatch: ((index: number) => void) | undefined;
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path.endsWith("/untrash")) return new Response('{"error":{"code":503}}', { status: 503 });
    if (!path.endsWith("/batchModify")) throw new Error(`unexpected request ${path}`);
    const body = JSON.parse(String(init?.body)) as { ids: string[]; addLabelIds: string[]; removeLabelIds: string[] };
    batches.push(body.ids);
    onBatch?.(batches.length);
    if (body.ids.length > 1000) return new Response('{"error":{"code":400}}', { status: 400 });
    if (failBatch?.index === batches.length) return new Response(JSON.stringify({ error: { code: failBatch.status } }), { status: failBatch.status });
    for (const id of body.ids) {
      const current = labels.get(id)!;
      for (const label of body.removeLabelIds) current.delete(label);
      for (const label of body.addLabelIds) current.add(label);
    }
    if (loseResponse === batches.length) throw new TypeError("fetch failed", { cause: Object.assign(new Error("response lost after application"), { code: "UND_ERR_SOCKET" }) });
    return new Response(null, { status: successStatus });
  }) as typeof globalThis.fetch;
  const ctx = {
    account: { id: 1, email: "me@gmail.com" }, config: {}, fetch,
    store: { providerIds: async (ids: number[]) => new Map(ids.map((id) => [id, `g${id}`])) },
  } as unknown as ProviderContext;
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "token", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const restore = (ids = Array.from({ length: count }, (_, i) => i + 1)) => provider.execute({ id: "restore", kind: "moveToInbox", target: { messageIds: ids }, payload: {} });
  return { labels, batches, requests, restore, fail: (index: number, status: number) => { failBatch = { index, status }; }, loseResponse: (index: number) => { loseResponse = index; }, onBatch: (fn: (index: number) => void) => { onBatch = fn; } };
}

describe("Gmail restore to inbox", () => {
  it("restores trash, spam and archived mail without losing unrelated labels", async () => {
    const box = mailbox();
    box.labels.set("g2", new Set(["SPAM", "UNREAD"]));
    box.labels.set("g3", new Set(["INBOX"]));
    await box.restore();
    expect([...box.labels.get("g1")!].sort()).toEqual(["INBOX", "STARRED", "custom"]);
    expect([...box.labels.get("g2")!].sort()).toEqual(["INBOX", "UNREAD"]);
    expect([...box.labels.get("g3")!]).toEqual(["INBOX"]);
    expect(box.requests).toHaveLength(1);
  });

  it.each([200, 204])("accepts an empty HTTP %i mutation acknowledgement", async (status) => {
    const box = mailbox(1, status);
    await expect(box.restore()).resolves.toBeUndefined();
    expect(box.labels.get("g1")?.has("TRASH")).toBe(false);
    expect(box.labels.get("g1")?.has("INBOX")).toBe(true);
  });

  it("restores 1,001 captured messages in two bounded requests, leaving uncaptured mail alone", async () => {
    const box = mailbox(1001);
    box.labels.set("uncaptured", new Set(["TRASH"]));
    await box.restore();
    expect(box.batches.map((b) => b.length)).toEqual([1000, 1]);
    expect(new Set(box.batches.flat()).size).toBe(1001);
    expect([...box.labels.values()].filter((ls) => ls.has("INBOX"))).toHaveLength(1001);
    expect([...box.labels.get("uncaptured")!]).toEqual(["TRASH"]);
    expect(box.requests).toHaveLength(2);
  });

  it("a failed second chunk remains retryable and replay safely converges on the same target set", async () => {
    const box = mailbox(1001);
    box.fail(2, 503);
    await expect(box.restore()).rejects.toMatchObject({ retryable: true, ambiguous: false });
    expect(box.batches).toHaveLength(2);
    expect(box.labels.get("g1")?.has("INBOX")).toBe(true);
    expect(box.labels.get("g1001")?.has("TRASH")).toBe(true);
    await box.restore();
    expect([...box.labels.values()].every((ls) => ls.has("INBOX") && !ls.has("TRASH"))).toBe(true);
    expect(box.labels.size).toBe(1001);
  });

  it("a lost response after chunk two stops chunk three, and replay excludes mail arriving between chunks", async () => {
    const box = mailbox(2001);
    box.loseResponse(2);
    box.onBatch((index) => { if (index === 2) box.labels.set("late-arrival", new Set(["TRASH"])); });
    await expect(box.restore()).rejects.toMatchObject({ retryable: true, network: true });
    expect(box.batches.map((b) => b.length)).toEqual([1000, 1000]);
    expect(box.labels.get("g2000")?.has("INBOX")).toBe(true);
    expect(box.labels.get("g2001")?.has("TRASH")).toBe(true);
    await box.restore();
    expect(box.batches.map((b) => b.length)).toEqual([1000, 1000, 1000, 1000, 1]);
    expect([...box.labels.values()].filter((ls) => ls.has("INBOX"))).toHaveLength(2001);
    expect([...box.labels.get("late-arrival")!]).toEqual(["TRASH"]);
    expect(new Set(box.batches.flat())).toEqual(new Set([...box.labels.keys()].filter((id) => id !== "late-arrival")));
  });

  it.each([[403, false], [429, true], [503, true]] as const)("an HTTP %i refusal cannot be mistaken for restored mail", async (status, retryable) => {
    const box = mailbox(1);
    box.fail(1, status);
    const error = await box.restore().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status, retryable, ambiguous: false });
    expect([...box.labels.get("g1")!].sort()).toEqual(["STARRED", "TRASH", "custom"]);
  });
});

import { base64Bytes, ORIGINAL_PIECE } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { ProviderError } from "@terno/mail/portable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORIGINAL_IDLE_MS, Originals, type OriginalRead } from "./originals";

const source = (size: number) => {
  const head = new TextEncoder().encode("Subject: big\r\n\r\n");
  const out = new Uint8Array(size).fill(0x61);
  out.set(head);
  return out;
};

/** reads answered by hand: each open waits until `answer` */
function reads() {
  const pending: { signal: AbortSignal; resolve(r: OriginalRead): void; reject(e: unknown): void }[] = [];
  const originals = new Originals((_t, _m, signal) => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })));
  return { originals, pending, answer: async (i: number, r: OriginalRead) => { pending[i]!.resolve(r); await Promise.resolve(); } };
}

afterEach(() => { vi.useRealTimers(); });

describe("Originals (plan 272)", () => {
  it("describes what it read and hands it back in pieces that add up to it", async () => {
    const bytes = source(ORIGINAL_PIECE * 2 + 10);
    const originals = new Originals(async () => ({ accountId: 1, bytes }));
    const view = await originals.open({ threadId: 1, messageId: 2, requestId: "r1" }, "c1");
    expect(view).toMatchObject({ size: bytes.length, pieces: 3, summary: { subject: "big" }, sourceCut: true });
    const pieces = [0, 1, 2].map((index) => base64Bytes(originals.piece("r1", index, "c1").dataBase64, ORIGINAL_PIECE));
    expect(pieces.map((p) => p.length)).toEqual([ORIGINAL_PIECE, ORIGINAL_PIECE, 10]);
    const whole = new Uint8Array(bytes.length);
    let at = 0;
    for (const p of pieces) { whole.set(p, at); at += p.length; }
    expect(whole).toEqual(bytes);
    expect(() => originals.piece("r1", 3, "c1")).toThrow(RpcError);
  });

  it("is another client's to read only by that client", async () => {
    const originals = new Originals(async () => ({ accountId: 1, bytes: source(100) }));
    await originals.open({ threadId: 1, messageId: 2, requestId: "r1" }, "c1");
    expect(() => originals.piece("r1", 0, "c2")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    originals.close("r1", "c2");
    expect(originals.piece("r1", 0, "c1").dataBase64).toBeTruthy();
  });

  it("passes on a reason there's no original", async () => {
    const originals = new Originals(async () => ({ unavailable: "local" }));
    expect(await originals.open({ threadId: 1, messageId: 2, requestId: "r1" }, "c1")).toEqual({ unavailable: "local" });
    expect(originals.size).toBe(0);
  });

  it("keeps two at most, the oldest let go", async () => {
    const originals = new Originals(async () => ({ accountId: 1, bytes: source(100) }));
    for (const requestId of ["r1", "r2", "r3"]) await originals.open({ threadId: 1, messageId: 2, requestId }, "c1");
    expect(() => originals.piece("r1", 0, "c1")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(originals.piece("r3", 0, "c1").dataBase64).toBeTruthy();
    expect(originals.size).toBe(2);
  });

  it("lets one go after two minutes untouched; a piece read keeps it", async () => {
    vi.useFakeTimers();
    const originals = new Originals(async () => ({ accountId: 1, bytes: source(100) }));
    await originals.open({ threadId: 1, messageId: 2, requestId: "r1" }, "c1");
    vi.advanceTimersByTime(ORIGINAL_IDLE_MS - 1);
    originals.piece("r1", 0, "c1");
    vi.advanceTimersByTime(ORIGINAL_IDLE_MS - 1);
    expect(originals.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(originals.size).toBe(0);
  });

  it("cancels a read closed before it answered, and drops what it brings", async () => {
    const { originals, pending, answer } = reads();
    const opened = originals.open({ threadId: 1, messageId: 2, requestId: "r1" }, "c1");
    await Promise.resolve();
    originals.close("r1", "c1");
    expect(pending[0]!.signal.aborted).toBe(true);
    await answer(0, { accountId: 1, bytes: source(100) });
    await expect(opened).rejects.toMatchObject({ code: "CANCELLED" });
    expect(originals.size).toBe(0);
  });

  it("reads two at a time at most", async () => {
    const { originals } = reads();
    void originals.open({ threadId: 1, messageId: 2, requestId: "r1" }, "c1").catch(() => {});
    void originals.open({ threadId: 1, messageId: 3, requestId: "r2" }, "c1").catch(() => {});
    await expect(originals.open({ threadId: 1, messageId: 4, requestId: "r3" }, "c1")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("lets an account's originals go with it", async () => {
    let accountId = 1;
    const originals = new Originals(async () => ({ accountId: accountId++, bytes: source(100) }));
    await originals.open({ threadId: 1, messageId: 2, requestId: "r1" }, "c1");
    await originals.open({ threadId: 1, messageId: 3, requestId: "r2" }, "c1");
    originals.dropAccount(1);
    expect(() => originals.piece("r1", 0, "c1")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(originals.piece("r2", 0, "c1").dataBase64).toBeTruthy();
  });

  it("says plainly that the server couldn't be reached, and passes on the server's own refusal", async () => {
    const offline = new Originals(async () => { throw ProviderError.network("socket closed"); });
    await expect(offline.open({ threadId: 1, messageId: 2, requestId: "r1" }, "c1")).rejects.toMatchObject({ code: "UNAVAILABLE", i18n: { key: "errors.original.unreachable" } });
    const big = new Originals(async () => { throw new ProviderError("too big", false); });
    await expect(big.open({ threadId: 1, messageId: 2, requestId: "r1" }, "c1")).rejects.toMatchObject({ code: "UNAVAILABLE", message: "too big" });
  });
});

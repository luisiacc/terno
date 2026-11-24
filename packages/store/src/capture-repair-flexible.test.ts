import { describe, expect, it } from "vitest";
import { blockCapture, CAPTURE_REPAIR_BYTES, captureRepair, captureRowBytes, describeCapture, retryCapture, type CaptureRepairRow, type CaptureRepairStorage } from "./capture-repair";

/** plan 267: the store holds the logic the table no longer does (its reasons), on a storage that keeps rows in memory */
function storage(usedBytes = 0): CaptureRepairStorage & { rows: Map<string, CaptureRepairRow> } {
  const rows = new Map<string, CaptureRepairRow>();
  return {
    rows,
    get: (_, key) => rows.get(key),
    usage: () => ({ count: rows.size, bytes: usedBytes + [...rows.values()].reduce((n, r) => n + r.bytes, 0) }),
    messageId: () => null,
    envelope: () => undefined,
    valid: () => true,
    put: (r) => { rows.set(r.key, { ...r }); },
    remove: (_, key) => { rows.delete(key); },
    page: () => [...rows.values()],
  };
}
const gmail = (id: string) => ({ kind: "gmail" as const, providerId: id });

describe("capture repairs without a list in the table (plan 267)", () => {
  it("reads a reason this build doesn't know as unknown, and a retry keeps it as it was", () => {
    const db = storage();
    blockCapture(db, 1, gmail("p"), "mime-parts", 0);
    const row = [...db.rows.values()][0]!;
    db.rows.set(row.key, { ...row, reason: "mime-future" });
    expect(captureRepair(db.rows.get(row.key)!).reason).toBe("unknown");
    retryCapture(db, 1, row.key, 0);
    expect(db.rows.get(row.key)).toMatchObject({ reason: "mime-future", state: "pending", revision: 1 });
  });

  it("refuses to write a reason it doesn't know", () => {
    expect(() => blockCapture(storage(), 1, gmail("p"), "mime-future" as never, 0)).toThrow("Invalid capture reason");
  });

  it("counts no bytes for a missing detail, absent or null, and drops a malformed one on read", () => {
    const base: CaptureRepairRow = { account_id: 1, key: '["gmail","p"]', message_id: null, locator: JSON.stringify(gmail("p")), reason: "mime-parts", state: "blocked", revision: 0, bytes: 0 };
    expect(captureRowBytes({ ...base, detail: null })).toBe(captureRowBytes(base));
    expect(captureRowBytes({ ...base, detail: '{"subject":"Hi"}' })).toBeGreaterThan(captureRowBytes(base));
    expect(captureRepair({ ...base, detail: "{not json" }).detail).toBeUndefined();
    expect(captureRepair({ ...base, detail: '{"subject":"","date":-4,"from":7}' }).detail).toBeUndefined();
  });

  it("near the byte cap a repair is kept without its detail, and a detail that wouldn't fit isn't added", () => {
    const tight = storage(CAPTURE_REPAIR_BYTES - 300);
    tight.envelope = () => ({ subject: "S".repeat(200), from: "F".repeat(200), date: 1 });
    tight.messageId = () => 9;
    blockCapture(tight, 1, gmail("near"), "mime-depth", 0);
    const row = [...tight.rows.values()][0]!;
    expect(row.detail).toBeNull();
    describeCapture(tight, 1, row.key, 0, { subject: "S".repeat(200), from: "F".repeat(200) });
    expect(tight.rows.get(row.key)!.detail).toBeNull();
  });
});

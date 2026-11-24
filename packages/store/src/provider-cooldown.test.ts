import { describe, expect, it } from "vitest";
import { compactCooldown, decodeCooldown, encodeCooldown, mergeCooldownRows, OVERFLOW_QUARANTINE_MS, type CooldownLedger, type CooldownRow } from "./provider-cooldown";

const A = "a".repeat(64), B = "b".repeat(64);
const row = (over: Partial<CooldownRow> = {}): CooldownRow => ({ owner: A, service: "gmail-api", revision: "10", phaseRevision: "10", minimum: "3601000", wall: "1000", replay: "3600000", sample: 2000, position: 1, hold: null, repair: null, ...over });
const ledger = (over: Partial<CooldownLedger> = {}): string => encodeCooldown({ version: 1, revision: "20", overflow: false, bindings: [], rows: [], ...over });
const binding = (id: number, key: string) => ({ id, createdAt: id, emailDigest: key, mailboxKey: key });

describe("plan 264: a success retires a met pause", () => {
  it("a row fenced at or after the stored revision replaces its minimum and replay", () => {
    const retired = row({ revision: "12", phaseRevision: "12", minimum: "5000000", wall: "5000000", replay: "0", position: 0, repair: "11" });
    // revision 11 never reached disk (pending, then retired): the fence still covers the older stored 10
    expect(mergeCooldownRows(row(), retired)).toMatchObject({ revision: "12", replay: "0", minimum: "5000000", position: 0 });
    expect(mergeCooldownRows(retired, row())).toMatchObject({ revision: "12", replay: "0", minimum: "5000000" });
  });

  it("a newer refusal is never lowered by an older retirement, and an unfenced row keeps the larger wait", () => {
    const retired = row({ revision: "12", phaseRevision: "12", minimum: "5000000", wall: "5000000", replay: "0", position: 0, repair: "10" });
    const newer = row({ revision: "13", phaseRevision: "13", minimum: "5002000", wall: "5000000", replay: "2000", position: 1, repair: "10" });
    expect(mergeCooldownRows(retired, newer)).toMatchObject({ revision: "13", replay: "2000", minimum: "5002000" });
    const unfenced = row({ revision: "12", phaseRevision: "12", minimum: "5000000", replay: "0", position: 0 });
    expect(mergeCooldownRows(row(), unfenced)).toMatchObject({ replay: "3600000", minimum: "5000000" });
  });
});

describe("plan 264: a start compacts the ledger", () => {
  const live = (...ids: number[]) => (id: number) => ids.includes(id);

  it("drops removed accounts' bindings and retired rows, and keeps every other row, bound or not", () => {
    const retired = row({ owner: B, minimum: "1000", replay: "0", position: 0 });
    const active = row();
    const unboundWaiting = row({ owner: "c".repeat(64), minimum: "2000", replay: "3600000" });
    const held = row({ owner: B, service: "oauth-token", minimum: "1000", replay: "0", position: 0, hold: "clock-evidence" });
    const out = decodeCooldown(compactCooldown(ledger({ bindings: [binding(1, A), binding(2, B)], rows: [retired, active, unboundWaiting, held] }), live(1), 10_000));
    expect(out.bindings.map((b) => b.id)).toEqual([1]);
    expect(out.rows).toEqual([active, unboundWaiting, held]);
  });

  it("clears an overflow only when everything fits, and then pauses every service at the installation", () => {
    const out = decodeCooldown(compactCooldown(ledger({ overflow: true, bindings: [binding(1, A)], rows: [row()] }), live(1), 10_000));
    expect(out.overflow).toBe(false);
    for (const service of ["gmail-api", "oauth-token", "google-userinfo"] as const) {
      expect(out.rows.find((r) => r.owner === "installation" && r.service === service)).toMatchObject({ minimum: String(10_000 + OVERFLOW_QUARANTINE_MS), wall: "10000", replay: String(OVERFLOW_QUARANTINE_MS), hold: null });
    }
    expect(out.rows.find((r) => r.owner === A)).toEqual(row());
  });

  it("keeps an overflow that still doesn't fit", () => {
    const keys = Array.from({ length: 200 }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
    const encoded = ledger({ overflow: true, bindings: keys.map((key, i) => binding(i + 1, key)) });
    expect(decodeCooldown(compactCooldown(encoded, () => true, 10_000)).overflow).toBe(true);
  });
});

describe("plan 264 (Codex review): a repair covers every hold up to its fence", () => {
  it("a repair of a later in-memory clock hold still clears the saved hold an earlier lift handled", () => {
    const saved = row({ revision: "1", phaseRevision: "1", hold: "clock-evidence" });
    // lift (2, repair 1) queued, clock stepped: held again (3) in memory and repaired (4, repair 3); only 4 reaches disk
    const repaired = row({ revision: "4", phaseRevision: "1", hold: null, repair: "3" });
    expect(mergeCooldownRows(saved, repaired).hold).toBeNull();
    expect(mergeCooldownRows(row({ revision: "5", phaseRevision: "1", hold: "range" }), repaired).hold).toBe("range");
  });
});

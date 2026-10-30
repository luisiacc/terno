/**
 * Plan 20 (Codex review, round 2): the ops queue's scheduling queries run on every worker pass and
 * every sync, synchronously on the web's worker. They must not scale with the size of a bulk move
 * or with the account's history. Rows are written straight into the in-memory tables (fast fixtures).
 */
import { AWAITING_NETWORK } from "@terno/store";
import { describe, expect, it, vi } from "vitest";
import { claimReadyOps, nextOpAttemptAt, resumeNetworkOps, type Ctx } from "./mail";
import { createMemDb } from "./schema";

function ctx(): Ctx {
  const db = createMemDb();
  db.tx(() => db.table("accounts").insert({ id: 1 }));
  return { db } as unknown as Ctx;
}

const op = (id: string, seq: number, over: Record<string, unknown> = {}) => ({ id, seq, account_id: 1, kind: "archive", target_json: "{}", payload_json: "null", state: "queued", attempts: 0, next_attempt_at: 0, last_error: null, created_at: 0, updated_at: 0, ...over });
const time = (fn: () => unknown) => {
  const started = performance.now();
  fn();
  return performance.now() - started;
};

describe("ops scheduling at scale (IndexedDB)", () => {
  it("a parked bulk archive and a trash over the same 100,000 messages: scheduling doesn't walk them", () => {
    const c = ctx();
    c.db.tx(() => {
      const ops = c.db.table("ops");
      const targets = c.db.table("op_targets");
      ops.insert(op("archive", 1, { next_attempt_at: AWAITING_NETWORK }));
      ops.insert(op("trash", 2, { kind: "trash" }));
      for (let m = 1; m <= 100_000; m++) {
        targets.insert({ op_id: "archive", message_id: m, grp: "location" });
        targets.insert({ op_id: "trash", message_id: m, grp: "location" });
      }
    });
    let next: number | null = 0;
    let claimed: unknown[] = [1];
    // warm the code paths once (the JIT), then measure
    nextOpAttemptAt(c);
    const tNext = time(() => (next = nextOpAttemptAt(c)));
    const tClaim = time(() => (claimed = claimReadyOps(c, 10, 25)));
    expect(next).toBeNull();
    expect(claimed).toEqual([]);
    // the trash stops at its first message (the archive is older); walking every target took 30-60 ms
    expect(tNext).toBeLessThan(10);
    expect(tClaim).toBeLessThan(10);
  });

  it("resuming an account's parked ops reads the queue, not its 300,000 settled ops", () => {
    const c = ctx();
    c.db.tx(() => {
      const ops = c.db.table("ops");
      for (let i = 1; i <= 300_000; i++) ops.insert(op(`done-${i}`, i, { state: "succeeded" }));
      ops.insert(op("parked", 300_001, { next_attempt_at: AWAITING_NETWORK }));
    });
    c.db.tx(() => resumeNetworkOps(c, 1, 0));
    c.db.tx(() => c.db.table("ops").update(c.db.table("ops").get("parked")!, { next_attempt_at: AWAITING_NETWORK }));
    let ids: string[] = [];
    const took = time(() => c.db.tx(() => (ids = resumeNetworkOps(c, 1, 0))));
    expect(ids).toEqual(["parked"]);
    // every successful sync runs this: the whole history took 30-50 ms each time
    expect(took).toBeLessThan(5);
  });
});


it.each(["next", "claim"])("early-blocked %s reads only the first of 100,000 candidate targets", (query) => {
  const c = ctx();
  const ops = c.db.table("ops"), targets = c.db.table("op_targets");
  c.db.tx(() => {
    ops.insert(op("archive", 1, { next_attempt_at: AWAITING_NETWORK }));
    ops.insert(op("trash", 2, { kind: "trash" }));
    for (let m = 1; m <= 100_000; m++) {
      targets.insert({ op_id: "archive", message_id: m, grp: "location" });
      targets.insert({ op_id: "trash", message_id: m, grp: "location" });
    }
  });
  const before = [...ops.all()];
  const reads = vi.spyOn(targets.rows, "get");
  let result: unknown, count: number;
  try {
    result = query === "next" ? nextOpAttemptAt(c) : claimReadyOps(c, 10, 25);
    count = reads.mock.calls.length;
  } finally { reads.mockRestore(); }
  expect(result).toEqual(query === "next" ? null : []);
  expect([...ops.all()]).toEqual(before);
  expect(count).toBe(3);
});

it.each([
  ["queued", 1000, true], ["queued", AWAITING_NETWORK, true], ["running", 0, true],
  ["unknown", 0, false], ["failed", 0, false], ["succeeded", 0, false],
] as const)("retained %s predecessor at %s blocks=%s", (state, next, blocked) => {
  const c = ctx(), ops = c.db.table("ops"), targets = c.db.table("op_targets");
  c.db.tx(() => {
    ops.insert(op("older", 1, { state, next_attempt_at: next, attempts: 7 }));
    ops.insert(op("newer", 2, { kind: "trash", attempts: 2 }));
    for (const id of ["older", "newer"]) targets.insert({ op_id: id, message_id: 1, grp: "location" });
  });
  expect(nextOpAttemptAt(c)).toBe(!blocked ? 0 : state === "queued" && next === 1000 ? 1000 : null);
  expect(claimReadyOps(c, 10, 25).map(o => [o.id, o.attempts])).toEqual(blocked ? [] : [["newer", 3]]);
  expect(ops.get("older")).toMatchObject({ state, attempts: 7, next_attempt_at: next });
});

it("checks both groups and later targets, then refreshes ownership on the next pass", () => {
  const c = ctx(), ops = c.db.table("ops"), targets = c.db.table("op_targets");
  c.db.tx(() => {
    ops.insert(op("older", 1, { next_attempt_at: AWAITING_NETWORK }));
    ops.insert(op("newer", 2, { kind: "trash" }));
    targets.insert({ op_id: "older", message_id: 1, grp: "location" });
    targets.insert({ op_id: "older", message_id: 2, grp: "read" });
    targets.insert({ op_id: "older", message_id: 3, grp: "location" });
    targets.insert({ op_id: "newer", message_id: 1, grp: "read" });
    targets.insert({ op_id: "newer", message_id: 2, grp: "location" });
    targets.insert({ op_id: "newer", message_id: 3, grp: "location" });
  });
  expect(nextOpAttemptAt(c)).toBeNull();
  expect(claimReadyOps(c, 10, 25)).toEqual([]);
  c.db.tx(() => ops.update(ops.get("older")!, { state: "succeeded" }));
  expect(nextOpAttemptAt(c)).toBe(0);
  expect(claimReadyOps(c, 10, 25).map(o => o.id)).toEqual(["newer"]);
});

it("claims in sequence with exact attempts and limits, retaining running blockers in the same pass", () => {
  const c = ctx(), ops = c.db.table("ops"), targets = c.db.table("op_targets");
  c.db.tx(() => {
    ops.insert(op("successor", 2, { attempts: 4 }));
    ops.insert(op("independent", 3, { next_attempt_at: 5, attempts: 6 }));
    ops.insert(op("predecessor", 1, { next_attempt_at: 8, attempts: 2 }));
    ops.insert(op("future", 4, { next_attempt_at: 11 }));
    for (const id of ["predecessor", "successor"]) targets.insert({ op_id: id, message_id: 1, grp: "location" });
  });
  expect(nextOpAttemptAt(c)).toBe(5);
  expect(claimReadyOps(c, 10, 0)).toEqual([]);
  expect(claimReadyOps(c, 10, 2).map(o => [o.id, o.attempts])).toEqual([["predecessor", 3], ["independent", 7]]);
  expect(ops.get("successor")).toMatchObject({ state: "queued", attempts: 4 });
  expect(ops.get("future")).toMatchObject({ state: "queued", attempts: 0 });
  expect(nextOpAttemptAt(c)).toBe(11);
});

it.each([
  ["gmail", [1], [], false, false, false],
  ["gmail", [], [1], false, true, false],
  ["gmail", [], [], true, false, false],
  ["gmail", [], [1], true, false, true],
  ["imap", [1], [], true, true, true],
] as const)("candidate admission %s blocked=%j verified=%j unverified=%s all=%s admitted=%s", (kind, blockedAccountIds, verifiedAccountIds, blockUnverifiedGoogle, blockAllGoogle, admitted) => {
  const c = ctx(), targets = c.db.table("op_targets");
  c.db.tx(() => {
    c.db.table("accounts").update(c.db.table("accounts").get(1)!, { kind });
    c.db.table("ops").insert(op("candidate", 1));
    targets.insert({ op_id: "candidate", message_id: 1, grp: "location" });
  });
  const admission = { blockedAccountIds, verifiedAccountIds, blockUnverifiedGoogle, blockAllGoogle };
  const reads = vi.spyOn(targets.rows, "get");
  let next: number | null, claimed: string[], count: number;
  try {
    next = nextOpAttemptAt(c, admission);
    claimed = claimReadyOps(c, 10, 25, admission).map(o => o.id);
    count = reads.mock.calls.length;
  } finally { reads.mockRestore(); }
  expect(next).toBe(admitted ? 0 : null);
  expect(claimed).toEqual(admitted ? ["candidate"] : []);
  expect(count).toBe(admitted ? 4 : 0);
});

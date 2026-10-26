/**
 * Plan 20 (Codex review, round 2): the ops queue's scheduling queries run on every worker pass and
 * every sync, synchronously on the web's worker. They must not scale with the size of a bulk move
 * or with the account's history. Rows are written straight into the in-memory tables (fast fixtures).
 */
import { AWAITING_NETWORK } from "@terno/store";
import { describe, expect, it } from "vitest";
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

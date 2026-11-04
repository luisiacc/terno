import { expect, it } from "vitest";
import { FOLDER_OPS_PENDING } from "./folders";
import { Db } from "./sqlite";
import { sqliteDriver } from "./index";
import { migrate } from "./migrations";

/** Plan 127: membership asks this on every recompute: it mustn't walk a backlog of other ops. */
it("the probe for a pending folder move reads the partial index, however many other ops wait", () => {
  const db = new Db(sqliteDriver(), ":memory:");
  try {
    migrate(db);
    db.run("INSERT INTO accounts (id,kind,email,display_name,created_at) VALUES (1,'gmail','a@test.com','A',0)");
    db.tx(() => {
      for (let i = 0; i < 5000; i++) db.run("INSERT INTO ops (id,seq,account_id,kind,target_json,payload_json,state,created_at,updated_at,next_attempt_at) VALUES (?,?,1,'star','{}','{}','queued',0,0,0)", `op${i}`, i);
    });
    db.exec("ANALYZE");
    const probe = FOLDER_OPS_PENDING;
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${probe}`).map((r) => r.detail).join(" ");
    expect(plan).toContain("ops_folder_moves");
    expect(db.get(probe)).toBeUndefined();
    db.run("INSERT INTO ops (id,seq,account_id,kind,target_json,payload_json,state,created_at,updated_at,next_attempt_at) VALUES ('m',9999,1,'moveToFolder','{}','{}','queued',0,0,0)");
    expect(db.get(probe)).toBeDefined();
    db.run("UPDATE ops SET state = 'failed' WHERE id = 'm'");
    expect(db.get(probe)).toBeUndefined();
  } finally {
    db.close();
  }
});

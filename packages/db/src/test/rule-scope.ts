import type { Db } from "../sqlite";

export function populateRuleScope(db: Db, accountId: number): void {
  db.tx(() => {
    db.run(`WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM ids WHERE id < 50000)
      INSERT INTO threads(id, account_id, message_count) SELECT id, ?, 1 FROM ids`, accountId);
    db.run(`INSERT INTO messages(id, account_id, thread_id, date, body_state)
      SELECT id, account_id, id, 1700000000000, 'full' FROM threads`);
    db.run("INSERT INTO message_bodies(message_id, body_text) SELECT id, 'shared budget phrase' FROM messages");
  });
}

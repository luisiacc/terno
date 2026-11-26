import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { activeFollowups, makeFollowupsDue, nextFollowupDue } from "./followups";
import { openDatabase } from "./index";
import type { Db } from "./sqlite";

/**
 * Plan 280 (the Astra review): a kind the app doesn't know (a later version's, after going back) is never shown, never made
 * due, and never wakes the timer: it would ask for a look at once, forever. Written raw: the store only writes kinds it knows.
 */
const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("an unknown kind, overdue, is neither shown, made due, nor the next moment", () => {
  const dir = mkdtempSync(join(tmpdir(), "owed-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "o.db"));
  dbs.push(db);
  db.run("INSERT INTO accounts (id, kind, email, created_at) VALUES (1, 'gmail', 'me@x.mx', 0)");
  db.run("INSERT INTO threads (id, account_id, subject, last_date) VALUES (1, 1, 's', 1)");
  db.run("INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, created_at) VALUES (1, 1, 0, 'chore', 'x', 1, 5, 0, 'open', 1)");
  expect(activeFollowups(db)).toEqual([]);
  expect(nextFollowupDue(db)).toBeNull();
  expect(makeFollowupsDue(db, 10)).toEqual([]);
  db.run("INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, created_at) VALUES (1, 2, 0, 'theirs', 'y', 1, 7, 0, 'open', 1)");
  expect(nextFollowupDue(db)).toBe(7);
});

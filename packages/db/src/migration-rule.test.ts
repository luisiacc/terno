/**
 * Plan 255: there is no backup before a migration. A step only adds
 * (tables, columns, indexes); one that deletes or rewrites rows it finds
 * says why in `rewrites`, so such steps stay rare and are looked at.
 */
import { describe, expect, it } from "vitest";
import { MIGRATIONS, REWRITE_RULE_FROM, rowRewrites } from "./migrations";

describe("migrations that touch rows (plan 255)", () => {
  it("every step from the rule on that deletes or rewrites rows says why", () => {
    const unsaid = MIGRATIONS.filter((m) => m.version >= REWRITE_RULE_FROM && !m.rewrites && rowRewrites(m.sql).length > 0).map((m) => `v${m.version}: ${rowRewrites(m.sql)[0]}`);
    expect(unsaid).toEqual([]);
  });

  it("finds exactly the steps before it that did (the reader against history)", () => {
    // table rebuilds (4, 8, 57, 75), dropped columns or tables (6, 19), settings and flags rewritten in place
    expect(MIGRATIONS.filter((m) => m.version < REWRITE_RULE_FROM && rowRewrites(m.sql).length > 0).map((m) => m.version)).toEqual([3, 4, 6, 8, 9, 14, 19, 28, 35, 37, 57, 75]);
  });

  it.each([
    ["UPDATE threads SET x = 1", 1],
    ["update  threads\n set x = 1", 1],
    ["DELETE FROM drafts WHERE id = 1", 1],
    ["DROP TABLE old_thing", 1],
    ["ALTER TABLE t DROP COLUMN c", 1],
    ["INSERT OR REPLACE INTO settings (key, value_json) SELECT 'a', '{}'", 1],
    ["REPLACE INTO a SELECT * FROM b", 1],
    ["INSERT INTO a (x) SELECT x FROM b", 0],
    ["INSERT OR IGNORE INTO a (x) SELECT x FROM b", 0],
    ["CREATE TABLE t (x INTEGER); ALTER TABLE t ADD COLUMN y TEXT; CREATE INDEX t_x ON t(x)", 0],
    ["INSERT INTO settings (key, value_json) VALUES ('a', '{}')", 0],
    ["ALTER TABLE t ADD COLUMN note TEXT DEFAULT 'DELETE FROM x; UPDATE y SET z'", 0],
    ["-- UPDATE t SET x = 1\nCREATE TABLE u (x)", 0],
    ["CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN UPDATE u SET n = n + 1; DELETE FROM v WHERE id = new.id; END;", 0],
    // a CASE … END inside the body doesn't end the trigger, and what follows it is read (Codex plan review #6)
    ["CREATE TRIGGER t_au AFTER UPDATE ON t WHEN CASE WHEN new.x THEN 1 END BEGIN UPDATE u SET n = CASE WHEN new.x THEN 1 ELSE 0 END; DELETE FROM v; END; CREATE TABLE w (x)", 0],
    ["CREATE TRIGGER t_ad AFTER DELETE ON t BEGIN UPDATE u SET n = CASE old.x WHEN 1 THEN 0 END; END; UPDATE t SET x = 0", 1],
    ["INSERT OR REPLACE INTO settings (key, value_json) VALUES ('a', '{}')", 1],
    ["DROP INDEX t_x; ALTER TABLE t RENAME TO u", 0],
  ] as const)("%s", (sql, n) => {
    expect(rowRewrites(sql)).toHaveLength(n);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sqliteDriver } from "./index";
import { Db } from "./sqlite";
import { MIGRATIONS, migrate } from "./migrations";
import { saveDraft } from "./repos";

it("v20 preserves legacy updates but fences erased pre-migration identities, and allocates durably after delete", () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-draft-identity-"));
  const db = new Db(sqliteDriver(), join(dir, "legacy.db"));
  try {
    for (const migration of MIGRATIONS.filter((m) => m.version <= 19)) db.exec(migration.sql);
    db.exec("PRAGMA user_version = 19");
    db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'imap', 'synthetic@example.test', '', '{}', 0)");
    db.run("INSERT INTO drafts (id, account_id, to_json, cc_json, subject, body_text, updated_at) VALUES (1, 1, '[]', '[]', 'legacy', 'exact', 0)");
    db.run("INSERT INTO drafts (id, account_id, to_json, cc_json, subject, body_text, updated_at) VALUES (2, 1, '[]', '[]', 'erased', 'old', 0)");
    db.run("DELETE FROM drafts WHERE id = 2");
    migrate(db);
    const input = { accountId: 1, to: [], cc: [], subject: "keep", bodyText: "exact" };
    expect(db.tx(() => saveDraft(db, { ...input, id: 1, baseRevision: 1 }, 1))).toMatchObject({ id: 1, generation: "", revision: 2 });
    const copy = db.tx(() => saveDraft(db, input, 2))!;
    expect(copy.id).toBe(2); // An erased legacy high-water mark cannot be reconstructed.
    expect(db.tx(() => saveDraft(db, { ...input, id: 2, baseRevision: 1, bodyText: "late legacy" }, 3))).toBeNull();
    expect(db.get<{ body_text: string }>("SELECT body_text FROM drafts WHERE id = 2")!.body_text).toBe("exact");
    db.run("DELETE FROM drafts WHERE id = 2");
    expect(db.tx(() => saveDraft(db, input, 4))!.id).toBeGreaterThan(copy.id);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

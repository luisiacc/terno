/** Plan 68 (Codex R20): an ID-less message's twins, by exactly its envelope (`messages_twins`), at 50,000 in a cohort. */
import { measureTwins, twinSubject } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER } from "./test/perf";

it("twins by envelope at 50,000 in a cohort, one store holding all of them: lookups and pages, ID-less and with a reused Message-ID", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-twins-"));
  const db = openDatabase(join(dir, "t.db"));
  const store = new SqlMailStore(db);
  try {
    await measureTwins(store, (accountId, c) => {
      const prepared = c.subject === null ? `'Edición ' || (x - 1)` : `'${twinSubject(c, 0)}'`;
      db.tx(() => {
        const thread = db.get<{ id: number }>("INSERT INTO threads (account_id, provider_thread_id) VALUES (?, ?) RETURNING id", accountId, c.providerPrefix)!.id;
        db.run(
          `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ?)
           INSERT INTO messages (account_id, thread_id, provider_msg_id, rfc_message_id, from_email, subject, date, size)
           SELECT ?, ?, ? || x, ?, ?, ${prepared}, ?, ? FROM n`,
          c.n, accountId, thread, c.providerPrefix, c.rfcMessageId, c.fromEmail, c.date, c.size,
        );
      });
    }, { budget: BUDGET_MULTIPLIER, log: (line) => console.log(line) });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

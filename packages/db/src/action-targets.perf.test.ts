import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNCHANGED_NAMED } from "@terno/store";
import { measureLongConversationsAct } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER } from "./test/perf";
import { copyMigrated } from "./test/helpers";

// plan 229: a Gmail action names each conversation's newest messages too: twenty long ones in one go stay within a turn
it("SQLite: Mark as read on 20 Gmail conversations of 100 messages, one unread each, within the event loop's budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-act-perf-"));
  const store = new SqlMailStore(openDatabase(copyMigrated(join(dir, "s.db"))));
  try {
    const { ms, named } = await measureLongConversationsAct(store);
    expect(named).toBe(20 * (1 + UNCHANGED_NAMED));
    expect(ms, "one act (ms)").toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

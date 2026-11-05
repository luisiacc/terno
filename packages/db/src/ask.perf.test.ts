import { join } from "node:path";
import { measureAsk } from "@terno/store/conformance";
import { afterAll, beforeAll, it } from "vitest";
import { nodePlatform, openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER } from "./test/perf";
import { copyMailbox, LARGE_MAILBOX, MAILBOX_NOW, scratchDir } from "./test/perf-mailbox";

/**
 * Plan 141 at 57k threads on the path a question takes: SQLite with the instant index current. Three queries and their
 * passages within 50 ms, wherever the word is. `workloads.perf` holds passages to the same while the index catches up.
 */
const scratch = scratchDir("ask");
let store: SqlMailStore;
let accountId: number;

beforeAll(async () => {
  const path = join(scratch.dir, "ask.db");
  const seeded = copyMailbox(LARGE_MAILBOX, path);
  accountId = seeded.accountIds[0]!;
  store = new SqlMailStore(openDatabase(path), { instantSearch: true, platform: nodePlatform });
  await store.instant!.settled(600_000);
}, 1_200_000);

afterAll(async () => {
  await store?.close();
  scratch.done();
});

it("three queries and their passages hold at 50 ms", () => measureAsk({ store, accountId, now: MAILBOX_NOW, budget: BUDGET_MULTIPLIER, log: (line) => process.stderr.write(`[ask] ${line}\n`) }, { totalMs: 50, passagesMs: 50, stallMs: null, settled: () => store.instant!.settled(600_000) }), 900_000);

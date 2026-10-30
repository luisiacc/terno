import { it } from "vitest";
import { checkCountCoverage } from "../../store/src/conformance/count-coverage.fixture";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
it("counts saved unread conversations within local coverage", async () => {
  const store = new SqlMailStore(openDatabase(":memory:"));
  try { await checkCountCoverage(store); } finally { await store.close(); }
});

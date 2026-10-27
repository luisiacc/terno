import { defineVisibleStorePerf } from "../../mail/src/test/visible-store-perf";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";

defineVisibleStorePerf("SQL", async () => new SqlMailStore(openDatabase(":memory:"), { instantSearch: false }));

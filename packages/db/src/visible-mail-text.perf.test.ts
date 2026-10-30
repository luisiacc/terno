import { defineVisibleStorePerf, defineVisibleUnknownPerf, defineVisibleInvalidPerf } from "../../mail/src/test/visible-store-perf";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";

defineVisibleStorePerf("SQL", async () => new SqlMailStore(openDatabase(":memory:"), { instantSearch: false }));

defineVisibleUnknownPerf("SQL", async () => new SqlMailStore(openDatabase(":memory:"), { instantSearch: false }));
defineVisibleInvalidPerf("SQL", async () => new SqlMailStore(openDatabase(":memory:"), { instantSearch: false }));
